#!/usr/bin/env python3
"""The single kpod end-to-end entry point.

Scenarios talk to ``page`` instead of assembling LIPC, gestures, and
screenshots themselves:

    with KpodE2E() as test:
        test.launch()
        test.page.wait("status", lambda state: "playing" in state)
        test.page.tap(40, 400)
        test.page.expect(lambda state: state.get("compact") is True)

``just e2e`` runs the host WAF suite and the transport-geometry check. No
Kindle is required. ``just demo`` adds the device tour and renders its video.
"""
import argparse
import importlib
import json
import subprocess
import sys
import time
from pathlib import Path

sys.modules.setdefault("kpod_e2e", sys.modules[__name__])

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))


class Expect:
    """Assertions with retrying failure messages."""

    def __init__(self, page):
        self.page = page

    def to_have(self, predicate, message="state did not match", timeout=15):
        return self.page.expect(predicate, message, timeout)

    def text(self, value, timeout=15):
        return self.to_have(lambda state: value in self.page.text(state),
                            "status never contained {!r}".format(value), timeout)


class Artifacts:
    """Screenshots plus a storyboard suitable for GIF/MP4 rendering."""

    def __init__(self, directory=None):
        self.directory = Path(directory or ROOT / "target/e2e/artifacts")
        self.frames = []

    def screenshot(self, label, png, caption=None, dwell_ms=1000):
        self.directory.mkdir(parents=True, exist_ok=True)
        filename = "{:03d}-{}.png".format(len(self.frames) + 1, label)
        path = self.directory / filename
        path.write_bytes(png)
        self.frames.append({"label": label, "file": filename,
                            "caption": caption or label, "dwell_ms": dwell_ms})
        return path

    def animation(self, path=None):
        path = Path(path or self.directory / "animation.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"app": "kpod", "frames": self.frames}, indent=2) + "\n")
        return path

    def video(self, output=None):
        if not self.frames:
            raise RuntimeError("cannot render a video without screenshots")
        output = Path(output or self.directory / "kpod-e2e.mp4")
        manifest = self.directory / "frames.txt"
        with manifest.open("w") as handle:
            handle.write("ffconcat version 1.0\n")
            for frame in self.frames:
                handle.write("file '{}'\n".format((self.directory / frame["file"]).as_posix()))
                handle.write("duration {:.3f}\n".format(frame["dwell_ms"] / 1000))
            handle.write("file '{}'\n".format((self.directory / self.frames[-1]["file"]).as_posix()))
        try:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                            "-i", str(manifest), "-fps_mode", "vfr", "-pix_fmt", "yuv420p",
                            str(output)], check=True)
        finally:
            manifest.unlink(missing_ok=True)
        return output


class KindlePage:
    """Page API for the physical WAF.

    ``tap`` and ``press`` are XTEST input. ``command`` is for a daemon op whose
    on-screen control is not part of this step. Screenshots are the framebuffer.
    """

    def __init__(self, device, artifacts=None):
        self.device = device
        self.artifacts = artifacts or Artifacts()
        self.expectation = Expect(self)

    def command(self, op):
        self.device.cmd(op)

    def prevent_sleep(self, on=True):
        self.device.prevent_sleep(on)

    def gesture(self, commands):
        return self.device.gesture(commands)

    def step(self, gesture, settle=2.0):
        return self.device.step(gesture, settle=settle)

    def snap(self, path, settle=2.0):
        return self.device.snap(path, settle=settle)

    def wait(self, label, predicate, timeout=30):
        return self.device.wait(label, predicate, timeout=timeout)

    def tap(self, x, y, pause=450):
        self.device.gesture("tap {} {}\nsleep {}".format(int(x), int(y), pause))

    def press(self, key, pause=300):
        self.device.gesture("key {}\nsleep {}".format(key, pause))

    def type(self, text, pause=150):
        self.device.gesture("text {}\nsleep {}".format(text, pause))

    def snapshot(self):
        return self.device.status()

    def text(self, state):
        parts = [state.get("current") or "", state.get("lastError") or "", state.get("phase") or ""]
        for item in state.get("playlist") or []:
            parts.append(item.get("title") or "")
        transcript = state.get("transcript") or {}
        parts.append(transcript.get("text") or "")
        return "\n".join(parts)

    def expect(self, predicate, message="state did not match", timeout=30):
        return self.device.wait(message, predicate, timeout=timeout)

    def screenshot(self, label, caption=None, settle=2.0):
        time.sleep(settle)
        return self.artifacts.screenshot(label, self.device.screenshot(), caption)

    def screenshot_file(self, path, settle=2.0):
        """Save a raw framebuffer at a storyboard path."""
        time.sleep(settle)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(self.device.screenshot())
        return path


class KpodE2E:
    """A Kindle session: sleep inhibition, and the WAF launched on enter."""

    def __init__(self):
        from kindle_lib import Device
        self.device = Device()
        self.page = KindlePage(self.device)

    def launch(self):
        from kindle_lib import launch_waf
        launch_waf(self.device.host)

    def __enter__(self):
        self.page.prevent_sleep(True)
        return self

    def __exit__(self, *unused):
        self.page.prevent_sleep(False)
        return False


def scenario(name, fn):
    print("\n== {} ==".format(name), flush=True)
    fn()


def host_suite():
    scenario("WAF commands and rendering", lambda: subprocess.run(
        ["node", str(HERE / "waf_e2e.js")], cwd=ROOT, check=True))
    scenario("transport geometry", importlib.import_module("geometry").self_check)


def demo_suite():
    demo = importlib.import_module("kindle_demo")
    builder = importlib.import_module("demo_build")
    saved = sys.argv[:]
    try:
        sys.argv = ["kindle_demo.py"]
        scenario("Kindle player tour", demo.main)
        sys.argv = ["demo_build.py"]
        scenario("demo video", builder.main)
    finally:
        sys.argv = saved


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--record", action="store_true",
                        help="record the Kindle tour and encode GIF/MP4")
    args = parser.parse_args()
    host_suite()
    if args.record:
        demo_suite()
    print("\nkpod E2E: all selected scenarios passed", flush=True)


if __name__ == "__main__":
    main()
