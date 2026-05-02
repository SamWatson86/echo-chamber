# Guarded Native Screen Presenter Design

Status: Draft for Sam review on 2026-05-02.

## Problem

Live validation showed a local presentation bottleneck on Sam's Windows desktop client. Echo can receive remote screen frames at healthy rates, but when the viewer grid is large or maximized on a 4K display, the visible tiles can drop hard and look jittery.

This is not the same issue as the parked screen-source compatibility fix. It is also not a stream-quality reduction problem. The evidence points at WebView2 plus Windows desktop composition struggling to present large live video surfaces in Sam's current display setup.

Important local evidence:

- Sam's Echo window is on the RTX 4090 display, but the PC has mixed monitor routing: one display on the GPU and one on the motherboard/Intel path.
- Maximized Echo reported a tiny display-boundary span, and large non-spanning windows were still bad.
- A smaller 1920x1080 Echo window recovered strongly on the same RTX display.
- WebView2's 3D/compositor process was the dominant Echo-side cost during bad states.
- Friends saw the same streams more smoothly, which means the outgoing streams and SFU path were not the primary bottleneck.
- A CSS-only probe that removed several direct video-surface effects did not fix the maximized case.

## Goal

Create a guarded Windows native presenter path for received screen-share video, so Echo can keep full stream quality while removing WebView2 from the hottest video presentation work when it is the bottleneck.

The product goal is still perfection when possible: one strong display path, full quality, smooth presentation, no intentional bitrate/FPS/resolution downgrade as the fix.

## Non-Goals

- Do not make the native presenter the default for everyone immediately.
- Do not reduce capture quality, sender encode quality, SFU quality, bitrate, resolution, or FPS as the intended fix.
- Do not replace the whole viewer UI.
- Do not change browser viewer support.
- Do not build or test macOS targets.
- Do not push, deploy, open a PR, or delete the worktree without Sam explicitly asking.
- Do not silently monitor Sam's live client. Tell Sam what to open/maximize and when monitoring starts.

## Approach Options

### Option A: Keep Optimizing WebView2

Keep the current viewer architecture and continue tuning CSS, layout, WebView2 flags, and video element styles.

Pros:

- Lowest implementation risk.
- Server-delivered viewer updates are easy to roll out and roll back.
- No duplicate media connection or native rendering surface.

Cons:

- We already tried the most suspicious video-surface CSS suspects and maximized mode stayed bad.
- If WebView2/DWM is the wall, this path can only work around the bottleneck instead of removing it.
- It risks drifting toward quality caps, which Sam explicitly does not want as the real answer.

### Option B: Bridge WebView Frames To Native

Keep receiving video in JavaScript, then copy frames from the WebView into a native surface through canvas, WebCodecs, IPC, or shared buffers.

Pros:

- Lets the existing JS viewer remain the only WebRTC subscriber.
- Can be useful as a geometry or integration prototype.

Cons:

- Frame copies are exactly the kind of cost we are trying to remove.
- Browser APIs and WebView2 support can vary.
- It is unlikely to be the final high-performance path for 4K/high-refresh screen viewing.

### Option C: Native Receive And Native Present

Add a Windows desktop-client module that uses the Rust LiveKit stack to receive selected screen tracks and present them through a native Windows rendering surface. The WebView remains the UI and room-control shell.

Pros:

- Removes WebView2 from the hottest video presentation path.
- Can use a frame-dropping queue and GPU-oriented presentation model instead of relying on WebView2 composition.
- Fits the evidence: the stream can be healthy while local WebView presentation is not.
- Can be guarded behind settings, telemetry, and fallback.

Cons:

- Highest engineering complexity.
- Needs careful identity/subscription handling so it does not show up as a confusing extra participant.
- Needs careful z-order, DPI, monitor, and lifecycle handling.
- Requires a desktop binary update for users who opt in.

Recommendation: use Option C, but ship it as a guarded Windows desktop viewer feature. Keep Option A as the fallback, not the ceiling.

## Recommended Architecture

The WebView remains Echo's main UI. It still owns login, room state, tile layout, controls, overlays, settings, diagnostics, and the default `<video>` rendering path.

The native presenter is a Windows-only desktop-client module with three jobs:

1. Join or attach to the room as a receive-only native screen presenter.
2. Decode or receive selected remote screen video frames through Rust-native media APIs.
3. Present those frames into a native child or overlay surface aligned to the corresponding screen tile.

The viewer reports tile intent and geometry to the client:

- Track identity and participant identity for the selected screen tile.
- Tile rectangle in physical pixels.
- Window/display/DPI status.
- Whether the native presenter should be enabled, disabled, or allowed to auto-start.

When native presentation is active, the WebView hides or pauses only the hot screen `<video>` surface for that tile. The surrounding tile UI remains in WebView: labels, buttons, badges, volume, fullscreen controls, and diagnostics. If native presentation fails, the WebView restores the normal video element immediately.

Initial scope is one selected screen tile. Multi-tile native presentation waits until one tile is proven stable.

## Native Media Path

The existing local crates make the native receive path feasible:

- `core/livekit-local` exposes remote video tracks.
- `core/libwebrtc-local` has `NativeVideoStream` for pulling native video frames from a remote track.
- Existing tests show subscribing to `RemoteTrack::Video(track)` and creating `NativeVideoStream::new(track.rtc_track())`.

The first proof should use the simplest reliable frame path that proves end-to-end behavior. CPU frame conversion is acceptable for a short spike only if it helps validate subscription, tile targeting, fallback, and timing. The product path should move toward a GPU-friendly D3D11/DirectComposition renderer with a bounded queue size of 1 so stale frames are dropped instead of queued.

## Identity And Subscription Policy

The native presenter must not confuse room users.

Preferred policy:

- Use one receive-only native presenter connection per desktop client only when enabled.
- Give it a hidden/system identity derived from the real viewer identity, such as `<viewer-id>$native-presenter`.
- Mark it with metadata or server-side filtering so it is not shown as a normal human participant.
- Subscribe only to target screen tracks.
- Publish nothing.

If hidden/system participants are not cleanly supported by the current control/viewer model, the first implementation plan must include that filtering before any friend rollout.

## Settings And Rollout

Add a desktop viewer setting:

- `Off`: always use the normal WebView2 video path.
- `On`: use native presentation for eligible selected screen tiles.
- `Auto`: allow Echo to enable native presentation only when diagnostics match the known failure pattern.

Initial default: `Off` for normal users.

Sam's local test build can use `On` or `Auto` during validation. Friends should only use it after Sam's machine proves the path, and then only as opt-in/canary until the fallback behavior is boring and reliable.

Auto mode should require all of these before switching:

- Windows desktop client.
- Received screen track, not camera video.
- Healthy WebRTC receive FPS relative to the sender.
- Poor presented FPS or large-window/maximized known-risk state.
- Native presenter initializes and reports frames quickly.

## Telemetry

Extend diagnostics so the dashboard can explain which path is active:

- `viewer_render_path`: `webview2` or `native`.
- Native receive FPS.
- Native presented FPS.
- Native dropped-frame count.
- Native queue depth or stale-frame drops.
- Native active/error/fallback reason.
- Target participant/track identity.
- Tile size and display/DPI state.

The existing split between receive FPS and presented FPS remains mandatory. A single FPS badge is not enough.

## Fallback Rules

Fallback to WebView2 immediately when:

- Native initialization fails.
- The target track disappears or changes unexpectedly.
- No native frames arrive within a short startup timeout.
- Native presentation stalls.
- The native surface cannot align to the tile after resize/maximize/display move.
- Z-order causes controls to become unusable.
- The setting is switched to `Off`.

Fallback should be visible in diagnostics but should not require a restart.

## Test Plan

Automated prework:

- Rust unit tests for native-presenter state transitions: disabled, starting, active, fallback, stopped.
- Rust tests for identity naming/filtering helpers.
- JS tests for viewer settings, native-presenter command calls, tile geometry reporting, and fallback restoration.
- Dashboard/control tests for new telemetry fields if server schema changes are needed.

Local validation on Sam's machine:

- Close and reopen Echo before each desktop-client build validation.
- Confirm the running client path is the branch build.
- Test WebView2 `Off` baseline first.
- Test native `On` with one selected screen tile.
- Test maximized Echo on the RTX display.
- Test non-maximized 1920x1080-ish Echo on the RTX display.
- Test moving Echo between displays and returning to the RTX display.
- Test one remote screen first, then two or three remote screens with only one native-presented tile.
- Compare receive FPS, WebView presented FPS, native presented FPS, GPU engine usage, and subjective jitter.

Friend/canary validation:

- Only after Sam's local path is stable.
- Opt-in setting only.
- Verify no extra visible participant appears.
- Verify normal viewing still works when native presenter is disabled.
- Verify users who stream a GPU-heavy game and view others do not regress.

## Risks

- Blank or frozen native surface.
- Native surface appears above controls or behind the WebView.
- DPI or monitor coordinates are wrong on mixed-scale displays.
- Maximize creates tiny cross-display bounds that break alignment.
- Extra LiveKit connection appears as a user or changes room counts.
- More GPU work helps presentation but hurts someone actively gaming and watching.
- Color, HDR, or scaling differs from WebView2.
- Native renderer leaks resources across room switches.
- Crash or panic takes down the desktop client instead of falling back.

These risks are manageable only if the feature stays guarded and fallback remains first-class.

## Decision Gates

Gate 1: Native receive feasibility.

Prove the client can subscribe to a target remote screen track natively, receive frames, report stats, and stop cleanly without disturbing the normal viewer.

Gate 2: One-tile native presentation.

Prove one selected screen tile can present smoothly at Sam's maximized 4K viewer size with full stream quality and usable controls.

Gate 3: Safe fallback.

Prove disabling the setting, losing the track, resizing, moving displays, and initialization failure all restore WebView2 rendering without a restart.

Gate 4: Canary readiness.

Only after Sam's path works, decide whether to let selected friends opt in. Do not make this globally default until canary results show no regressions.

## Current Decision

Proceed to an implementation plan for Option C after Sam reviews this written spec. The plan should start with a narrow native receive spike and state-machine/fallback tests, then move to one-tile native presentation. It should not push, deploy, open a PR, or remove the WebView2 path.
