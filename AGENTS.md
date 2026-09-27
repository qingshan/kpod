# Agent notes

Standalone **kpm** package for a jailbroken Kindle Oasis 10th gen (`kindlehf`,
firmware 5.16.x “juno”, Mesquite WAF): podcast player with OPML subscriptions
and Bluetooth playback.

## Commands

```sh
just test                 # cargo test -p kpod --lib, then the host e2e suite
just e2e                  # WAF suite and transport geometry; no Kindle
just demo                 # Kindle tour and dist/demo encode; needs ssh kindle
just package              # cross-compile kindlehf + pack .kpkg into dist/
just package <x.y.z>      # bump kpm package version while packing
just toolchain            # once: ~/x-tools kindlehf gcc + liblipc stub
```

Kindle crates **cannot be linked natively** (`liblipc`). Use
`cargo test -p kpod --lib`; do not build `kpodd` on the host.

`.kpkg` files under `dist/` are build output.

## Version bumps

KPM only reinstalls when the version changes. After daemon, WAF, or script
edits, bump **all** of:

- `kpm/manifest.json`
- `crates/kpod/Cargo.toml` and `Cargo.lock`
- `kpm/waf/index.html` `?v=` on `style.css`, `core.js`, `views.js`,
  `overlay.js`, and `script.js`

`just package <x.y.z>` rewrites the kpm bits; still bump the crate version.

## Package shape

Rust LIPC daemon + Mesquite WAF.

| Daemon / LIPC | On-device |
| --- | --- |
| `kpodd` `dev.qingshan.kpodd` | `/mnt/us/kpod` |

Shared Kindle helpers: [`common/`](common/) (`pkg-lib.sh`, `waf-base.js/css`).
Install scripts are POSIX `sh` (Kindle ash). `KEEP_ON_UPGRADE` (`var/` and
`episodes/`) survives reinstall — do not wipe user config.

WAF talks one-way JSON on the LIPC `cmd` property (`sendJsonCmd`) and
**polls** `status.json` in `/var/local/mesquite/kpod/`. No fetch, no sync
LIPC RPC. The daemon writes that file; WebKit cannot play audio (`kpodd`
decodes in the daemon).

## WAF (Mesquite WebKitGTK 1.0.7.2)

- **JS:** ES5 only — `var`, no `const`/`let`, arrows, template literals,
  Promises, `class`, modules.
- **CSS:** CSS2 — no flexbox, grid, or `position:fixed`.
- Prefer `mousedown` over `click` (this WebKit often never delivers
  mouseup/click). Invert a beat (`PRESS_FLASH_MS`) before navigation so
  e-ink shows the tap.
- One overlay at a time (dropdown / modal / error pop).

## Style

- Rust 2021, `cargo fmt`. Host-testable logic in `crates/kpod/src/*.rs`
  (`#[cfg(test)]`); keep `src/bin/kpodd.rs` as the LIPC/IO shell.
- Commit subject: imperative, what changed (“Add kpod feed error row”).
- Comments: short and factual; no changelog narration.
- Do not add a native `cargo build` of Kindle bins to CI-style checks on
  the host.
