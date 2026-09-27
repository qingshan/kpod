#!/usr/bin/env python3
"""Measure kpod transport taps from a Kindle framebuffer.

Coordinates are framebuffer pixels. The seven transport buttons are found from
their vertical borders. E-ink captures break horizontal rules into dither, so
a layout change fails the tour instead of tapping Play, Sync, or Bluetooth at
a stale point. The window rule under the app title was measured on Oasis
captures (a full-width light-gray line at y=213).
"""

BUTTONS = ("back15", "play", "fwd15", "bt", "upnext", "explore", "compact")
SCREEN = (1264, 1680)
WINDOW_RULE_Y = 213


def window_rule_present(width, height, pixels):
    """True when the kpod window chrome is in front of Home and Quick Settings."""
    if (width, height) != SCREEN:
        return False
    total = 0
    count = 0
    for x in range(40, width - 40):
        total += pixels[WINDOW_RULE_Y * width + x]
        count += 1
    mean = total / count
    return 180 <= mean <= 245


def find_transport(width, height, pixels, dark=80):
    """Return {button: (x, y)} or None when the row is not unambiguous.

    `pixels` is a row-major sequence of grayscale values, one per pixel.
    A connected speaker fills the Bluetooth button, so that control is a solid
    block with a light icon, not an empty border.
    """
    def at(x, y):
        return pixels[y * width + x]

    limit_y = min(height, 1200)
    spans = []
    for x in range(8, width - 8):
        y = 180
        while y < limit_y:
            if at(x, y) < dark:
                y0 = y
                while y < limit_y and at(x, y) < dark:
                    y += 1
                if 48 <= (y - y0) <= 110:
                    spans.append((x, y0, y - 1))
            else:
                y += 1

    segments = []
    for x, y0, y1 in spans:
        if segments:
            left, right, top, bottom = segments[-1]
            if x <= right + 3 and abs(y0 - top) <= 8 and abs(y1 - bottom) <= 8:
                segments[-1] = (left, x, min(top, y0), max(bottom, y1))
                continue
        segments.append((x, x, y0, y1))

    votes = {}
    for left, right, top, bottom in segments:
        if (right - left) <= 6 and 48 <= (bottom - top) <= 110:
            key = top // 4 * 4
            votes[key] = votes.get(key, 0) + 1
    if not votes:
        return None
    band = max(votes, key=votes.get)
    edges = []
    tops, bottoms = [], []
    for left, right, top, bottom in segments:
        if abs(top - band) > 12 or (right - left) > 6:
            continue
        if not 48 <= (bottom - top) <= 110:
            continue
        edges.append((left + right) // 2)
        tops.append(top)
        bottoms.append(bottom)
    if len(edges) < 4:
        return None
    edges.sort()
    top = sorted(tops)[len(tops) // 2]
    bottom = sorted(bottoms)[len(bottoms) // 2]
    row_h = bottom - top + 1

    boxes = []
    index = 0
    while index < len(edges) - 1:
        gap = edges[index + 1] - edges[index]
        if 60 <= gap <= 180:
            boxes.append((edges[index] + edges[index + 1]) // 2)
            index += 2
        else:
            index += 1

    filled = []
    x = 8
    limit_x = width - 8
    while x < limit_x:
        column = sum(1 for y in range(top, bottom + 1) if at(x, y) < dark)
        if column > 0.72 * row_h:
            x0 = x
            while x < limit_x:
                column = sum(1 for y in range(top, bottom + 1) if at(x, y) < dark)
                if column <= 0.72 * row_h:
                    break
                x += 1
            if x - x0 >= 16:
                filled.append([x0, x - 1])
        else:
            x += 1
    merged = []
    for run in filled:
        if merged and run[0] - merged[-1][1] <= 40 and run[1] - merged[-1][0] <= 180:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    for run in merged:
        if 40 <= run[1] - run[0] <= 180:
            center = (run[0] + run[1]) // 2
            if all(abs(center - box) > 30 for box in boxes):
                boxes.append(center)

    boxes.sort()
    found = []
    if len(boxes) >= 7:
        for start in range(len(boxes) - 6):
            window = boxes[start:start + 7]
            gaps = [window[i + 1] - window[i] for i in range(6)]
            if gaps.index(max(gaps)) != 3:
                continue
            if max(gaps) < min(gaps) + 20:
                continue
            found.append(window)
    if len(found) != 1:
        return None
    mid_y = (top + bottom) // 2
    return {name: (item, mid_y) for name, item in zip(BUTTONS, found[0])}


def _blank(width, height, value=255):
    return [value] * (width * height)


def _frame(width, height, x0, y0, x1, y1, pixels, fill=False):
    for x in range(x0, x1 + 1):
        pixels[y0 * width + x] = 0
        pixels[y1 * width + x] = 0
    for y in range(y0, y1 + 1):
        pixels[y * width + x0] = 0
        pixels[y * width + x1] = 0
        if fill:
            for x in range(x0 + 1, x1):
                pixels[y * width + x] = 0


def self_check():
    """The transport row is recognized; a shorter row and a full-width rule are not."""
    width, height = 1264, 1680
    pixels = _blank(width, height)
    for x in range(0, width):
        pixels[WINDOW_RULE_Y * width + x] = 215
        pixels[500 * width + x] = 0
    specs = [
        (40, 400, 110, 460, False),
        (130, 400, 200, 460, True),
        (220, 400, 290, 460, False),
        (310, 400, 380, 460, False),
        (620, 400, 690, 460, False),
        (710, 400, 780, 460, False),
        (800, 400, 870, 460, False),
    ]
    for x0, y0, x1, y1, fill in specs:
        _frame(width, height, x0, y0, x1, y1, pixels, fill=fill)
    found = find_transport(width, height, pixels)
    if found is None:
        raise AssertionError("synthetic transport row was not found")
    if list(found) != list(BUTTONS):
        raise AssertionError("button names drifted: {}".format(list(found)))
    play = found["play"]
    if not (130 <= play[0] <= 200 and 400 <= play[1] <= 460):
        raise AssertionError("play tap landed outside the filled button: {}".format(play))
    if found["bt"][0] >= found["upnext"][0]:
        raise AssertionError("left and right transport groups were merged")
    short = _blank(width, height)
    _frame(width, height, 40, 400, 110, 460, short)
    _frame(width, height, 130, 400, 200, 460, short)
    _frame(width, height, 220, 400, 290, 460, short)
    if find_transport(width, height, short) is not None:
        raise AssertionError("a partial button row was accepted")
    if not window_rule_present(width, height, pixels):
        raise AssertionError("window rule was not recognized")
    covered = _blank(width, height)
    if window_rule_present(width, height, covered):
        raise AssertionError("a blank framebuffer looked like the kpod window")
    print("transport geometry self-check ok")


if __name__ == "__main__":
    self_check()
