#!/bin/sh
set -eu
python3 - <<'PY'
import json
import shlex
import subprocess

url = subprocess.check_output([
    "ssh", "outbox", "cat /srv/kpod-transcript-celld/podcast-feed-url.txt"
]).decode().strip()
command = json.dumps({"op": "feed_add", "url": url, "title": "My YouTube Podcast"})
subprocess.run([
    "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "kindle",
    "lipc-set-prop dev.qingshan.kpodd cmd " + shlex.quote(command)
], check=True)
print("Sent the private podcast subscription to kpod on the Kindle.")
PY
