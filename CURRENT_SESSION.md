# Echo Chamber - Current Session Notes

**Last Updated**: 2026-04-02
**Current Version**: v0.4.3 (client Cargo.toml) / v0.4.1 (last released)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** — needs full guidance, do NOT ask him to run commands
- **FULL AUTONOMY**: Claude has full permission for ALL local operations — file edits, builds, process management, local git commits. Do NOT prompt Sam for confirmation on local work.
- **NEVER push to GitHub** for server-side updates. GitHub pushes are ONLY for client releases via version tags.
- Focus ONLY on `/core` folder — `/apps` is legacy
- **Tauri client loads viewer from server** — viewer file changes are live on client refresh (no rebuild needed)
- **Use US English** — Sam requested American spelling ("color" not "colour")
- **Sam trusts Claude fully** — "I trust you. You don't have to ask this moving forward. I have you set to auto accept edits"

---

## What Changed Today (2026-04-02) — MAJOR DIAGNOSTIC + ARCHITECTURE SESSION

### Screen Share FPS Investigation — ROOT CAUSE FOUND

**Problem**: Spencer's screen share choppy for Sam. Sam's OWN screen share shows 4-5fps when gaming.

**Diagnosis path** (in order of discovery):
1. **SFU subscriber throttling** — SFU's TWCC-based BWE gave garbage estimates on localhost, throttling Sam's subscriber to 93kbps. **Fixed**: stripped TWCC from SDP for localhost connections.
2. **Packet loss on SFU→Sam path** — With TWCC stripped, full bitrate flows but ~1% packet loss causes freezes. RTX retransmission broken (`rtxSsrc=0`). **Fixed**: tightened PLI throttle from 500ms → 200ms.
3. **Canvas pipeline bottleneck** — `drawImage()` only takes 1.5ms (NOT the bottleneck). Source capture IS the bottleneck.
4. **getDisplayMedia source rate** — Only produces 5fps when game has focus. **ROOT CAUSE**: Chromium/Edge throttles ALL canvas capture APIs (`captureStream`, `requestFrame`, `captureStream(30)`) when WebView is backgrounded by a game window.
5. **Tried MediaStreamTrackGenerator** — Bypasses captureStream, writes VideoFrames directly. Got 17fps with frame pump but lag from blocking writes.
6. **Fundamental conclusion**: No JavaScript workaround can bypass Chromium's background throttling. Need native capture.

### Native Screen Capture — IN PROGRESS (compiles!)

**Architecture**:
```
LiveKit Rust SDK (WGC capture) → libwebrtc H264 encoder (MFT→NVENC) → RTP → SFU
```

**What's built and compiling**:
- `core/client/Cargo.toml` — Added `livekit` v0.7 + `windows-capture` v1.5
- `core/client/src/screen_capture.rs` — **NEW** module: WGC capture → BGRA→I420 → LiveKit publish
- `core/client/src/main.rs` — IPC commands: `list_screen_sources`, `start_screen_share`, `stop_screen_share`
- **Build succeeds** on Rust 1.93 stable (warnings only, no errors)

**Dual-identity approach**: WebView connects as `sam-7475` (camera/chat), Rust connects as `sam-7475$screen` (screen share only). Frontend merges `$screen` identities visually.

**Still needed (next session)**:
1. `$screen` token endpoint in control plane (`core/control/src/main.rs`)
2. Frontend integration — native capture picker in `screen-share.js`, `$screen` identity merging in `participants.js`
3. windows-capture handler is skeleton — needs real WGC start/callback wiring (the Settings::new and start_free_threaded calls compile but the callback flow needs testing)
4. Test with actual game running in fullscreen/borderless
5. Cleanup diagnostic overlays from this session

### Other Fixes Applied

- **Admin kick/mute buttons missing** — `config.json` was `{"admin": true}` (ignored), fixed to `{"server": "https://127.0.0.1:9443"}`. Admin mode now detects localhost correctly.
- **SFU PLI throttle** — Changed from 500ms to 200ms for all quality levels in `core/sfu/livekit.yaml`
- **SFU restarted** with new config (PID changed)
- **TWCC stripping** — Added `_stripTWCC()` function in `connect.js` that removes both the TWCC RTP header extension AND the `transport-cc` RTCP feedback line from SDPs. Only applied when SFU is localhost.
- **Screen share encoding** — `connect.js` publishDefaults changed from 8Mbps → 5Mbps (but `screen-share.js` overrides with its own config anyway)
- **playoutDelayHint** — Changed from 0 to 0.15 (150ms) for remote screen shares in `audio-routing.js`

---

## DIRTY FILES (experimental, need cleanup)

These files have diagnostic/experimental code from the debugging session:

### `core/viewer/screen-share.js` — HEAVILY MODIFIED
- Canvas cap reduced: MAX_CANVAS_WIDTH 1920→1280, MAX_CANVAS_PIXELS 2.1M→960K
- `getScreenSharePublishOptions()` — reverted to original 3-layer simulcast
- Canvas pipeline has experimental MediaStreamTrackGenerator code (lines ~800-910)
- Encoder diagnostic overlay (`_enc-diag` div) — shows fps/bitrate/limit per layer + draw timing
- Frame timing diagnostics in processor loop (`window._drawTimings`)
- **RECOMMEND**: Revert to git HEAD and only keep the native capture path going forward

### `core/viewer/participants.js` — DIAGNOSTIC OVERLAY
- `attachVideoDiagnostics()` has expanded WebRTC receiver stats (kbps, lost, dec, drop, nack, pli, fir, jbuf, freeze)
- **RECOMMEND**: Keep the expanded stats (useful), remove when native capture is working

### `core/viewer/connect.js` — TWCC STRIPPING
- Added `_stripTWCC()` function + localhost detection
- SDP hooks apply TWCC stripping to both setLocalDescription and setRemoteDescription
- Also strips `a=rtcp-fb:N transport-cc` lines
- **KEEP**: This fix is correct for localhost subscriber throttling

### `core/sfu/livekit.yaml` — PLI THROTTLE
- All PLI throttles set to 200ms (was 300/500/500)
- **KEEP**: Faster keyframe recovery with broken RTX

---

## Active Worktree
- `.claude/worktrees/quirky-cray` — native screen capture development

---

## Key Files Modified This Session

### New Files
- `core/client/src/screen_capture.rs` — Native WGC + LiveKit Rust SDK screen capture module

### Modified
- `core/client/Cargo.toml` — Added `livekit` + `windows-capture` dependencies
- `core/client/src/main.rs` — Added `mod screen_capture`, 3 IPC commands
- `core/viewer/connect.js` — TWCC stripping, SDP hooks
- `core/viewer/screen-share.js` — Diagnostic overlays, experimental pipeline changes
- `core/viewer/participants.js` — Expanded diagnostic overlay
- `core/viewer/audio-routing.js` — playoutDelayHint 0→0.15
- `core/sfu/livekit.yaml` — PLI throttle 500→200ms
- `core/target/debug/config.json` — Fixed to `{"server": "https://127.0.0.1:9443"}`

---

## Plan File
- `C:\Users\Sam\.claude\plans\transient-discovering-rocket.md` — Full native capture implementation plan (approved)

---

**When resuming:**
1. Read this file first
2. Read the plan file for the native capture implementation
3. The `screen_capture.rs` compiles but the WGC capture callback needs real testing
4. Next steps: $screen token endpoint → frontend integration → test with game
5. The viewer JS files have diagnostic code that should be cleaned up after native capture works
