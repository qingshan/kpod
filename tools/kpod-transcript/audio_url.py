#!/usr/bin/env python3
"""Turn a podcast address into a file curl can download.

Direct audio URLs pass through. An Apple Podcasts episode page
(https://podcasts.apple.com/...?...&i=<episode>) is fetched and the
embedded stream URL is returned, preferring a file over HLS.
"""

import json
import re
import sys
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

_SERVER_DATA = re.compile(
    r'<script[^>]*\bid=["\']serialized-server-data["\'][^>]*>(.*?)</script>',
    re.I | re.S,
)
_AUDIO_EXT = (".mp3", ".m4a", ".mp4", ".aac", ".ogg", ".opus", ".wav", ".flac")
_UA = "Mozilla/5.0"


def resolve_audio_url(url):
    url = url.strip()
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":")[0]
    if host != "podcasts.apple.com":
        return url
    episode = (parse_qs(parsed.query).get("i") or [""])[0].strip()
    if not episode.isdigit():
        raise ValueError("Apple Podcasts URL needs an episode id (?i=)")
    req = Request(url, headers={"User-Agent": _UA})
    with urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", "replace")
    return stream_url_from_html(html)


def stream_url_from_html(html):
    match = _SERVER_DATA.search(html)
    if not match:
        raise ValueError("Apple Podcasts page has no episode data")
    found = []
    _collect(json.loads(match.group(1)), found)
    if not found:
        raise ValueError("Apple Podcasts page has no audio URL")
    # Stable order: first file wins, then any non-HLS URL, then HLS.
    found.sort(key=_rank)
    return found[0]


def _collect(node, found):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "streamUrl" and isinstance(value, str) and value.startswith("http"):
                if value not in found:
                    found.append(value)
            else:
                _collect(value, found)
    elif isinstance(node, list):
        for value in node:
            _collect(value, found)


def _rank(url):
    path = urlparse(url).path.lower()
    if path.endswith(".m3u8") or "/hls/" in url.lower():
        return 2
    if any(path.endswith(ext) for ext in _AUDIO_EXT):
        return 0
    return 1


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: audio_url.py URL\n")
        return 2
    sys.stdout.write(resolve_audio_url(sys.argv[1]) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
