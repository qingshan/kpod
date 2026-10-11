#!/usr/bin/env python3
"""Capture the kpod demo storyboard from a real Kindle, stop by stop.

Each content frame is a framebuffer PNG. Transport taps are measured from the
opening frame (see geometry.py). The tour visits the transcript, queue,
position picker, Explore, page picker, feed filter, search, and Compact view.
It restores the search and layout state before leaving the player.

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
    {"label": "01-open", "kind": "card", "dwell": 2400,
     "subtitle": "Podcasts on a Kindle",
     "lines": ["Find episodes. Build a queue.", "Read along while listening."],
     "footer": "Kindle Oasis",
     "headline": "kpod",
     "detail": "A podcast player for a jailbroken Kindle."},
    {"label": "02-transcript", "caption": "Player and transcript", "dwell": 3000,
     "headline": "Listen and read",
     "detail": "Play, pause, skip 15 seconds, and connect a Bluetooth speaker. Sentence cues follow playback."},
    {"label": "03-up-next", "caption": "Up next", "dwell": 3000, "panel": "upnext",
     "headline": "Up next",
     "detail": "The queue shows download state, playback, position numbers, and removal controls."},
    {"label": "04-position", "caption": "Choose queue position", "dwell": 2500,
     "headline": "Arrange the queue",
     "detail": "Tap a position number to choose where an episode plays next."},
    {"label": "05-explore", "caption": "Explore episodes", "dwell": 3000, "panel": "explore",
     "headline": "Explore",
     "detail": "Browse up to 100 search results in pages. The plus button prepares an episode for the queue."},
    {"label": "06-pages", "caption": "Choose a results page", "dwell": 2300,
     "headline": "Jump to a page",
     "detail": "Page selection uses the loaded results, without another server query."},
    {"label": "07-feeds", "caption": "Filter by show", "dwell": 2700,
     "headline": "Subscribed shows",
     "detail": "Choose a feed to narrow Explore. The selected feed is highlighted."},
    {"label": "08-filtered", "caption": "Episodes from one show", "dwell": 2700,
     "headline": "One show at a time",
     "detail": "Public feeds and submitted YouTube or podcast episodes share the catalog."},
    {"label": "09-search", "caption": "Search episodes", "dwell": 2700,
     "headline": "Search the catalog",
     "detail": "Search matches episode titles and descriptions across subscribed feeds."},
    {"label": "10-compact", "caption": "Compact player", "dwell": 2700, "panel": "compact",
     "headline": "More reading room",
     "detail": "Compact view folds the player header away to make room for transcript text."},
    {"label": "11-queue", "kind": "card", "dwell": 2500,
     "subtitle": "A ready-to-play queue",
     "lines": ["Transcribe before adding", "Download queued audio automatically", "Group episodes by show in the feed"],
     "headline": "Prepared ahead",
     "detail": "The server prepares transcripts before publishing queue entries; the Kindle downloads their audio."},
    {"label": "12-ingest", "kind": "card", "dwell": 2500,
     "subtitle": "Make your own podcast feeds",
     "lines": ["Submit YouTube or podcast episode links", "Auto-sync feeds or use the CLI", "Search and queue on Kindle"],
     "headline": "One listening library",
     "detail": "The CLI manages feeds, submitted episodes, queue entries, and transcripts."},
    {"label": "13-end", "kind": "card", "dwell": 2200,
     "subtitle": "kpod",
     "lines": ["Captured on a Kindle Oasis"],
     "footer": "kpod.qingshan.dev",
     "headline": "kpod",
     "detail": "Playback, search, queue, and transcript on Kindle."},
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
    """Daemon fields this tour restores before leaving."""
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


def stable_fingerprint(state):
    """Playback and queue fields no tour stop may change."""
    value = fingerprint(state)
    for key in ("query", "feed", "offset"):
        value.pop(key)
    return value


def button_selected(width, pixels, point):
    """The left side of a selected transport button is filled black."""
    x, y = point
    return pixels[y * width + x - 44] < 80


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
        self.search_changed = False
        self.capture_current = True

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
        note = ("Captured from the installed Kindle player. The tour restores "
                "Explore and Compact settings; it does not play, seek, change "
                "Bluetooth, add episodes, or edit the queue.")
        STORYBOARD.write_text(json.dumps(
            {"app": "kpod", "frames": self.frames, "note": note}, indent=2) + "\n")

    def add(self, stop, kind="screen"):
        if not self.capture_current:
            return
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
                    if self.baseline["query"]:
                        raise AssertionError("clear the current Explore search before recording")
                    self.compact = bool(state.get("compact"))
                    for panel in ("upnext", "explore"):
                        if button_selected(width, pixels, buttons[panel]):
                            page.tap(*buttons[panel])
                            time.sleep(SETTLE)
                            image = page.device.screenshot()
                            width, height, pixels = load_gray(image)
                    current_id = state.get("currentId") or (state.get("playlist") or [{}])[0].get("id")
                    if current_id:
                        page.command({"op": "transcript_open", "id": current_id})
                        page.wait("transcript ready", lambda current:
                                  (current.get("transcript") or {}).get("id") == current_id and
                                  (current.get("transcript") or {}).get("state") == "ready", timeout=30)
                        time.sleep(3)
                        image = page.device.screenshot()
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
        if stable_fingerprint(state) != stable_fingerprint(self.page_baseline):
            raise AssertionError("{}: playback or queue changed".format(stop["label"]))
        if not stop.get("allow_explore") and fingerprint(state) != self.baseline:
            raise AssertionError("{}: Explore state changed".format(stop["label"]))
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

    def restore_explore(self):
        if not self.search_changed:
            return
        # Clear the WAF's local input through its on-screen keyboard too.
        self.page.tap(600, 655)
        time.sleep(0.6)
        for _ in range(4):
            self.page.tap(1135, 1485)
        self.page.tap(500, 350)
        self.page.command({"op": "explore_query", "query": self.baseline["query"] or "",
                           "feed": self.baseline["feed"] or "",
                           "offset": self.baseline["offset"] or 0})
        self.page.wait("Explore restored", lambda state: fingerprint(state) == self.baseline,
                       timeout=25)
        self.search_changed = False

    def tap_and_shot(self, x, y, stop):
        self.page.tap(x, y)
        self.shot(stop)

    def run(self):
        page = self.page
        opening = self.prepare()
        self.page_baseline = page.snapshot()
        try:
            for stop in STORY:
                self.capture_current = self.selected(stop["label"])
                if stop.get("kind") == "card":
                    if self.capture_current:
                        print("{}: card".format(stop["label"]))
                    self.add(stop, kind="card")
                    continue
                label = stop["label"]
                if label == "02-transcript":
                    self.accept(stop, opening)
                elif label == "03-up-next":
                    self.tap_and_shot(*self.buttons["upnext"], stop)
                elif label == "04-position":
                    # Position 2 is the first movable row on a typical queue.
                    self.tap_and_shot(1100, 745, stop)
                    page.tap(1158, 321)  # close the picker
                elif label == "05-explore":
                    self.search_changed = True
                    page.tap(*self.buttons["explore"])
                    self.shot(dict(stop, allow_explore=True))
                elif label == "06-pages":
                    self.tap_and_shot(1198, 655, dict(stop, allow_explore=True))
                    page.tap(1158, 321)
                elif label == "07-feeds":
                    self.tap_and_shot(144, 655, dict(stop, allow_explore=True))
                elif label == "08-filtered":
                    # Choose the first subscribed show below "All feeds".
                    self.search_changed = True
                    page.tap(180, 581)
                    page.wait("feed filter", lambda state: bool((state.get("explore") or {}).get("feed")),
                              timeout=25)
                    self.shot(dict(stop, allow_explore=True))
                elif label == "09-search":
                    page.tap(144, 655)
                    page.tap(180, 475)  # All feeds
                    page.wait("all feeds", lambda state: not (state.get("explore") or {}).get("feed"),
                              timeout=25)
                    page.tap(600, 655)
                    time.sleep(0.6)
                    for _ in range(4):
                        page.tap(1135, 1485)
                    # XTEST text keysyms are remapped by the Kindle keyboard.
                    # Tap its visible "i" key instead.
                    page.tap(930, 1255)
                    page.tap(800, 655)
                    page.command({"op": "explore_query", "query": "i", "feed": "", "offset": 0})
                    page.tap(500, 350)  # dismiss the keyboard
                    page.wait("episode search", lambda state: (state.get("explore") or {}).get("query") == "i",
                              timeout=25)
                    self.shot(dict(stop, allow_explore=True))
                elif label == "10-compact":
                    self.restore_explore()
                    page.tap(*self.buttons["explore"])
                    self.tap_until("compact", lambda state: bool(state.get("compact")) != self.compact)
                    self.shot(stop)
                    width, height, pixels = load_gray(page.device.screenshot())
                    buttons = find_transport(width, height, pixels)
                    if not buttons:
                        raise AssertionError("compact layout could not be measured")
                    self.buttons = buttons
                    self.tap_until("compact", lambda state: bool(state.get("compact")) == self.compact)
                else:
                    self.shot(stop)
        finally:
            self.restore_explore()
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
