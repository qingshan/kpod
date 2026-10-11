#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 VIDEO_ID" >&2
    exit 2
fi
case "$1" in
    *[!A-Za-z0-9_-]*|'') echo "Invalid video ID" >&2; exit 2 ;;
esac
if [ "${#1}" -ne 11 ]; then
    echo "Video ID must be 11 characters" >&2
    exit 2
fi
ssh outbox "cd /srv/kpod-transcript-celld && /home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node --import tsx internal/status-youtube.ts $1"
