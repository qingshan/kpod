#!/bin/sh
set -eu

# Send arguments through stdin so feed URLs and search terms never enter a remote shell.
printf '%s\0' "$@" | ssh -T -o BatchMode=yes outbox \
    'cd /srv/kpod-transcript-celld && /home/qingshan/.local/share/mise/installs/node/24.21.0/bin/node --import tsx internal/kpod-cli.ts'
