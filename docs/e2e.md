# End-to-end testing

`tests/e2e/kpod_e2e.py` is the only end-to-end entry point. The page API is
the same shape kmux uses: `tap`, `press`, `type`, and `command` do the work,
and `expect` retries against `status.json`.

```python
with KpodE2E() as test:
    test.launch()
    test.page.wait("status", lambda state: "playing" in state)
    test.page.expect(lambda state: state.get("playing") is False)
```

`tap` and `press` are XTEST events from `tools/kindle_xinput.c`. `command`
is a LIPC `cmd` on `dev.qingshan.kpodd`. The daemon never delivers that
property to the page, so a button has to be tapped to prove the WAF handles
it. Screenshots are `/usr/sbin/screenshot` framebuffer PNGs.

## Commands

```sh
just test   # Rust library tests and the host WAF suite
just e2e    # host WAF suite and the transport-geometry check; no Kindle
just demo   # host suite, Kindle tour, MP4/GIF
just demo-build   # re-encode target/demo without a device
```

`just e2e` needs Node and Python 3. `just demo` also needs `ssh kindle`
(`KINDLE_E2E_HOST` overrides the alias), the kindlehf gcc from
`just toolchain`, ffmpeg, and Pillow (`pip install pillow`).

## What the Kindle tour does

The tour launches the installed player and measures the transport row before
tapping it. It captures the player and transcript, Up next, queue-position
picker, Explore, results-page picker, feed filter, a filtered show, search
results, and Compact view. Cards explain server-side transcript preparation,
automatic queued-audio downloads, and episode submission. Each device frame
is checked against the daemon's playback and queue state. The tour restores
the previous Explore query, filter, and Compact setting before it exits.

It does not sync, play, seek, toggle Bluetooth, add episodes, or edit the
queue. Record it while kpod is idle, with an empty Explore search. The tour
needs a queued episode with a transcript, at least two queue entries, multiple
catalog results, and a subscribed feed to show every stop.

Raw frames land in `target/demo/`. `tools/demo_build.py` writes
`dist/demo/kpod-demo.mp4`, a GIF, a 1920×1080 cut, and a poster.
`tools/grid_crop.py` draws a pixel grid when a capture needs to be read by
hand. `target/` and `dist/` are build output.

## What is shared across apps

The device driver is app-agnostic: SSH, `status.json`, the screenshot, XTEST
install, and the storyboard encoder. The tour, the button names, and the WAF
assertions are not. Those stay in this repo.

A shared copy of the driver belongs in `~/code/kindle` (there is no
`~/work/kindle`) once a second app is ready to import it. Putting every app's
scenarios in the catalog repo would couple their UI layouts. Until that
import exists, kpod keeps `tests/e2e/kindle_lib.py` beside the tour that uses
it, which is the same place kmux keeps its copy.
