# kpod transcript service

A TypeScript Worker on [celld](https://github.com/denoland/celld), with a
SQLite Durable Object holding jobs, leases, and cached WebVTT. A Node.js
runner pulls jobs over HTTP and runs ffmpeg and whisper.cpp. The runner needs
no inbound connection. No Cloudflare account, KV namespace, or Queue is used.

```text
Kindle -> celld /transcript -> Transcripts cell (SQLite)
Whisper runner -> celld /jobs/claim and /result/:key
```

The API returns `200` with WebVTT when ready, `503` while pending, and `502`
when a job has failed three times. Audio URLs are deduplicated by SHA-256.
A claim lasts 12 hours, longer than the 30-minute ffmpeg and eight-hour
Whisper timeouts. A crashed runner's job becomes claimable after its lease
expires; an old lease cannot overwrite a newer attempt. Failed attempts retry
after five minutes. Successful results expire after 90 days, errors after one
hour; expired entries are removed on the next request. Jobs and results survive
celld restarts. Audio and temporary WAV files stay on the runner and are removed
after each attempt.

## Local setup

Use Node.js 24+, [celld](https://celld.dev/docs/), ffmpeg, whisper-cli, and a
ggml Whisper model. Commands below run in this directory. Install celld using
its upstream installation instructions. `npm run dev` puts the project's
esbuild on PATH for celld's bundler.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Replace both values with different random tokens.
npm run dev
```

celld serves `http://127.0.0.1:9876` and persists local state in `.celld/dev`.
Do not use `celld dev --clean` to restart a service whose data you need.
In a second shell, set the runner environment and start it:

```sh
export KTR_WORKER_URL=http://127.0.0.1:9876
export KTR_RUNNER_TOKEN=THE_RUNNER_TOKEN_FROM_DEV_VARS
export KTR_WHISPER=/srv/kpod-transcript/whisper-cli
export KTR_MODEL=/srv/kpod-transcript/ggml-small.en.bin
npm run runner
```

The runner processes one job at a time. Both direct audio URLs and Apple
Podcasts episode links containing `?i=EPISODE_ID` are accepted. Whisper uses
English, two threads, and merges short cues into sentences.

## Production

For one host with persistent local storage, use the
[celld systemd unit](kpod-transcript-celld.service). Install this project at
`/srv/kpod-transcript-celld`, celld at `bin/celld`, and set the two tokens in
`.dev.vars` with mode `0600`. Put Node.js on the service's PATH. Create
`/var/lib/kpod-transcript-celld`, owned by the service user, and symlink the
project's `.celld` directory to it. The unit serves loopback port `8780`;
point Caddy at that port. Adjust the unit's user to your installation.
This uses `celld dev --no-watch` as a single-node service: data survives
process restarts, but there is no off-host replication. Stop the service
before backing up the state directory, and preserve `.dev.vars` separately.
Never run `--clean` against this state.

The current installation is documented in [DEPLOYMENT.md](DEPLOYMENT.md).

For a fleet backed by an object-store bucket:

Follow celld's [deployment guide](https://celld.dev/docs/) to provision a
supported object store and start a node. Use the same bucket, endpoint, and
region for deployment and the serving node. Keep celld's internal operator
listener private. Production deployment does **not** load `.dev.vars`.

```sh
cp wrangler.json wrangler.production.json
chmod 600 wrangler.production.json
# Set vars.CLIENT_TOKEN and vars.RUNNER_TOKEN to different random tokens.
export PATH="$PWD/node_modules/.bin:$PATH"
celld deploy wrangler.production.json \
  --bucket "$CELLD_BUCKET" --endpoint "$S3_ENDPOINT" --region "$AWS_REGION"
```

`wrangler.production.json` is ignored by Git. These variables are included in
the deployment stored in your bucket; restrict access to the bucket and local
config. Keep the Worker name and Durable Object class name stable to retain
access to their data. For AWS S3, omit `--endpoint` as described upstream.

The example [Caddyfile](Caddyfile) terminates HTTPS and forwards the four API
routes to the celld Worker listener at `127.0.0.1:8780`. Adjust the port to
match your node. Set the runner's `KTR_WORKER_URL` to that HTTPS origin.
The runner authenticates with `KTR_RUNNER_TOKEN`; the Kindle uses the separate
client token. The runner accepts URLs from the authenticated Kindle, so use
this service only with trusted clients.

Install this directory and its npm dependencies at `/srv/kpod-transcript-celld`
on the Whisper machine, and place the runner variables above in
`/etc/kpod-transcript-runner.env`. Install
[kpod-transcript-runner.service](kpod-transcript-runner.service) with your
service manager and adjust its user and Node path if needed. Run celld under a
service manager as well, following its deployment guide.

Set `transcriptApi` in `/mnt/us/kpod/var/config.json` to:

```text
https://kpod.example.com/transcript?key=YOUR_CLIENT_TOKEN
```

Treat this URL as a secret. The new service replaces the old Python/SSH and
Cloudflare implementations; stop their services when switching the Kindle
URL. Their existing caches are not imported, so requested episodes will be
transcribed again. Do not delete the old cache until the switch is verified.

## Private YouTube podcast

The optional `kpod-podcast.service` on the API host accepts a single YouTube
video URL per submission. The runner host uses `yt-dlp` to download audio,
converts it to MP3, and produces timed WebVTT with Whisper. The API host
copies the finished files, then lists the episode in an RSS feed. The feed
contains standard audio enclosures and `podcast:transcript` links, which kpod
already understands.

Install `yt-dlp` and Node.js 24+ on the runner host. The runner uses
`internal/youtube-process.ts`, its existing Whisper executable and model,
and a work directory at `/srv/kpod-transcript-celld/work`. The API host must
be able to SSH to the runner host as `testlab` and pull files with `scp`.
The [podcast unit](kpod-podcast.service) uses a private environment file
`/etc/kpod-podcast.env` containing:

```text
PODCAST_ADMIN_TOKEN=RANDOM_HEX_TOKEN
PODCAST_FEED_KEY=DIFFERENT_RANDOM_HEX_TOKEN_AT_LEAST_48_CHARS
PODCAST_BASE_URL=https://kpod.qingshan.dev/youtube
PODCAST_DATA_DIR=/var/lib/kpod-podcast
PODCAST_PORT=8790
```

Create the data directory for the service user and keep the environment file
readable only by that user. Caddy must proxy `/youtube/*` to port `8790`,
stripping `/youtube` from the upstream path. The RSS, MP3, and WebVTT URLs
contain the secret feed key; anyone who gets the link can read them. The
submission and job-status endpoints separately require the admin token.

From this repository, submit a video with:

```sh
./tools/kpod-transcript/submit-youtube.sh 'https://www.youtube.com/watch?v=VIDEO_ID'
```

The script sends the URL over SSH to `outbox`, reads the admin token there,
returns the job ID and feed URL, and never puts the token on the submitting
machine. Check a job from this repository with:

```sh
./tools/kpod-transcript/status-youtube.sh VIDEO_ID
```

Submitting the same video again reports its current state. Submitting a failed
video again retries it. The feed URL is saved on `outbox` in
`/srv/kpod-transcript-celld/podcast-feed-url.txt` (mode `0600`). Add that URL
as a kpod feed or place it in the Kindle's subscriptions OPML. On this
installation, once the Kindle is online, run:

```sh
./tools/kpod-transcript/subscribe-youtube.sh
```

The feed may be empty until the first submitted video finishes.

YouTube can require sign-in for some videos or hosts. If the runner receives
that response, place an exported Netscape-format cookie file on the runner
host and set `PODCAST_YTDLP_COOKIES=/absolute/path/to/cookies.txt` in
`/etc/kpod-podcast.env` on `outbox`; it is passed to the runner over SSH. Keep that file
private and refresh it when it expires. The downloader accepts only individual
YouTube video URLs, not channel or playlist URLs. Each video is limited to
six hours and 500 MiB of audio; temporary work is removed after successful publication.

## Submitted podcast episodes

Submit an individual podcast episode page to a separate private feed:

```sh
./tools/kpod-transcript/kpod.sh podcast submit 'https://podcasts.example/show/episode'
./tools/kpod-transcript/kpod.sh podcast list
./tools/kpod-transcript/kpod.sh podcast status EPISODE_ID
./tools/kpod-transcript/kpod.sh podcast wait EPISODE_ID
./tools/kpod-transcript/kpod.sh podcast retry EPISODE_ID
./tools/kpod-transcript/kpod.sh podcast feed
```

The publisher downloads the audio on the Whisper host, converts it to MP3,
generates timed WebVTT against that MP3, and copies both files to the publisher.
An episode appears in **My Podcast Episodes** only after both files are ready.
The publisher subscribes this feed automatically, so kpod can find its episodes
in Explore and add them to Up Next. The feed uses the same private link key as
My YouTube Podcast. Supported episode pages are those whose media can be found
by yt-dlp; Apple Podcasts pages with an episode ID are also supported. A failed
job can be retried by ID. Episodes are limited to six hours and 500 MiB of MP3.

## Prepared playing queue

Manage the server's subscribed shows from this repository:

```sh
./tools/kpod-transcript/kpod.sh feeds list
./tools/kpod-transcript/kpod.sh feeds add 'https://example.com/podcast.xml'
./tools/kpod-transcript/kpod.sh feeds remove SHOW_ID_OR_URL
./tools/kpod-transcript/kpod.sh feeds sync
./tools/kpod-transcript/kpod.sh episodes search 'topic' --show SHOW_ID --limit 20
./tools/kpod-transcript/kpod.sh queue list
./tools/kpod-transcript/kpod.sh queue add EPISODE_ID
./tools/kpod-transcript/kpod.sh queue move EPISODE_ID 1
./tools/kpod-transcript/kpod.sh queue remove EPISODE_ID
./tools/kpod-transcript/kpod.sh transcripts list --state error
./tools/kpod-transcript/kpod.sh transcripts status EPISODE_ID
./tools/kpod-transcript/kpod.sh transcripts retry EPISODE_ID
./tools/kpod-transcript/kpod.sh transcripts wait EPISODE_ID
./tools/kpod-transcript/kpod.sh transcripts show EPISODE_ID > episode.vtt
./tools/kpod-transcript/kpod.sh youtube list
./tools/kpod-transcript/kpod.sh youtube submit 'https://www.youtube.com/watch?v=VIDEO_ID'
./tools/kpod-transcript/kpod.sh youtube status VIDEO_ID
./tools/kpod-transcript/kpod.sh youtube retry VIDEO_ID
./tools/kpod-transcript/kpod.sh youtube wait VIDEO_ID
```

The CLI runs on `outbox` over SSH. It uses the publisher API for changes and
reads local SQLite for detailed queue and job status. `wait` exits when an item
is ready or fails (default timeout: one hour; pass seconds to change it).
`transcripts show` prints the cached timed transcript. `queue move` uses
one-based positions. A newly added episode takes position 2 while the first
episode is in progress, including when paused; otherwise it takes position 1.
The Kindle reports playback start and completion to the queue server. Run
`kpod.sh help` for all commands. The older `feeds.sh`
and YouTube scripts remain available.

`add` indexes a feed immediately. `sync` refreshes every subscribed feed and
reports source errors. The server also refreshes feeds automatically every 15
minutes; kpod checks its playing queue every 45 seconds while idle. Removing
a show stops future feed refreshes and removes its unqueued episodes from
search. Episodes already in the playing queue remain available.

The publisher also stores public feed subscriptions and indexes their episodes
in SQLite. Its private queue feed at
`$PODCAST_BASE_URL/$PODCAST_FEED_KEY/queue.xml` contains only episodes whose
transcript is cached. The Kindle searches subscribed shows through
`.../queue/search?q=...&show=...` and lists show filters through
`.../queue/shows`. Each search returns up to 100 newest matching episodes.
Search matches show names, episode titles, and episode descriptions.
The Kindle displays ten at a time and switches pages from that cached result
without another server request. The queue RSS carries each item's show name.

Set `PODCAST_TRANSCRIPT_API` in `/etc/kpod-podcast.env` to the authenticated
celld `/transcript?key=...` URL. When an episode is added, the publisher first
copies a usable timed transcript advertised by the source feed. If none
exists or the advertised link fails, it asks celld to run Whisper and polls
until WebVTT is ready. Only then does the item
enter `queue.xml`. Set a separate random `PODCAST_DEVICE_TOKEN` for the
Kindle's Add, Remove, Move, refresh, and feed-subscription requests. The admin
token also works for these requests. Both tokens use the `Authorization:
Bearer ...` header; the private path key alone grants read access.

Configure `/mnt/us/kpod/var/config.json` with `queueUrl` set to the private
`queue.xml` URL and `queueToken` set to the device token. kpod mirrors the
server queue on Sync and periodically while idle. Its existing OPML and
downloaded episodes are preserved. While audio is playing, a separate queue
update downloads newly prepared episodes in the background.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

Tests use real SQLite for job transitions and stub the celld namespace. They
cover concurrent polling, completion, retries, expired leases, authentication,
runner requests, and transcript formatting. For a runtime smoke test, start
`npm run dev`, request `/transcript?key=...&url=...`, claim with
`POST /jobs/claim` and `Authorization: Bearer RUNNER_TOKEN`, then post
`{"lease":"CLAIM_LEASE","vtt":"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello.\n"}`
to `/result/CLAIM_KEY` with the same bearer token. The next transcript poll
should return that WebVTT.
