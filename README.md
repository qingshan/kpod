# kpod

## A podcast player for an e-ink Kindle.

kpod turns a jailbroken Kindle into a podcast player. In personal queue mode,
`kpod.qingshan.dev` indexes subscribed feeds, prepares transcripts, and
publishes a private queue feed. The Kindle downloads MP3 episodes and plays
them through a paired Bluetooth speaker. The page shows the episode, queue,
and a transcript that follows playback, with controls laid out for an e-ink
screen. It targets a Kindle Oasis 10th generation (`kindlehf`, firmware 5.16.x)
with [KPM](https://github.com/KindleModding/KPM) installed.

![kpod feature tour](docs/kpod-demo.gif)

The demo is captured from a real Kindle Oasis. It shows the player and
transcript, queue and position picker, Explore search, page and feed pickers,
and Compact view. It also explains episode submission and queue preparation.

## What you need

- A KPM-compatible jailbroken Kindle.
- A kpod `.kpkg` built for `kindlehf`.
- Wi-Fi, for feeds, episodes, and transcripts.
- A paired Bluetooth speaker or headphones. Pair it in Kindle Settings.
  The player can reconnect that speaker; it does not pair a new one.
- An OPML file or shows subscribed through the server queue CLI.

kpod plays MP3 episodes. Other enclosures can appear in Explore and are
marked unavailable.

## Install

Install the `.kpkg` with KPM, then open **kpod** from the Kindle Home screen.

```text
;kpm install kpod
```

To start from an OPML export, copy it to:

```text
/mnt/us/kpod/var/subscriptions.opml
```

For a server queue, add or remove shows and refresh their feeds from the
repository with `./tools/kpod-transcript/kpod.sh feeds`. Run `kpod.sh help`
for all feed, queue, transcript, and submitted-episode commands.

To use the prepared queue, set `queueUrl` to the private `/queue.xml` URL and
`queueToken` to the separate device token in `/mnt/us/kpod/var/config.json`.
The Kindle then syncs that one feed, searches the server catalog, and sends
Add, Remove, and Move actions to the server. An added episode shows
**Preparing transcript** until a feed transcript has been cached or Whisper
finishes one; only ready episodes appear in the playing queue. New episodes
enter position 2 while the first episode is in progress, including when
paused, and position 1 when it is unplayed or finished. The local OPML and
downloads remain on the Kindle so switching back does not erase them.

## Listening

The player shows the episode title, the show name, a progress bar, and the
played time next to the episode length.

| Control | Action |
| --- | --- |
| Rewind / forward | Skip 15 seconds |
| Play | Play or pause the current episode |
| Bluetooth | Connect the paired speaker, or disconnect it |
| Up next | The play queue |
| Explore | Search episodes and filter by show |
| Compact | Hide the title and progress row |

The line under the player is the transcript. It follows playback. The
highlighted sentence is underlined. Feed transcripts (plain text, WebVTT,
SRT, or JSON) are used when the feed provides one.

While audio is playing, kpod defers system suspend after the screen saver
appears. The screen can stay off during playback. Stopping playback releases
the deferral; a crashed player leaves at most a 30-second deferral.

A status message sits under the buttons and does not move them. It is hidden
when there is nothing to report.

## Transcript service

Leave `transcriptApi` empty in `/mnt/us/kpod/var/config.json` and kpod only
uses transcripts from the feed. To generate the rest, point it at a service
that speaks this contract:

```text
GET {transcriptApi}?url={audio}&id={episode}
```

- `200` with WebVTT, SRT, JSON, or plain text: the transcript is ready.
- `503`: still working. kpod keeps asking and shows it when it arrives.
- `502`: the job failed.

The TypeScript [`tools/kpod-transcript/`](tools/kpod-transcript/) service runs
on [celld](https://github.com/denoland/celld). A Durable Object stores jobs and
cached WebVTT; a runner on your server pulls jobs and runs
[whisper.cpp](https://github.com/ggerganov/whisper.cpp). It accepts audio URLs
and Apple Podcasts episode pages. See the service README for setup, deployment,
and the Kindle `transcriptApi` URL.

The same tool can create a private YouTube podcast: submit a video URL with
`./tools/kpod-transcript/submit-youtube.sh`, and the runner downloads audio,
transcribes it, and publishes an MP3, WebVTT, and RSS item. See the
[YouTube podcast setup](tools/kpod-transcript/README.md#private-youtube-podcast).
It can also publish individual podcast episode pages into **My Podcast
Episodes**; see [submitted podcast episodes](tools/kpod-transcript/README.md#submitted-podcast-episodes).
The publisher also hosts the personal queue API and private RSS feed; see its
[queue setup](tools/kpod-transcript/README.md#prepared-playing-queue).

## Storage and upgrades

Subscriptions, config, the catalog, and the queue live in `/mnt/us/kpod/var/`.
Episode files live in `/mnt/us/kpod/episodes/`. Both survive a kpod upgrade.
Back them up before a Kindle reset.

KPM reinstalls a package only when its version changes.

## Troubleshooting

- Empty queue: confirm the configured feeds and Wi-Fi connection.
- `mp3 only`: that enclosure is not MP3.
- No sound: the speaker must be paired in Kindle Settings. Use the Bluetooth
  button to connect it, then play again. If the Kindle reports the speaker
  is not in range, disconnect it from other devices and power-cycle it.
- A stale screen: reopen kpod from Home. That restarts the background service.

## Build

```sh
just toolchain   # once: kindlehf gcc and a liblipc link stub
just test        # host tests; does not link the Kindle daemon
just package     # dist/kpod_<version>_kindlehf.kpkg
```

`just package x.y.z` sets the package version. The daemon links `liblipc`,
which exists only on the Kindle, so `cargo build` of `kpodd` on the host is
not a supported check. `cargo test -p kpod --lib` runs the portable logic.

`just publish` uploads the package to a KPM catalog. The default remote is
`https://github.com/qingshan/kindle.git`. Override it with
`KINDLE_CATALOG_REPO`. A private catalog needs `KINDLE_CATALOG_TOKEN`.

`just e2e` runs the host page suite. It does not need a Kindle. `just demo`
records a tour of the installed player and encodes `dist/demo/kpod-demo.mp4`.
The README tour is `docs/kpod-demo.gif`, copied from that render. The Kindle
SSH host is `kindle`; override it with `KINDLE_E2E_HOST`. The tour does not
sync, play, or edit the queue. See [docs/e2e.md](docs/e2e.md).

## License

Code is MIT. See [LICENSE](LICENSE).

The player icons use JetBrains Mono Nerd Font, which is covered by the
[SIL Open Font License](kpm/waf/fonts/OFL.txt), not the MIT license.

## Publishing

Build with `just package <version>` and upload the `.kpkg` to the matching
GitHub Release (`v<version>`). Then run `just publish <version>` to update
the shared KPM catalog with the release download URL. Package archives stay
in GitHub Releases; only their URLs are stored in the catalog. The release
workflow can update the catalog when `KINDLE_CATALOG_TOKEN` is configured.
