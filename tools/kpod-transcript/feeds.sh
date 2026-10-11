#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "Usage: $0 list | add FEED_URL | remove SHOW_ID_OR_URL | sync" >&2
    exit 2
fi

printf '%s\0' "$@" | ssh -o BatchMode=yes outbox \
    'cd /srv/kpod-transcript-celld && /home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node --import tsx internal/feeds-cli.ts'
