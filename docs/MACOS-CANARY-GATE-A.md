# macOS Apple Silicon Canary: Gate A Audit

Date: 2026-07-21

## Baseline

- Worktree: `F:\EC-worktrees\macos-client-canary`
- Branch: `codex/macos-client-canary`
- Baseline: `d6191a5fd212428ba4243f4e6e5af896d7dc627f` (`origin/main`)
- Baseline desktop/control version: `0.6.33`
- Live `/api/version`: `0.6.33`; live `/health`: healthy
- Live `EchoCoreHost` is running the control binary from
  `F:\EC-worktrees\main`, not this worktree. Gate A made no live changes.

The historical `origin/codex/macos-build-enable` branch and
`mac-audio-canary-0.6.11-1` tag are evidence only. Their useful implementation
is a five-line macOS bundle override, an isolated manual workflow, and a viewer
guard that disables RNNoise sender track replacement on macOS. The branch also
contains dated session/changelog material and must not be merged wholesale.

## Current architecture findings

- `core/client/Cargo.toml` correctly limits LiveKit/libwebrtc,
  `windows-capture`, and Windows APIs to `cfg(windows)`.
- `main.rs` has non-Windows stubs for process/system audio capture and output
  routing. Windows capture, presenter, placement, GPU, Spotify source-host, and
  capture-health state are compile-gated.
- Tauri already carries microphone/camera usage descriptions and camera/audio
  input entitlements. Its default bundle target remains Windows `nsis`, so Mac
  needs a separate config override rather than a default change.
- The shell loads the bundled viewer and injects `window.__ECHO_NATIVE__`.
  Viewer APIs are redirected to the configured Echo server.
- Browser mic/camera publishing and all remote media receiving use WebRTC and
  do not depend on Windows native capture.
- Native screen publishing prefers Windows IPC, but a missing
  `list_screen_sources` command already falls back to the browser display-media
  picker. That fallback is not accepted as reliable Mac screen/system-audio
  publishing without real-Mac validation.
- Native presenter and display-placement commands are Windows-only. macOS must
  remain on ordinary WebRTC video rendering and avoid treating missing native
  presenter commands as a media failure.
- Jam join/listen/control is viewer/server behavior. The Spotify source agent,
  local source-PC switches, WASAPI capture, and Spotify routing are deliberately
  Windows-only; `is_jam_source_host` already returns false elsewhere.
- The non-Windows output implementation returns no devices and treats changes
  as success. Viewer `setSinkId` support may provide routing in WKWebView, but
  this is an unverified Phase 1 runtime item, not parity evidence.
- The current updater endpoint is shared with the Windows release channel.
  Ad-hoc Mac canaries must not create updater artifacts or automatically enter
  that channel.
- `/api/client-stats-report` provides authenticated ephemeral health reporting.
  Calls to `/api/stats-log` are dead: no control route exists and failures are
  swallowed. There is no durable incident store, shared sanitizer, Mac spool,
  panic hook, exit sentinel, consent UI, or Admin Diagnostics view.

## Phase 0/1 feature matrix

| Capability | Gate A classification | Phase 0/1 action/evidence |
| --- | --- | --- |
| App bundle, launch, configured server | Needs thin Mac packaging | Separate `app,dmg` override; ad-hoc ARM64 CI build |
| Login, rooms, room switching | Expected now | Viewer regression tests plus real-Mac canary |
| Microphone, mute/unmute | Needs fallback | Disable RNNoise track swap on macOS; 30-minute real-Mac run |
| Camera | Expected now | Permission denial/grant and publish tests on real Mac |
| Remote audio/camera/screen receive | Expected now | Keep WebRTC rendering; platform-gate Windows presenter probes |
| Chat, themes, tools | Expected now | Viewer smoke test and canary checklist |
| Reconnect and sleep/wake | Expected, unproven on Mac | Automatic timeline plus real-Mac cycle tests |
| Output selection | Needs fallback/validation | Use WebKit capability when available; report unsupported behavior honestly |
| Jam join/listen/control | Expected now | Real-Mac listener/control test |
| Spotify Jam source host | Explicitly deferred/Windows-only | No Mac source credentials or native source agent |
| Screen publishing/system audio | Explicitly deferred | ScreenCaptureKit phase; browser picker is experimental only |
| Intel/universal build | Explicitly deferred | Apple Silicon only |
| Signing/notarization/Mac updater | Explicitly deferred | Ad-hoc DMG; isolated canary channel metadata |
| Automatic diagnostics | Missing, mandatory | Complete diagnostics PR before external DMG |

## Focused PR and release boundaries

### PR 1: Private diagnostics foundation

Release impact: **server deploy + server-served viewer update + desktop binary**.

- Versioned, authenticated incident envelopes with strict 256 KiB route limit,
  participant identity derivation/current-presence checks, rate limits,
  idempotency, deduplication, two-pass sanitization, 14-day retention, and a
  250 MiB cap.
- Extend live stats with bounded platform/build/permission/media health.
- Admin Diagnostics sessions/timelines/download/delete and explicit creation of
  a redacted GitHub issue; raw diagnostics never publish automatically.
- Structured viewer capture, Mac-canary consent/settings, authenticated upload,
  native atomic spool/panic/exit lifecycle, and acceptance-focused tests.
- Replace the dead `/api/stats-log` event path with the authenticated lane.

This PR must merge and deploy during a separately approved server window before
an external diagnostic canary can report successfully.

### PR 2: Apple Silicon packaging and media fallback

Release impact: **Mac desktop binary + server-served viewer update**. Windows
NSIS behavior and the Windows release workflow remain unchanged.

- macOS-only Tauri bundle override (`app`, `dmg`) with updater artifacts off.
- Disable RNNoise track replacement on desktop macOS and expose the reason.
- Explicit platform capability reporting/gating for presenter, screen publish,
  audio capture/output, updater, and Jam source-host behavior.
- Manual `workflow_dispatch` on standard `macos-latest`; read-only contents
  permission; short-lived DMG artifact; no release upload by default.

### Canary release

- Current-main Apple Silicon ad-hoc DMG only after PR 1 is deployed and PR 2
  passes GitHub compile/bundle verification.
- No normal Windows release dependency, `latest.json` change, signing,
  notarization, updater rollout, Intel build, or live service disruption.

## Gate A completion / Gate B order

1. Land diagnostics schema, sanitization, storage, abuse controls, and tests.
2. Add authenticated viewer collection and Admin Diagnostics.
3. Add native Mac spool, lifecycle/panic reporting, and explicit consent.
4. Add Mac bundle override, RNNoise fallback, and isolated manual workflow.
5. Run local Rust/viewer/control tests; run GitHub Mac workflow only when the
   branch is ready for a meaningful compile artifact.
6. During an approved window, deploy the server portion and validate malformed,
   oversized, stale, unauthenticated, duplicate, over-rate, and redaction cases.
7. Collect tester hardware facts, distribute the DMG, and execute permission,
   forced JS/native error, force-kill/relaunch, reconnect, and 30-minute mic
   acceptance tests.

## Approved web-first route

Sam approved a hardened browser canary as the first delivery route on
2026-07-21. This does not replace the native Apple Silicon track; it moves the
fastest low-risk compatibility evidence ahead of packaging and native work.

The first implementation slice is intentionally server-served viewer only:

- Disable the optional RNNoise sender-track replacement on desktop macOS and
  keep the direct microphone publication path.
- Keep Windows and other desktop platforms on their existing behavior.
- Add deterministic platform and preference regression coverage.
- Do not change the Windows native capture block, NSIS packaging, updater,
  control plane, live deployment, or running clients.

Follow-up slices remain separate review boundaries:

1. Conservative browser screen publishing with capability-based direct-track
   fallback and cleanup tests. Do not promise macOS system audio.
2. Truthful output-selection and browser-update UI based on actual browser
   capabilities, not broad platform assumptions.
3. A private diagnostics control-plane foundation, followed by an explicitly
   consented browser collector. Existing room/admin authentication is not a
   sufficiently private owner boundary for diagnostic access and must not be
   reused as though it were one.

The web route remains a server-served viewer release. Existing Windows desktop
clients also consume that viewer, so every change must be Mac- or
capability-gated and must retain the complete Windows viewer regression suite.

## External facts required before distribution

For Spencer and Jeff: exact Mac model/chip, macOS version/build, Terminal
comfort if Gatekeeper or launch fails, and which person is the primary first
canary tester.
