#!/bin/sh
# Stops kpod (if running) and removes the package.
#
# KPM also runs this BEFORE an upgrade, as `uninstall.sh upgrade`. In that
# case the user's var/ (config.json, index.json, subscriptions.opml, logs)
# AND downloaded episodes are kept so the reinstall is instant and never
# resets subscriptions or re-downloads - only the daemon, upstart job, WAF
# registration and scriptlet are torn down. A plain `kpm uninstall` removes
# everything under /mnt/us/kpod.

SCRIPT_DIR=$(dirname -- "$(readlink -f -- "$0")")
if [ -f "$SCRIPT_DIR/common/pkg-lib.sh" ]; then
    . "$SCRIPT_DIR/common/pkg-lib.sh"
elif [ -f "$SCRIPT_DIR/../common/pkg-lib.sh" ]; then
    . "$SCRIPT_DIR/../common/pkg-lib.sh"
else
    echo "error: pkg-lib.sh not found" >&2
    exit 1
fi
. "$SCRIPT_DIR/pkg.env"

pkg_uninstall "$1"
