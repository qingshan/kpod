#!/usr/bin/env python3
"""Capture the kpod demo storyboard from a real Kindle, stop by stop.

Each content frame is a framebuffer PNG. Transport taps are measured from the
opening frame (see geometry.py). The tour opens Up next, Explore, and Compact,
then puts the player back. It does not sync, seek, start or stop playback,
toggle Bluetooth, search, add a show, or edit the queue.

Output:
    target/demo/frames/NN-label.png
    target/demo/frames.json

Usage:
    python3 tests/e2e/kindle_demo.py
    python3 tests/e2e/kindle_demo.py --only 03
    python3 tests/e2e/kindle_demo.py --list
"""
import argparse
import io
import json
import sys
import time
from pathlib import Path

from geometry import find_transport, window_rule_present
from kindle_lib import ROOT
from kpod_e2e import KpodE2E

FRAMES = ROOT / "target/demo/frames"
STORYBOARD = ROOT / "target/demo/frames.json"
SETTLE = 2.0

STORY = [
    {"label": "01-open", "kind": "card", "dwell": 2800,
     "subtitle": "Podcasts on a Kindle",
     "lines": ["queue, explore, and a transcript", "playback stays on the device"],
     "footer": "Kindle Oasis",
     "headline": "kpod",
     "detail": "A podcast player for a jailbroken Kindle."},
    {"label": "02-player", "caption": "Now playing", "dwell": 3200,
     "headline": "Now playing",
     "detail": "The daemon decodes the episode. The page is the remote."},
    {"label": "03-up-next", "caption": "Up next", "dwell": 3200, "panel": "upnext",
     "headline": "Up next",
     "detail": "The play queue, without starting a download."},
    {"label": "04-explore", "caption": "Explore", "dwell": 3400, "panel": "explore",
     "headline": "Explore",
     "detail": "Episodes already in the catalog. Search and Sync stay untouched."},
    {"label": "05-compact", "caption": "Compact", "dwell": 2800, "panel": "compact",
     "headline": "Compact",
     "detail": "The title and progress row fold away, then the previous layout returns."},
    {"label": "06-transcript", "caption": "Transcript", "dwell": 3200,
     "headline": "Transcript",
     "detail": "Sentence cues follow the episode. The highlight is an underline."},
    {"label": "07-end", "kind": "card", "dwell": 2800,
     "subtitle": "kpod",
     "lines": ["frames captured from a Kindle Oasis"],
     "footer": "the queue on the device was left as it was found",
     "headline": "kpod",
     "detail": "Driven against the installed player. The queue was not edited."},
]


def icon_visible(width, pixels, point):
    """True when a transport button has drawn its icon, not only its border."""
    x, y = point
    dark = 0
    for dy in range(-18, 19):
        row = (y + dy) * width
        for dx in range(-18, 19):
            if pixels[row + x + dx] < 60:
                dark += 1
    return dark >= 12


def load_gray(png):
    try:
        from PIL import Image
    except ImportError:
        sys.exit("error: Pillow is required to read Kindle captures (pip install pillow)")
    image = Image.open(io.BytesIO(png)).convert("L")
    return image.size[0], image.size[1], list(image.getdata())


def fingerprint(state):
    """Daemon fields this tour must not change."""
    explore = state.get("explore") or {}
    library = state.get("library") or {}
    return {
        "playing": state.get("playing"),
        "currentId": state.get("currentId"),
        "playlist": [item.get("id") for item in state.get("playlist") or []],
        "query": explore.get("query"),
        "feed": explore.get("feed"),
        "offset": explore.get("offset"),
        "library": library.get("query"),
    }


class Capture:
    def __init__(self, page, only=None, start_from=None):
        self.page = page
        self.frames = []
        self.only = only.split(",") if only else None
        self.start_from = start_from
        self.skipping = bool(start_from)
        self.buttons = None
        self.baseline = None
        self.compact = None

    def selected(self, label):
        if self.only:
            return any(label.startswith(item.strip()) for item in self.only)
        if self.skipping:
            if label.startswith(self.start_from):
                self.skipping = False
            else:
                return False
        return True

    def write(self):
        STORYBOARD.parent.mkdir(parents=True, exist_ok=True)
        note = ("Opens Up next, Explore, and Compact on the installed player, "
                "then restores Compact. Does not sync, play, seek, or edit the queue.")
        STORYBOARD.write_text(json.dumps(
            {"app": "kpod", "frames": self.frames, "note": note}, indent=2) + "\n")

    def add(self, stop, kind="screen"):
        entry = {key: stop[key] for key in ("label", "caption", "subtitle", "lines",
                                            "footer", "headline", "detail") if key in stop}
        entry["kind"] = stop.get("kind", kind)
        entry["dwell_ms"] = stop.get("dwell", 3000)
        if entry["kind"] == "screen":
            entry["file"] = stop["label"] + ".png"
        self.frames.append(entry)
        self.write()

    def prepare(self):
        page = self.page
        page.wait("status", lambda state: isinstance(state.get("playlist"), list)
                  and "playing" in state, timeout=40)
        if page.snapshot().get("phase") == "syncing":
            raise AssertionError("kpod is syncing; record the tour after it is idle")
        deadline = time.monotonic() + 40
        image = page.device.screenshot()
        while time.monotonic() < deadline:
            width, height, pixels = load_gray(image)
            if window_rule_present(width, height, pixels):
                buttons = find_transport(width, height, pixels)
                if buttons and icon_visible(width, pixels, buttons["play"]):
                    time.sleep(SETTLE)
                    image = page.device.screenshot()
                    width, height, pixels = load_gray(image)
                    buttons = find_transport(width, height, pixels) or buttons
                    self.buttons = buttons
                    state = page.snapshot()
                    self.baseline = fingerprint(state)
                    self.compact = bool(state.get("compact"))
                    print("transport", {name: self.buttons[name] for name in self.buttons})
                    print("compact", self.compact, "bt", state.get("btConnected"), state.get("btName"))
                    return image
            time.sleep(1.5)
            image = page.device.screenshot()
        path = FRAMES / "calibration.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image)
        raise AssertionError("could not measure the transport row; saved {}".format(path))

    def accept(self, stop, png):
        path = FRAMES / (stop["label"] + ".png")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
        width, height, pixels = load_gray(png)
        if not window_rule_present(width, height, pixels):
            raise AssertionError("{}: kpod is not in front".format(stop["label"]))
        state = self.page.snapshot()
        if stop.get("panel") == "compact":
            if bool(state.get("compact")) == self.compact:
                raise AssertionError("{}: compact did not change".format(stop["label"]))
        elif fingerprint(state) != self.baseline:
            raise AssertionError("{}: daemon state changed".format(stop["label"]))
        print("{}: settled".format(stop["label"]))
        self.add(stop)

    def tap_until(self, name, predicate, tries=3):
        """Tap a measured transport button until daemon state catches up.

        A tap sent while the WAF is still inverting the previous control is
        dropped. Retrying the same point after a beat reaches the button.
        """
        last = None
        for _ in range(tries):
            self.page.tap(*self.buttons[name])
            try:
                return self.page.wait(name, predicate, timeout=6)
            except TimeoutError as error:
                last = error
                image = self.page.device.screenshot()
                width, height, pixels = load_gray(image)
                buttons = find_transport(width, height, pixels)
                if buttons:
                    self.buttons = buttons
        raise last

    def shot(self, stop):
        path = self.page.screenshot_file(FRAMES / (stop["label"] + ".png"), settle=SETTLE)
        self.accept(stop, path.read_bytes())

    def restore_compact(self):
        if self.compact is None:
            return
        state = self.page.snapshot()
        if bool(state.get("compact")) != self.compact:
            self.page.command({"op": "ui_set", "compact": self.compact})
            self.page.wait("compact restored",
                           lambda current: bool(current.get("compact")) == self.compact,
                           timeout=10)

    def run(self):
        page = self.page
        opening = self.prepare()
        try:
            for stop in STORY:
                if not self.selected(stop["label"]):
                    continue
                if stop.get("kind") == "card":
                    print("{}: card".format(stop["label"]))
                    self.add(stop, kind="card")
                    continue
                panel = stop.get("panel")
                if panel in ("upnext", "explore"):
                    page.tap(*self.buttons[panel])
                    self.shot(stop)
                    page.tap(*self.buttons[panel])
                    page.wait(panel + " closed", lambda state: fingerprint(state) == self.baseline)
                elif panel == "compact":
                    time.sleep(SETTLE)
                    self.tap_until("compact", lambda state: bool(state.get("compact")) != self.compact)
                    self.shot(stop)
                    width, height, pixels = load_gray(page.device.screenshot())
                    buttons = find_transport(width, height, pixels)
                    if not buttons:
                        raise AssertionError("compact layout could not be measured")
                    self.buttons = buttons
                    self.tap_until("compact", lambda state: bool(state.get("compact")) == self.compact)
                elif stop["label"] == "02-player":
                    self.accept(stop, opening)
                else:
                    self.shot(stop)
        finally:
            self.restore_compact()
        print("captured", len(self.frames), "frames in", FRAMES)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="comma-separated label prefixes to capture")
    parser.add_argument("--from", dest="start_from", help="resume at this label prefix")
    parser.add_argument("--list", action="store_true", help="print the storyboard and exit")
    args = parser.parse_args()
    if args.list:
        for index, stop in enumerate(STORY):
            print("{:02d}  {:16} {}".format(
                index + 1, stop["label"], stop.get("caption") or stop.get("subtitle", "")))
        return
    FRAMES.mkdir(parents=True, exist_ok=True)
    with KpodE2E() as test:
        test.launch()
        Capture(test.page, only=args.only, start_from=args.start_from).run()


if __name__ == "__main__":
    main()
