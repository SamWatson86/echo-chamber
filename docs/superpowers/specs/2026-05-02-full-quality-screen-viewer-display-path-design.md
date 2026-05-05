# Full-Quality Screen Viewer Display Path Design

Status: Approved by Sam on 2026-05-02.

## Problem

Echo screen tiles can receive good WebRTC frames while the visible viewer still looks low-FPS or jittery, especially when Echo is maximized and the screen grid is large. Live testing showed the drop is tied to local presentation/compositing more than network, capture, or the sender.

Sam's machine is also not a normal single-GPU display path. Main-branch notes already document a risky Windows compositor/display-present environment: RTX 4090, 4K/high-refresh monitors, mixed monitor routing, MPO mitigations, and prior full-reboot-only flicker incidents from capture/display transitions.

The parked screen-source compatibility fix is separate. This design is for the viewer/display performance problem.

## Goal

Make Echo use one known-good, full-performance display path for Sam:

- Echo should prefer the RTX 4090-connected monitor.
- Screen streams should stay full quality: no intended bitrate, resolution, or FPS reduction.
- The UI should keep its polished visual design.
- The live video path should be measured and protected so WebView2/Windows can present frames cleanly.

## Non-Goals

- Do not reduce stream quality as the intended fix.
- Do not use the render-size cap as the final product behavior.
- Do not test WGC monitor capture on Sam's daily-driver PC.
- Do not push, deploy, open a PR, or delete this worktree without Sam explicitly asking.
- Do not rewrite the whole viewer or switch frontend frameworks for this fix.

## Design Principles

1. Full fidelity first.
   Echo should try to present the real stream at full tile size. Any quality cap is a diagnostic or emergency fallback, not the solution.

2. Protect the live video surface.
   The `<video>` element should get the simplest possible compositor path. Visual polish can remain around it, but effects should not force the video itself into expensive paint/composite work.

3. Make display placement explicit.
   Echo should know which monitor it is on, prefer the 4090-connected display, and flag or fix risky placement such as the Intel/motherboard display or spanning monitors.

4. Measure every stage.
   The UI should distinguish stream receive health from local presentation health. A single `fps` badge is not enough.

## Approach

### Phase 1: Correct Diagnostics

Add or keep diagnostics that separate:

- Publisher/capture FPS.
- WebRTC receive FPS from `getStats()`.
- Decoded frames and dropped frames.
- Presented/rendered frames from `requestVideoFrameCallback()` metadata.
- Current monitor, window bounds, device scale factor, and whether the app spans monitors.

This prevents chasing a bad badge when the network stream is healthy, and it proves whether maximized grid size is still collapsing local presentation.

### Phase 2: Echo Display Authority

Add native client support for a preferred Echo display:

- Enumerate monitors with bounds, scale factor, refresh rate, and best available adapter/GPU identity.
- Remember the preferred display in client settings.
- On launch, move Echo to the preferred display before or during window setup.
- Maximize only on the preferred display.
- Warn when Echo is on the motherboard/Intel display or spanning displays.
- Keep the existing high-performance GPU preference as a host-level support measure, not the only fix.

This is a desktop-client binary change.

### Phase 3: Full-Quality Video Presentation Path

Keep the stream full quality and preserve the UI look, but make live screen video a protected surface:

- Avoid filters, backdrop filters, blend modes, repeated canvas readbacks, heavy clipping, or expensive shadows directly on the video element.
- Move visual effects to wrappers, overlays, or neighboring layers where they do not force video repaint work.
- Keep badges, borders, hover controls, glow, and polish as long as they do not damage the video presentation path.
- Remove the render-size cap from the intended product path, or keep it only behind an explicit debug/safe-mode flag.

This is a viewer-served change unless native WebView2 flags are also needed.

### Phase 4: Native Presenter Spike If WebView2 Is the Wall

If Echo is on the 4090 display, receives healthy frames, and still cannot present a maximized multi-screen grid smoothly through WebView2, investigate a native Windows presenter:

- A small Direct3D/DirectComposition proof of concept for one received screen tile.
- WebView2 remains the UI shell.
- Native presentation owns only the hot video surface if WebView2 cannot do it.

This is the higher-effort "perfection ceiling" path and requires desktop-client binary work.

## Testing Protocol

Sam's live testing rule stays in force:

- Before validating a new desktop-client build, close and reopen the Echo client.
- Do not silently monitor UI-dependent tests. Tell Sam exactly what to open/maximize and when monitoring starts.
- Test both non-maximized and maximized Echo on the preferred 4090 display.
- Compare WebRTC receive FPS against presented/rendered FPS.
- Do not run WGC monitor-capture experiments on Sam's daily-driver PC.

## Acceptance Criteria

- When a remote screen stream is healthy according to WebRTC stats, the visible screen tile should not collapse to low FPS just because Echo is maximized.
- Full stream quality remains available. No intended resolution, bitrate, or FPS downgrade is part of the fix.
- Echo can identify whether it is on the intended high-performance display path.
- The UI keeps its polished look, with any compositor-sensitive effects moved off the hot video surface rather than deleted outright.
- If WebView2 cannot meet the target, the next decision is a native presenter spike, not lowering stream quality.

## Current WIP Notes

- The `presentedFrames` diagnostic patch fits this design because it improves measurement.
- The render-size cap patch does not fit as final behavior. Treat it as diagnostic evidence that tile size affects the presentation bottleneck.
- The parked screen-source compatibility commits remain separate from this design.
