#!/usr/bin/env python3
"""Turn whisper.cpp WebVTT into one cue per sentence.

whisper-cli writes a cue every few words. Kindle highlights a whole cue,
so those breaks land mid-sentence. This joins the words back up and
splits again on sentence punctuation, keeping each word's time.
"""

import os
import re
import sys

# A period after one of these is not the end of a sentence.
ABBREV = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "eg", "ie",
    "inc", "ltd", "co", "corp", "gen", "col", "sgt", "capt", "gov", "sen", "rep",
    "rev", "hon", "esq", "approx", "dept", "univ", "assn", "bros", "ave", "blvd",
    "rd", "mt", "ft", "no", "fig", "vol", "pp", "al", "cf", "ed", "eds", "am", "pm",
}

# Flush a run-on if whisper never emits a period.
MAX_CHARS = 800
# A pause this long starts a new cue even without punctuation.
GAP_MS = 2500

_ASIDE = re.compile(r"[\[(].*[\])]")
_DECIMAL = re.compile(r"[$]?\d+\.\d+")
_INITIALS = re.compile(r"(?:[A-Za-z]\.)+[A-Za-z]?")


def parse_vtt(raw):
    raw = raw.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    cues = []
    start = None
    end = None
    buf = []

    def take():
        nonlocal start, end, buf
        if start is None:
            buf = []
            return
        text = " ".join(part.strip() for part in buf if part.strip())
        buf = []
        if text:
            cues.append((start, end if end is not None else start, text))
        start = None
        end = None

    for line in raw.split("\n"):
        line = line.strip()
        if "-->" in line:
            take()
            left, right = line.split("-->", 1)
            start = _ms(left)
            end = _ms(right.split()[0])
            continue
        if not line or line == "WEBVTT" or line.startswith(("NOTE", "STYLE", "Kind:", "Language:")):
            if not line:
                take()
            continue
        if start is not None and not line.isdigit():
            buf.append(line)
    take()
    return cues


def to_sentences(cues):
    words = []
    for start, end, text in cues:
        words.extend(_words(start, end, text))
    groups = []
    buf = []

    def flush():
        if not buf:
            return
        groups.append((buf[0][0], buf[-1][1], " ".join(item[2] for item in buf)))
        buf.clear()

    for index, word in enumerate(words):
        nxt = words[index + 1][2] if index + 1 < len(words) else None
        if _aside(word[2]):
            flush()
            buf.append(word)
            flush()
            continue
        if buf and word[0] - buf[-1][1] >= GAP_MS:
            flush()
        buf.append(word)
        length = sum(len(item[2]) + 1 for item in buf)
        if _sentence_end(word[2], nxt) or length >= MAX_CHARS:
            flush()
    flush()
    return groups


def render(cues):
    lines = ["WEBVTT", ""]
    for start, end, text in cues:
        if end < start:
            end = start
        lines.append("%s --> %s" % (_stamp(start), _stamp(end)))
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def rewrite(path):
    with open(path, encoding="utf-8") as handle:
        raw = handle.read()
    out = render(to_sentences(parse_vtt(raw)))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(out)
    os.replace(tmp, path)


def _words(start, end, text):
    parts = _join_asides(text.split())
    if not parts:
        return []
    weights = [max(1, len(part)) for part in parts]
    total = sum(weights)
    span = max(0, end - start)
    out = []
    covered = 0
    cursor = start
    for index, part in enumerate(parts):
        covered += weights[index]
        wend = end if index == len(parts) - 1 else start + span * covered // total
        out.append((cursor, wend, part))
        cursor = wend
    return out


def _join_asides(parts):
    merged = []
    acc = None
    for part in parts:
        if acc is not None:
            acc.append(part)
            if "]" in part or ")" in part:
                merged.append(" ".join(acc))
                acc = None
            continue
        if (part.startswith("[") and "]" not in part) or (part.startswith("(") and ")" not in part):
            acc = [part]
            continue
        merged.append(part)
    if acc:
        merged.append(" ".join(acc))
    return merged


def _aside(token):
    return _ASIDE.fullmatch(token) is not None


def _sentence_end(token, nxt):
    trimmed = token.rstrip("\"'\u201d\u2019)]")
    if not trimmed or trimmed[-1] not in ".!?\u2026":
        return False
    if trimmed.endswith("...") or trimmed.endswith("\u2026"):
        return _next_allows_break(nxt)
    if _DECIMAL.fullmatch(trimmed):
        return False
    body = trimmed[:-1]
    letters = re.sub(r"[^A-Za-z.]", "", body)
    if "." in letters and _INITIALS.fullmatch(letters):
        return False
    word = re.sub(r"[^A-Za-z]", "", body).lower()
    if word in ABBREV or len(word) == 1:
        return False
    return _next_allows_break(nxt)


def _next_allows_break(nxt):
    if nxt is None:
        return True
    head = nxt.lstrip("\"'\u201c\u2018([")
    return not head[:1].islower()


def _ms(raw):
    raw = raw.strip().replace(",", ".")
    parts = raw.split(":")
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours, minutes, seconds = "0", parts[0], parts[1]
    else:
        return 0
    whole, _, frac = seconds.partition(".")
    milli = (frac + "000")[:3]
    return (
        int(hours) * 3600000
        + int(minutes) * 60000
        + int(whole) * 1000
        + int(milli)
    )


def _stamp(ms):
    ms = max(0, int(ms))
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    seconds, milli = divmod(ms, 1000)
    return "%02d:%02d:%02d.%03d" % (hours, minutes, seconds, milli)


def _sample():
    return """WEBVTT

00:00:00.000 --> 00:00:04.840
[MUSIC PLAYING]

00:00:04.840 --> 00:00:07.960
Welcome to the Tech Brew Ride Home for Friday, September 25,

00:00:07.960 --> 00:00:08.640
2026.

00:00:08.640 --> 00:00:10.180
I'm Brian McCullough today.

00:00:10.180 --> 00:00:12.720
Microsoft finally unveiled its co-pilot super app

00:00:12.720 --> 00:00:15.840
with chat, coding, and agents all in one place.

00:00:22.520 --> 00:00:24.480
And a startup valued at $200 million

00:00:24.480 --> 00:00:27.840
last week is suddenly talking $10 billion.

00:00:29.460 --> 00:00:31.300
Here's what you miss today in the world of tech.
"""


def _test():
    cues = to_sentences(parse_vtt(_sample()))
    texts = [text for _, _, text in cues]
    assert texts[0] == "[MUSIC PLAYING]", texts
    assert texts[1] == "Welcome to the Tech Brew Ride Home for Friday, September 25, 2026.", texts
    assert texts[2] == "I'm Brian McCullough today.", texts
    assert texts[3].endswith("one place."), texts
    assert "super app with chat" in texts[3], texts
    assert texts[4].endswith("$10 billion."), texts
    assert cues[1][0] == 4840, cues[1]
    assert cues[1][1] == 8640, cues[1]
    again = to_sentences(parse_vtt(render(cues)))
    assert [text for _, _, text in again] == texts
    assert not _sentence_end("Mr.", "Smith")
    assert not _sentence_end("U.S.", "Policy")
    assert not _sentence_end("3.14", "percent")
    assert _sentence_end("today.", "Microsoft")
    assert not _sentence_end("today.", "and")
    print("sentences ok", len(texts))


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--test":
        _test()
    elif len(sys.argv) == 2:
        rewrite(sys.argv[1])
    else:
        sys.stderr.write("usage: sentences.py VTT | sentences.py --test\n")
        sys.exit(2)
