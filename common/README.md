# Shared package scaffolding

Sourced by this kpm package. Copied into the `.kpkg` at pack time
(`common/` plus `waf/waf-base.*` and `$PKG_ID/scripts/pkg-lib.sh`).

- `pkg-lib.sh` — Kindle-side install/launch/register/uninstall helpers.
  POSIX `sh` (Kindle ash). Each package has a `pkg.env` of IDs/paths.
- `load.sh` — locates `pkg-lib.sh` + `pkg.env` from a package-root script.
- `waf-base.js` / `waf-base.css` — ES5/CSS2 helpers (Kindle object, LIPC
  JSON cmd, `status.json` poll). Loaded before the package's own scripts
  and `style.css`. `setError` fills `#error` and hides it when the text
  is empty.
