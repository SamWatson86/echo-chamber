# Full-Quality Display Path Validation

Date: 2026-05-02
Branch: `codex/screen-sources-command-investigation`

## Build

- Viewer tests: `node --test core/viewer/*.test.js` passed, 58/58.
- Focused screen-surface/video diagnostics tests passed, 8/8.
- Client display-placement tests: `cargo test -p echo-core-client display_placement` passed, 4/4.
- Rust checks: `cargo check -p echo-core-client -p echo-core-control` passed.
- Desktop client build: `cargo build -p echo-core-client` passed.
- Control build: `cargo build -p echo-core-control` passed.

## Test Setup Correction

The first live run only launched the branch desktop client. The running control server was still the installed release control process from:

`F:\Codex AI\The Echo Chamber\core\target\release\echo-core-control.exe`

That served old viewer assets and could not report `presented_fps` or `display_status`. The control process was then swapped to the branch debug control binary while keeping the normal certs/SFU/TURN environment:

`F:\EC-worktrees\screen-sources-command\core\target\debug\echo-core-control.exe`

The branch control log confirmed:

- Viewer dir: `F:\EC-worktrees\screen-sources-command\core\viewer`
- Admin dir: `F:\EC-worktrees\screen-sources-command\core\admin`
- Server stamp: `0.6.11.1777694918`

## Display Path

Windows display mapping during validation:

- `\\.\DISPLAY1`: NVIDIA GeForce RTX 4090, 3840x2160 @ 144 Hz, position `(-3840, 0)`.
- `\\.\DISPLAY5`: Intel UHD Graphics 770, 3840x2160 @ 60 Hz, position `(0, 0)`.

Echo was on `\\.\DISPLAY1`, the RTX 4090 display.

## Maximized Result

When maximized on the RTX display, Windows reported the Echo outer window as:

- `window_x=-3851`
- `window_y=-11`
- `window_width=3862`
- `window_height=2110`
- `window_spans_displays=true`

This appears to be the normal invisible maximized frame crossing the display boundary by about 11 physical pixels.

Observed Sam receive/presentation samples while maximized:

- 1920x1080 stream: WebRTC receive roughly 26-35 FPS, presented roughly 20-27 FPS.
- 1920x804 stream: WebRTC receive roughly 19-40 FPS, presented roughly 9-31 FPS.

GPU counters during the maximized bad state:

- Echo WebView2 GPU process: about 65% 3D engine.
- Echo WebView2 video decode: about 2-5%.
- DWM was active on both GPU paths.
- MyRadar and Codex also had measurable GPU/CPU activity, but Echo's own WebView2 GPU process remained the dominant Echo-side cost.

## Non-Maximized Result

At an almost-full RTX display placement with no display spanning:

- `window_x=-3840`
- `window_y=60`
- `window_width=3600`
- `window_height=1980`
- `window_spans_displays=false`

Presented FPS was still unstable:

- 1920x1080 stream: receive roughly 26-32 FPS, presented roughly 13-28 FPS.
- 1920x804 stream: receive roughly 27-49 FPS, presented roughly 16-29 FPS.

At a smaller 1920x1080 physical Echo window on the same RTX display:

- `window_x=-3840`
- `window_y=60`
- `window_width=1920`
- `window_height=1080`
- `window_spans_displays=false`

Presented FPS recovered:

- 1920x1080 stream: receive roughly 28-31 FPS, presented roughly 28-30 FPS.
- 1920x804 stream: receive roughly 87-90 FPS, presented roughly 59-60 FPS.

## CSS Probe

A temporary probe removed direct video compositor hints and over-video decorative paint:

- Removed `transform: translateZ(0)` from `.screen-video-surface`.
- Removed `backface-visibility`.
- Removed the `.screens-grid .tile::after` decorative overlay.
- Disabled blur on the screen tile FPS overlay.

Focused tests passed after the probe, but maximized presentation still collapsed. The probe was reverted because it did not solve the issue and removed visual polish.

## Decision

Result: WebView2 large-window screen-grid presentation is the wall.

The receive path is not the primary bottleneck. The same remote streams present smoothly in Sam's viewer at a smaller window size and present much better for other viewers. The failure appears when the WebView2 screen grid has to compose a large 4K-class surface on Sam's mixed Intel/NVIDIA display setup.

Next step: start a separate native presenter design/spike. Target a minimal Direct3D/DirectComposition proof of concept for one received screen tile while keeping WebView2 as the surrounding UI shell. This is the path that removes the bottleneck instead of lowering stream quality or trimming visual effects.
