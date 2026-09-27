#!/usr/bin/env python3
"""Device plumbing for kpod end-to-end runs.

LIPC `cmd` changes daemon state. `/var/local/mesquite/kpod/status.json` is the
observable result. `/usr/sbin/screenshot` is the framebuffer. Gestures go
through `tools/kindle_xinput.c` (XTEST), because `cmd` never reaches the WAF.

    from kindle_lib import Device

    device = Device()
    device.gesture("tap 40 400\\nsleep 400")
    assert "playing" in device.status()
"""
import json
import os
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KINDLE_HOST = os.environ.get("KINDLE_E2E_HOST", "kindle")
STATUS_PATH = "/var/local/mesquite/kpod/status.json"
LIPC_SERVICE = "dev.qingshan.kpodd"
XINPUT_REMOTE = "/tmp/kindle_xinput"
XINPUT_BINARY = ROOT / "target/kindlehf-x11/bin/kindle_xinput"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
STATUS_MARKER = b"KPOD_STATUS_END"

SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15",
               "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"]


def run(args, **kwargs):
    kwargs.setdefault("text", True)
    kwargs.setdefault("check", True)
    kwargs.setdefault("timeout", 60)
    kwargs.setdefault("stdout", subprocess.PIPE)
    return subprocess.run(args, **kwargs)


def ssh(host, command, **kwargs):
    return run(["ssh"] + SSH_OPTIONS + [host, command], **kwargs)


class Device:
    """The Kindle under test: daemon state, framebuffer captures, and gestures."""

    def __init__(self, host=KINDLE_HOST, status_path=STATUS_PATH):
        self.host = host
        self.status_path = status_path
        self._input_ready = False

    def ssh(self, command, **kwargs):
        return ssh(self.host, command, **kwargs)

    def status(self):
        return json.loads(self.ssh("cat {}".format(self.status_path)).stdout)

    def cmd(self, op):
        """One-way JSON op through the daemon's LIPC `cmd` property."""
        payload = json.dumps(op, separators=(",", ":")).replace("'", "'\\''")
        self.ssh("lipc-set-prop {} cmd '{}'".format(LIPC_SERVICE, payload))

    def prevent_sleep(self, on=True):
        """Keep the Kindle awake for the duration of a run (best effort)."""
        self.ssh("lipc-set-prop com.lab126.powerd preventScreenSaver {}".format(1 if on else 0),
                 check=False)

    def screenshot(self):
        """Raw device framebuffer as PNG bytes."""
        out = self.ssh('f=/tmp/kpod-shot.png; /usr/sbin/screenshot -f "$f"; cat "$f"',
                       text=False, stdout=subprocess.PIPE).stdout
        if not out.startswith(PNG_MAGIC):
            raise RuntimeError("Kindle framebuffer capture failed")
        return out

    def snap(self, path, settle=2.0):
        time.sleep(settle)
        image = self.screenshot()
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image)
        return path

    def ensure_input_tool(self):
        """Install tools/kindle_xinput on the device when the binary differs."""
        if self._input_ready:
            return
        if not XINPUT_BINARY.exists():
            run([str(ROOT / "tools/build-kindle-xinput.sh")])
        remote = ssh(self.host, "sha1sum {} 2>/dev/null | cut -d' ' -f1".format(XINPUT_REMOTE),
                     check=False).stdout.strip()
        local = run(["sha1sum", str(XINPUT_BINARY)]).stdout.split()[0]
        if remote != local:
            run(["scp", "-q", str(XINPUT_BINARY), "{}:{}".format(self.host, XINPUT_REMOTE)])
            self.ssh("chmod +x {}".format(XINPUT_REMOTE))
        self._input_ready = True

    def gesture(self, commands):
        """Run injected touch or key commands, raising if any failed."""
        self.ensure_input_tool()
        out = self.ssh("DISPLAY=:0 {} >/tmp/kindle_xinput.log 2>&1 <<'KPOD_INPUT'\n"
                       "{}\nKPOD_INPUT\necho input_status=$?".format(
                           XINPUT_REMOTE, commands.rstrip()),
                       check=False).stdout
        if "input_status=0" not in out:
            log = self.ssh("cat /tmp/kindle_xinput.log", check=False).stdout
            raise RuntimeError("gesture injection failed:\n{}\n{}".format(out, log))

    def step(self, gesture, settle=2.0, status=True):
        """Run gestures, wait, then capture. Returns (status_or_None, png_bytes)."""
        self.ensure_input_tool()
        script = ["DISPLAY=:0 {} >/tmp/kindle_xinput.log 2>&1 <<'KPOD_INPUT'".format(XINPUT_REMOTE),
                  gesture.rstrip("\n"), "KPOD_INPUT", "echo input_status=$?",
                  "sleep {}".format(int(round(settle)))]
        if status:
            script.append("cat {}".format(self.status_path))
        script += ["echo {}".format(STATUS_MARKER.decode()), "f=/tmp/kpod-shot.png",
                   '/usr/sbin/screenshot -f "$f"', 'cat "$f"']
        out = self.ssh("\n".join(script), text=False, stdout=subprocess.PIPE,
                       timeout=int(settle) + 60).stdout
        head, _, image = out.partition(PNG_MAGIC)
        if not image:
            raise RuntimeError("no framebuffer image in step output")
        image = PNG_MAGIC + image
        text = head.split(STATUS_MARKER)[0].decode(errors="replace")
        state = None
        for line in text.splitlines():
            if line.startswith("input_status=") and line != "input_status=0":
                raise RuntimeError("gesture injection failed: {}\n{}".format(line, text))
            if line.startswith("{"):
                state = json.loads(line)
        if status and state is None:
            raise RuntimeError("no status in step output: {}".format(text))
        return state, image

    def wait(self, label, predicate, timeout=30):
        """Poll status until predicate holds."""
        deadline = time.monotonic() + timeout
        state = self.status()
        while time.monotonic() < deadline:
            if predicate(state):
                return state
            time.sleep(0.4)
            state = self.status()
        raise TimeoutError("timed out waiting for {}: {}".format(label, state))


def launch_waf(host=KINDLE_HOST):
    """Open the kpod WAF, detached so it survives the ssh session."""
    ssh(host, "setsid /var/local/kmc/bin/kpm launch kpod "
              ">/tmp/kpod-demo-launch.log 2>&1 </dev/null &", check=False)
