#!/bin/sh
# Installs kpod to /mnt/us/kpod.
#
# Everything is bundled (the kpodd binary, WAF, scripts, scriptlet), so
# the install is fully local and deterministic - no network needed. Binaries
# and scripts are always refreshed so upgrades pick up new code, but the
# user's var/ (config, catalog, playlist, index, subscriptions.opml, log) and
# downloaded episodes are left untouched, so upgrading never wipes
# subscriptions or episodes.

set -e

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

pkg_install

echo "kpod installed. Open kpod from Home, tap Add show in Explore to"
echo "subscribe from the podcast library, or drop an OPML file at"
echo "/mnt/us/kpod/var/subscriptions.opml, then tap Sync."
