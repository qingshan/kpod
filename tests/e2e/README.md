# End-to-end tests

`kpod_e2e.py` is the entry point. `just e2e` runs `waf_e2e.js` (the shipped
ES5 page, stubbed in Node) and `geometry.py`, which checks that a seven-button
transport row can be measured and that a shorter row is rejected. No Kindle
is involved.

`KindlePage` is the device page: `tap` / `press` / `type` inject XTEST events,
`command` sets the LIPC `cmd` property, and `expect` polls `status.json`.
`kindle_lib.py` is the SSH, screenshot, and gesture driver.
`kindle_demo.py` is the storyboard. It measures the transport buttons on the
opening framebuffer and fails closed when that row is ambiguous, so a layout
change cannot tap Play or Bluetooth at an old coordinate.

`just demo` runs the host suite, records the tour, and calls
`tools/demo_build.py`. See [docs/e2e.md](../../docs/e2e.md).
