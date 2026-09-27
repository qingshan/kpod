#!/bin/sh
# Starts kpodd (the LIPC daemon backing the kpod WAF).
#
# Liveness is probed via the LIPC service itself (not pgrep). Prefers the
# upstart job; when no such job exists (or it failed), runs the daemon
# detached WITHOUT -n so it double-forks and survives this shell ending.

. "$(dirname -- "$(readlink -f -- "$0")")/pkg-lib.sh"
. "$(dirname -- "$(readlink -f -- "$0")")/pkg.env"
pkg_start_daemon
