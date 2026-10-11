#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 'https://www.youtube.com/watch?v=VIDEO_ID'" >&2
    exit 2
fi
printf '%s\n' "$1" | ssh outbox 'cd /srv/kpod-transcript-celld && /home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node --import tsx internal/submit-youtube.ts'
