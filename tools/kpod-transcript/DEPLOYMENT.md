# Current deployment

`kpod.qingshan.dev` runs three services:

| Service | Host | Unit | State |
| --- | --- | --- | --- |
| celld transcript API | `outbox` | `kpod-transcript-celld.service` | `/var/lib/kpod-transcript-celld` |
| Whisper runner | `testlab` | `kpod-transcript-runner.service` | transient work in `/srv/kpod-transcript-celld/work` |
| Feed and queue publisher | `outbox` | `kpod-podcast.service` | `/var/lib/kpod-podcast` |

The application lives at `/srv/kpod-transcript-celld` on both hosts and uses
Node.js 24.21.0. celld 0.6.2 listens on `127.0.0.1:8780`; the publisher
listens on `127.0.0.1:8790`. Caddy terminates HTTPS and routes `/youtube/*`
to the publisher, stripping `/youtube` from the upstream path. celld uses
persistent local storage through the application's `.celld` symlink. No object
store is configured.

The runner uses `/srv/kpod-transcript/whisper-cli` and
`/srv/kpod-transcript/ggml-small.en.bin`. Its environment is in
`/etc/kpod-transcript-runner.env`. The API tokens are in the celld application's
`.dev.vars` on `outbox`. Publisher credentials and its separate Kindle device
token are in `/etc/kpod-podcast.env`. Keep these files private and out of Git.

The private YouTube, submitted-podcast, and prepared-queue feeds share the
publisher's path key. Their media and transcripts are stored under
`/var/lib/kpod-podcast`. `outbox` asks `testlab` to download and transcribe
submitted media over SSH, copies the finished MP3 and VTT, and publishes each
RSS item only after both files are ready. Public feed subscriptions, the
playing queue, preparation state, and job metadata are stored in
`/var/lib/kpod-podcast/podcast.sqlite`.

The Kindle's `queueUrl`, `queueToken`, and `transcriptApi` are in
`/mnt/us/kpod/var/config.json`. The full transcript API URL is also saved at
`/srv/kpod-transcript-celld/kindle-transcript-api.txt` on `outbox` with mode
`0600`. The Kindle retains its OPML, queue progress, and downloaded episodes
under `/mnt/us/kpod/var` and `/mnt/us/kpod/episodes` across package updates.
The Kindle is running the 0.6.25 daemon. Its runtime was updated directly;
KPM's installed-package record still reflects an older catalog release. The
0.6.25 package is built in `dist/` but has not been published to that catalog.

## Operate and verify

```sh
ssh outbox 'systemctl is-active kpod-transcript-celld.service kpod-podcast.service'
ssh testlab 'systemctl is-active kpod-transcript-runner.service'
curl --fail https://kpod.qingshan.dev/health
./tools/kpod-transcript/kpod.sh feeds sync
./tools/kpod-transcript/kpod.sh queue list
```

From this repository, use `kpod.sh podcast submit URL`, `youtube submit URL`,
and their `status` or `wait` commands to follow a job. Run `kpod.sh help` for
the full CLI. A ready submitted podcast episode should appear in **My Podcast
Episodes** and in `episodes search`; its feed enclosure should return MP3
bytes and its transcript should begin with `WEBVTT`.

For an update, copy changed source files to `/srv/kpod-transcript-celld` on the
affected host, run `npm ci` there if dependencies changed, and restart the
affected unit. Preserve `.dev.vars`, `.celld`, `bin/`, the runner environment,
and `/var/lib/kpod-podcast`. The celld unit runs without file watching. Build
a new Kindle package with `just package <version>` after Kindle code changes;
KPM only reinstalls when the version changes.

The previous Python transcript service is disabled. Its application and cache
remain at `/srv/kpod-transcript` and `/var/lib/kpod-transcript`. The previous
Caddy configuration is backed up at
`/etc/caddy/Caddyfile.before-kpod-celld-20261009` on `outbox`. A rollback must
restore only the `kpod.qingshan.dev` transcript routes to port `8777` so later
Caddy changes are not lost.
