# Native Presenter Gate 1 Handoff

Date: 2026-05-02
Branch: codex/screen-sources-command-investigation
Worktree: F:\EC-worktrees\screen-sources-command

## What Changed

- Added a guarded Windows native presenter receive probe in the desktop client.
- Added hidden receive-only `$native-presenter` LiveKit token support.
- Added viewer opt-in setting plumbing with normal default `off`.
- Added native receive FPS/status telemetry to client stats and the admin dashboard.
- Kept WebView2 as the visible rendering path.

## Why This Exists

Sam's low-FPS symptom tracks with the maximized viewer/grid presentation path, not with the remote stream quality itself. Gate 1 tests the next important question: can the Windows client receive the same screen track through native LiveKit/WebRTC code at healthy FPS while WebView2 remains visibly rendering the current UI?

## What This Proves

Gate 1 proves whether the desktop client can safely join as a hidden receive-only companion and receive the selected screen track natively without disturbing the normal viewer.

## What This Does Not Do

- It does not draw native video.
- It does not hide or replace the WebView2 video element.
- It does not reduce stream quality.
- It does not deploy to friends.
- It does not change the normal default for users; the native presenter setting remains `off`.

## Implementation Commits

- `74cfda2 feat(client): add native presenter state model`
- `a928c02 feat(control): issue receive-only native presenter tokens`
- `618a984 feat(client): expose native presenter ipc`
- `7a8ac3a feat(viewer): add guarded native presenter bridge`
- `7784f36 feat(control): report native presenter telemetry`
- `66506eb feat(client): receive native screen frames`

## Verification

Fresh verification run on 2026-05-02:

- `node --test core/viewer/*.test.js` - 63 passed, 0 failed.
- `cargo test -p echo-core-client native_presenter` - 8 passed, 0 failed.
- `cargo test -p echo-core-control auth::tests` - 3 passed, 0 failed.
- `cargo test -p echo-core-control admin::tests` - 1 passed, 0 failed.
- `cargo check -p echo-core-client -p echo-core-control` - passed.
- `cargo build -p echo-core-client` - passed.

The Rust commands still emit existing warnings from the local LiveKit/libwebrtc/client/control code, but the commands exited successfully.

## Local Test Protocol

Do not silently monitor or relaunch Echo. Tell Sam first.

1. Close Echo before testing a new desktop build.
2. Open the branch debug client from `F:\EC-worktrees\screen-sources-command\core\target\debug\echo-core-client.exe`.
3. Confirm the running client path before monitoring.
4. Enable the native presenter setting only for Sam's local test.
5. Join a room with one remote screen share.
6. Confirm the dashboard native presenter status shows `starting` then `receiving`.
7. Compare WebView receive FPS, WebView presented FPS, and native receive FPS.
8. Turn the setting off and confirm status returns to WebView2/stopped without restarting.

## Manual Pass Criteria

- The native presenter remains hidden from normal participants.
- The dashboard shows native presenter `receiving` for the selected screen track.
- Native receive FPS is plausible for the stream.
- Turning the setting off stops the native probe without restarting Echo.
- WebView2 remains the visible fallback at all times.

## Next Decision

If native receive FPS is healthy while WebView presented FPS remains low in maximized 4K mode, proceed to the Gate 2 one-tile native presentation plan.

If native receive FPS is also low, stop Gate 2 and investigate the receive/network/SFU path instead.

## Known Local State

`core/viewer/index.html` has generated cache-busting stamp churn from local server/test activity. Do not stage that churn unless the script tag itself is intentionally being changed.
