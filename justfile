# kpod Kindle podcast player.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Host-testable daemon logic, then the WAF suite. Do not natively link kpodd.
test:
    cargo test -p kpod --lib
    just e2e

# Host WAF suite and transport-geometry check. No Kindle.
e2e:
    python3 tests/e2e/kpod_e2e.py

# Record the Kindle tour and encode dist/demo. Needs ssh kindle, ffmpeg, Pillow.
demo:
    ./tools/build-kindle-xinput.sh
    python3 tests/e2e/kpod_e2e.py --record

# Re-encode dist/demo from frames already captured.
demo-build:
    python3 tools/demo_build.py

# Install kindlehf gcc (~/x-tools) and the liblipc link stub.
toolchain:
    ./tools/setup-toolchain.sh

# Cross-compile kpodd and write a .kpkg to dist/.
# Usage: just package [version]
package version="": toolchain
    ./tools/pkg-build.sh {{version}}

# Build and publish the package to the shared KPM catalog.
# Requires KINDLE_CATALOG_TOKEN when the catalog remote uses HTTPS.
publish version="": toolchain
    ./tools/publish.sh {{version}}
