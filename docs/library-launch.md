# Launching kpod from the Kindle Library

The scriptlet includes `# KeepLibraryEntry` so the local SH_Integration
launcher does not touch the document timestamp or request a Library rescan.
That preserves the cover UUID while kpod is open. The scriptlet also waits
for KPM and polls appmgrd until `dev.qingshan.kpod` is active; this keeps the
launcher alive through the handoff and avoids its normal Home transition.

The `KPP_CLOSE` header control is provided by the shared `waf-base.js`.
The installed kpod WAF already uses it.

The test Kindle uses the locally patched launcher at
`/var/local/ksync-launcher/sh_integration_launcher`. Stock SH_Integration does
not recognize `KeepLibraryEntry`. The updated scriptlet is deployed at
`/mnt/us/documents/kpod.sh`; its previous copy is
`/mnt/us/documents/kpod.sh.before-launch-handoff`.

On 2026-09-29, kpod opened from Uncollected and appmgrd reported
`dev.qingshan.kpod` active. Tapping the header X returned to Uncollected with
all five covers visible. No package was published.
