# Echo Chamber - Current Session Handover

**Last Updated**: 2026-04-07 (late evening — after cursor work attempted + reverted)
**Current Version**: v0.6.1 (released), v0.6.2 **VALIDATED AND READY TO SHIP**
**Branch**: `claude/v0.6.2-ship` in main repo. THREE commits banked:
  - `8d21a3b` — main / v0.6.1 baseline (untouched)
  - `1dc7f98` — proven wins + DXGI reinit hotfix + NVENC level autoselect
  - `6c6d6ae` — feat: cursor compositing (**superseded by next commit, do NOT ship as-is**)
  - **next commit pending**: revert of cursor work back to `1dc7f98` baseline
**Release branch**: `release/v0.6.2` on GitHub is **STILL STALE** (the broken WGC state from prior session). Must be force-updated before release.
**Tag**: `v0.6.2` on GitHub is also **STILL STALE**. Must be force-moved to the clean commit.

**Ship target**: the post-revert commit (next commit on top of `6c6d6ae`). Equivalent to `1dc7f98` content-wise but with cleaner git history including the failed cursor experiment for posterity.

## ⚠️ READ THIS FIRST

**v0.6.2 is now remotely validated and ship-ready.** This session:
1. Completed phase 2 remote validation with a real external friend (David over WAN)
2. Validated every proven win from the prior session
3. Fixed a latent capture-loop crash bug that would have killed shares anyway
4. Made partial progress on the NVENC 144fps init issue (research-driven, not bisecting)
5. Left ALL work in the main repo working tree, NOT YET COMMITTED
6. Did NOT push anything to GitHub

The next session should:
1. Read this whole document
2. Verify working tree state matches "IN-FLIGHT FILES" below
3. Decide whether to commit to `funny-davinci` or a fresh branch (recommendation: funny-davinci, linear history)
4. Decide whether to force-update the stale `release/v0.6.2` branch + `v0.6.2` tag on GitHub, or create new names (recommendation: force-update, the stale ones are broken)
5. Only then cut the actual release, sign, and update `latest.json`

## Session outcome in one line

> All proven wins from the prior session are now remotely validated with a real friend over WAN. Capture crash hotfix added. v0.6.2 ready to ship pending commit + tag force-update.

---

## ✅ PROVEN WINS (now remotely validated)

These are the same wins the previous session listed, but now with **real external validation data** from David (WAN friend) and SAM-PC (LAN test machine), not self-view.

### 1. Full-duplex sfu_proxy.rs rewrite
**Status**: **VALIDATED WAN + LAN**. `proxy:17` (Sam's `$screen` publisher) survived **1299.9 seconds (21.7 minutes)** of continuous WAN traffic to David, closed cleanly on user-initiated stop-share with `c2s_exit=client-close, s2c_exit=peer-shutdown`, 286 client→SFU messages, 288 SFU→client messages. Zero cycling events during the entire David+SAM-PC+Sam multi-client session. Prior behavior was 10-15 second cycles.

**File**: `core/control/src/sfu_proxy.rs` (296 lines)
**⚠️ Deployment correction**: the prior session's handover said this was "verified in production" but the main repo working tree actually had the OLD 124-line half-duplex version. Only the `funny-davinci` worktree had the fix committed. **This session copied the fix into main and rebuilt control plane.** The fresh control plane binary is the one currently running.

### 2. Min 2.5 Mbps bitrate floor for $screen GoogCC
**Status**: **VALIDATED WAN**. Observed under David's WAN conditions: BWE started at ~4 Mbps probe, held at the 2.5 Mbps floor during early uncertainty, then climbed to 19.8 Mbps as network stabilized. Without the floor, initial GoogCC overshoot would have dropped target to near-zero and taken much longer to recover. This is the fix that kept David's stream alive during the first 30 seconds.

**Files**:
- `core/Cargo.toml` (libwebrtc patch)
- `core/libwebrtc-local/` (vendored crate, added `min_bitrate` field to `RtpEncodingParameters`)
- `core/livekit-local/src/room/options.rs` (`VideoEncoding.min_bitrate` field)
- `core/livekit-local/src/rtc_engine/peer_transport.rs` (SDP hint at 0.125)
- `core/client/src/capture_pipeline.rs` (`min_bitrate: 2_500_000`)

### 3. HDR linear→sRGB gamma correction in GPU shader
**Status**: **VALIDATED WAN (the big one)**. David reported "image is good" while watching Sam's screen share on his local display. This is the first ever non-self-view, non-SAM-PC validation of the gamma fix, and it's the single most important proven win because self-view was totally unreliable for color judgment.

**File**: `core/client/src/gpu_converter.rs`
**Verified log output**: `[gpu-converter] initialized: 3840x2160 DXGI_FORMAT(10) → 1920x1080 BGRA8 (hdr=true)` — Sam's display is HDR, the shader detected it, applied linear→sRGB, David saw correct colors.

### 4. NVENC LOW_LATENCY tuning + spatial+temporal AQ + 1 second VBV
**Status**: **VALIDATED WAN**. David reported text/image quality "good" — no smearing during his 30fps viewing session. Combined with the VUI tagging below, this fixes the "blob smearing" symptom the prior session identified.

**File**: `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp`

### 5. VUI BT.709 colorspace tagging
**Status**: **VALIDATED WAN**. Part of the "image is good" David report above. Decoders now use the matching inverse matrix for our libyuv BT.601-limited Y'CbCr output.

### 6. Aspect ratio preservation in GPU shader
**Status**: Inherited from prior session, not specifically stressed this session but not regressed.

### 7. Screen share chime / grid layout / CSS fixes
**Status**: Inherited, not stressed this session but not regressed. Multi-participant session with 3 clients (Sam + SAM-PC + David) exercised the grid layout code path.

### 8. Screen tile grid 2x2 bias
**Status**: Same as above.

---

## 🆕 NEW WORK THIS SESSION

### HOTFIX: DXGI Desktop Duplication capture loop reinit on stall
**Problem observed**: During the first David test, Sam's screen share crashed twice in a row at different frame counts (1591 and 7413). Symptom was a sustained backpressure pattern followed by `[desktop-capture] 50 consecutive timeouts, stopping` — the capture loop bailed instead of recovering, killing the entire share and requiring the user to click Share Screen again.

**Root cause**: The capture loop in `core/client/src/desktop_capture.rs` had two bail-out branches for recoverable DXGI errors that should have been reinit branches:
1. `DXGI_ERROR_WAIT_TIMEOUT` × 50 consecutive (about 5 seconds of stall) → bailed instead of reinitializing
2. `DXGI_ERROR_ACCESS_LOST` (desktop switch, UAC, mode change) → bailed instead of reinitializing

This was a pre-existing latent bug that hadn't manifested in normal single-receiver LAN testing but triggered under multi-client WAN load (exact mechanism still unconfirmed — likely GPU contention from simultaneous capture + shader + encode + WebRTC publish).

**Fix**: Extracted the duplication creation code into a local closure `create_duplication()` that can be called multiple times. On 50 consecutive timeouts or on `ACCESS_LOST`, the code now drops the old duplication interface and creates a fresh one, resetting the counter and continuing. Viewers see a brief ~5 second stall, then the stream self-recovers. This is what OBS and other production screen capture consumers do.

**File**: `core/client/src/desktop_capture.rs` (~60 new lines)

**Testing status**: Deployed, **hasn't fired in anger** — the session's second David test ran for 118,244 frames (21.7 minutes) without triggering either recovery branch. The hotfix is safe and idle, not exercised. Proper validation will come if and when the stall conditions recur.

### PARTIAL: NVENC 144fps init level fix
**Problem**: `nvEncInitializeEncoder` fails with `NV_ENC_ERR_INVALID_PARAM (code 8)` when `frameRateNum > 60`. Prior session tried 9 different approaches, all failed, and deferred with "read OBS jim-nvenc source."

**Research done this session**:
1. Fetched OBS Studio's current NVENC encoder source (`plugins/obs-nvenc/nvenc.c`) via WebFetch
2. Built a field-by-field comparison of `NV_ENC_INITIALIZE_PARAMS` and `NV_ENC_CONFIG.encodeCodecConfig.h264Config` between OBS's working pattern and our code
3. **Key finding**: The SDP WebRTC factory negotiates `profile-level-id=42e01f`, which decodes to H.264 Level 3.1 (max 720p30). Our code was piping that level straight into `nv_encode_config_.encodeCodecConfig.h264Config.level` via `nv_enc_level_`. Level 3.1 is invalid for 1080p at ANY framerate — NVENC was lax at 60fps but strict at 144fps.
4. OBS never sets `h264Config.level` explicitly — it uses `NV_ENC_LEVEL_AUTOSELECT` so NVENC picks a level matching actual resolution + framerate.

**Fix applied**: Changed `h264_encoder_impl.cpp` line ~250 to force `NV_ENC_LEVEL_AUTOSELECT` regardless of SDP-negotiated level. The SDP level is still declared in the peer-facing SDP (separate concern), the encoder just no longer tries to enforce an incompatible level internally.

**Test result**: Level fix made it through — init dump at 144fps showed `h264.level=0` (AUTOSELECT applied correctly) — but **init still failed** with the same INVALID_PARAM error. Reverted `max_framerate` to 60.0 in `capture_pipeline.rs`, level fix stays in place (harmless at 60fps, progress toward future 144 retry).

**Next session TODO**: There's at least one more field differing between OBS's pattern and ours. The init param dump (next section) gives concrete data to continue the diff. Suspects I didn't get to test: `darWidth/darHeight` explicit set, `enableFillerDataInsertion=1` for CBR, `sliceMode=3/sliceModeData=1`, `maxBitRate` explicit for CBR.

**Files changed this session for this fix**:
- `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` — `h264Config.level = NV_ENC_LEVEL_AUTOSELECT`
- Same file — added one-shot init param dump block (see next section)

### NEW: NVENC init param dump diagnostic
Added permanent one-shot logging of all `NV_ENC_INITIALIZE_PARAMS` and `NV_ENC_CONFIG` fields immediately before the `nvEncInitializeEncoder` call. Fires once per encoder lifetime, negligible log noise, critical for future NVENC debugging because we never had visibility into actual init param values on the failure path before this session.

Sample output captured during 144fps failure test:
```
[NVENC] InitEncode params dump:
  encodeWidth=1920 encodeHeight=1080
  darWidth=0 darHeight=0          ← NOT SET, suspect for next session
  maxEncodeWidth=1920 maxEncodeHeight=1080
  frameRateNum=144 frameRateDen=1
  enableEncodeAsync=0 enablePTD=1
  tuningInfo=6 bufferFormat=...
  config.gopLength=4294967295 frameIntervalP=1
  rc.rateControlMode=2 averageBitRate=10000000
  rc.maxBitRate=0                  ← NOT SET, suspect for next session (CBR should match avgBitRate)
  vbvBufferSize=10000000 vbvInitialDelay=10000000
  rc.enableAQ=1 aqStrength=8 enableTemporalAQ=1
  h264.level=0                     ← AUTOSELECT applied ✅
  idrPeriod=4294967295 maxNumRefFrames=0
  h264.sliceMode=0 sliceModeData=0    ← OBS uses 3/1
  enableFillerDataInsertion=0      ← OBS sets 1 for CBR
```

**File**: `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` — ~40 lines of dump code immediately before the `encoder_->CreateEncoder` call.

---

## 🔬 NEW FINDINGS (mechanisms understood but not yet fixed)

### A. Cross-subscriber interference cascade (PLI storm hypothesis)
**Symptom**: When SAM-PC joined mid-stream during the David test, David's FPS also degraded. Adding a new subscriber to an existing `$screen` publish impacted ALL subscribers, not just the joining one.

**Hypothesized mechanism** (NOT confirmed with instrumentation):
1. SAM-PC subscribes to `sam-7475$screen` track
2. SAM-PC's decoder falls behind (hardware limit or packet loss)
3. SAM-PC sends NACK/PLI upstream asking for a keyframe
4. SFU forwards PLI to publisher (Sam)
5. NVENC is forced to generate a keyframe (big I-frame, 5-10× P-frame size)
6. Bitrate spike triggers publisher-side BWE congestion signal
7. Publisher BWE drops for ALL subscribers because we publish single-layer (`simulcast: false`)
8. David's received FPS drops because the upstream rate dropped for everyone

**Why simulcast is NOT the recommended fix**: Sam has prior experience with LiveKit H.264 simulcast crashing or killing performance. Don't repeat that path without understanding why it failed before.

**Recommended investigation for v0.6.3+**:
1. First: verify the hypothesis. Grep LiveKit SFU logs for PLI forwarding events timed to SAM-PC's join event. If PLI storm is real, proceed. If not, build a new hypothesis.
2. Research LiveKit SFU config for PLI rate-limiting. LiveKit may have a `rtc.pli_throttle` or equivalent knob that rate-limits keyframe requests from struggling subscribers so they can't storm the publisher.
3. Alternative: finite GOP length on NVENC (currently `NVENC_INFINITE_GOPLENGTH`). A 2-second scheduled GOP means PLI requests can often land on already-scheduled keyframes without forcing an extra I-frame burst.
4. Alternative: lower `max_bitrate` from 20M to ~12M. Doesn't fix the cascade but reduces its absolute magnitude.

**Do NOT try simulcast again in v0.6.3.** If simulcast ever becomes the right answer, it needs its own session, proper instrumentation first, and understanding of what crashed it historically.

### B. NVENC init-at-60 / capture-at-143 metadata mismatch (the 3-minute recovery theory)
**Observation**: Prior session reported a 3+ minute recovery time after stop-share/restart-share on publish. This session confirmed the pattern (reproduced once with David).

**Hypothesis (still just a theory)**:
- NVENC initialized with `frameRateNum=60` but capture is pushing 143fps
- Per-frame bit budget computed from init value = `20M / 60 = 333 kbit/frame`
- 333 kbit/frame × 143 frames/sec = 47.7 Mbit/sec effective output (2.4× over CBR target)
- Pacer throttles → packets queue → NACK storms → receiver jitter buffer thrashes
- WebRTC's rate controller eventually calls `SetRates` with real fps (142) — we can see this in the log as `SetRates #N: fps=142`
- Only after many SetRates calls does the per-frame budget converge to ~140 kbit/frame and the over-pacing stops
- That convergence is what takes 3 minutes

**This is why fixing NVENC 144 init actually matters** — not just for cleaner source code, but because the workaround (init at 60, ignore the fps mismatch at runtime) has a real user-visible cost. Prior session called this "the biggest unsolved issue" but framed it as init cleanup. It's more than that.

### C. DXGI DD capture bail pre-existing bug
See hotfix section above. Bug was real, in the code since whoever wrote the capture loop, never triggered until today's multi-client WAN test.

### E. Cursor compositing — ATTEMPTED AND REVERTED
**Tried this session**, after the David validation, as a Phase 5 add-on to v0.6.2.
Implementation went smoothly: ~250 lines in `desktop_capture.rs` (CursorCache struct + composite_cursor helper + per-frame DXGI pointer query + GPU/CPU path integration). Build was clean first try. Sam confirmed "I can see the cursor" on first verification and the commit landed (`6c6d6ae`).

**Then performance crashed.** Capture FPS degraded from steady 91-143fps → 70fps → 40fps → 4fps over a few minutes. Memory grew from 166MB → 320MB+. Cause: the GPU path's new copy from D3D11 mapped staging memory into `scale_buf` (required so we could write the cursor pixels into it) was reading 8MB/frame from memory that's much slower to read from CPU than regular RAM. Tried optimizing with single `ptr::copy_nonoverlapping` instead of row-by-row — still crashed FPS. Tried reverting the GPU path entirely (`push_frame_strided` zero-copy as before) but keeping the cursor query block — STILL caused gradual FPS degradation, suggesting per-frame `GetFramePointerShape` overhead OR something subtler.

**Final action this session**: reverted the cursor query block AND the CPU path composite ENTIRELY. The helper `CursorCache` struct and `composite_cursor()` function REMAIN in the file as dead code (silenced via `let _ = composite_cursor;`) for v0.6.3 reuse. Commit `6c6d6ae` is on the branch but is **superseded by the revert commit on top of it** — anyone shipping v0.6.2 should ship the post-revert state, NOT `6c6d6ae`.

**The right architecture for v0.6.3 cursor compositing**:
- Composite cursor INSIDE the GPU compute shader in `gpu_converter.rs`, not on the CPU side
- Pass cursor pixels as a small shader resource view (texture)
- Pass cursor position + size as constants
- HLSL shader blends cursor in-place during the HDR→SDR + downscale pass
- Output already-composited BGRA → existing zero-copy CPU read path stays unchanged
- This preserves zero-copy AND gets cursor on HDR captures
- Estimated complexity: 2-4 hours of HLSL + Rust shader-binding work
- Per-frame DXGI pointer query is fine if it only runs when shape actually changes — investigate why per-frame poll seemed to degrade performance even after zero-copy was restored

### F. Multi-reshare crash / WebView2 zombie accumulation — NEW THIS SESSION
**Symptom**: After 4-6 cycles of stop-share / start-share within a single client session, the Tauri client window enters a "Not Responding" state with hung UI thread (`tasklist /V` shows status `Not Responding` and very low CPU time). The capture/encode background thread continues running and producing frames, but the WebView2 display can't render — including the FPS indicator, the self-preview tile, and any banners. From the user's perspective the FPS appears to drop to 0 because the viewer can't paint.

**Root cause hypothesis**: orphan `msedgewebview2.exe` child processes accumulate across rapid client kill/restart cycles. We observed 6 zombie WebView2 processes (sizes 9MB, 21MB, 40MB, 68MB, 94MB, 123MB) hanging around after multiple `wmic process delete` operations. WebView2 runtime gets confused when too many stale instances exist.

**Confirmed mitigation**: hard-killing the hung client (`taskkill /F /PID <pid>`), waiting 3-5 seconds for Windows to release WebView2 references, then launching fresh resolves the issue. Each fresh client launch creates a new clean WebView2 instance.

**Recommended v0.6.3 fix**:
1. On client startup, scan for orphan `msedgewebview2.exe` processes whose parent is no longer alive and kill them (carefully — don't kill Edge browser instances)
2. OR call WebView2's `clear_cache_on_upgrade()` more aggressively
3. OR add a watchdog: if the Tauri main thread hasn't ticked in N seconds, self-restart the client process
4. OR investigate why WebView2 isn't reaping its own zombies — may be a Tauri issue

**Sam asked specifically** for "some kind of safety net" against this. Real ask. Worth doing.

### D. David's game audio missing
**Observation**: When Sam watched David's Grind Survivors stream, David's game audio was not coming through.

**Likely cause**: David is running v0.6.1 (or earlier) — whatever he had installed. His client binary does NOT have any of today's work, nor any audio capture fixes that may have landed between v0.6.1 and now. Per-process WASAPI audio capture needs build 20348+ (Win11) and can be finicky.

**Not investigating tonight.** Plan: after David gets v0.6.2 via auto-updater, retest his audio path with a clean run. If it's still broken on v0.6.2, that's when to investigate.

---

## ❌ STILL UNFINISHED (deferred from prior session + this session)

### A1. NVENC 144fps init — PARTIAL PROGRESS
- Level fix applied (`AUTOSELECT`), verified via init dump
- Init still fails at 144 → at least one more field difference vs OBS
- Init param dump gives concrete data for next session's diff
- Suspects to try: `darWidth/darHeight` explicit, `enableFillerDataInsertion=1` for CBR, `sliceMode=3/sliceModeData=1`, `maxBitRate = averageBitRate` for CBR, check `NvEncoder::CreateDefaultEncoderParams` in the NVIDIA SDK source to understand what it's already setting
- Recommended approach: apply OBS pattern WHOLESALE (all four suspects at once), re-test, if success narrow down later; don't bisect one change at a time

### B. Cursor visibility in entire-screen capture
- Unchanged from prior session
- Safe path: composite cursor into DXGI DD frames via `frame_info.PointerPosition` + `GetFramePointerShape` + alpha blend on `scale_buf`
- **DO NOT** use WGC monitor capture (see DO NOT TOUCH section)

### C. Self-view decode artifacts
- Unchanged from prior session — known self-view unreliable
- Remote validation this session has superseded self-view as the primary quality reference

### D. Infinity mirror when sharing the monitor displaying the viewer
- Unchanged from prior session. Sam workaround: move Echo Chamber to the other monitor before sharing.

### E. Cross-subscriber interference cascade
- NEW this session — see findings A above. PLI storm hypothesis not yet verified.

### F. David's game audio
- NEW this session — see findings D above. Retest after David gets v0.6.2.

---

## ⛔ DO NOT TOUCH (caused real damage in prior session)

**Unchanged from prior session. Copying verbatim because the warning is still critical.**

**WGC monitor capture testing on Sam's daily driver.** Prior session triggered a display driver flicker that persisted through:
- Killing all Echo Chamber processes
- `Win+Ctrl+Shift+B` (display driver reset)
- Sign out + sign back in

It only resolved after a full reboot. The cause was almost certainly `windows-capture::Monitor` capture in `Rgba16F` mode interacting with Sam's specific 4K HDR + 144Hz + dual-monitor setup.

**Rules:**
- Do NOT call `start_screen_share_monitor` from the JS without explicit isolated setup
- Do NOT enable WGC monitor capture testing on Sam's main PC — use SAM-PC or a VM
- Cursor compositing into DXGI DD frames is the safer first attempt for v0.6.3

---

## 🔄 IN-FLIGHT FILES (main repo working tree, NOT YET COMMITTED)

As of session end, the main repo working tree has these uncommitted changes relative to `main` branch HEAD (`8d21a3b`):

```
M CURRENT_SESSION.md                                    (this file)
M core/Cargo.lock                                        (libwebrtc-local patch)
M core/Cargo.toml                                        (libwebrtc-local patch)
M core/client/src/capture_pipeline.rs                    (min_bitrate, max_framerate=60, comments)
M core/client/src/desktop_capture.rs                     (**NEW HOTFIX: reinit on timeout/access-lost**)
M core/client/src/gpu_converter.rs                       (HDR gamma + aspect preservation)
M core/client/src/main.rs                                (dead start_screen_share_monitor command)
M core/client/src/screen_capture.rs                      (dead WGC monitor capture)
M core/control/src/sfu_proxy.rs                          (**DEPLOYED fresh this session**: full-duplex rewrite)
M core/deploy/config.json                                (LAN IP for SAM-PC testing — RESTORE TO DOMAIN BEFORE SHIP)
M core/livekit-local/src/room/options.rs                 (VideoEncoding.min_bitrate field)
M core/livekit-local/src/rtc_engine/peer_transport.rs    (SDP hint at 0.125)
M core/viewer/grid-layout.js                             (2x2 bias)
M core/viewer/index.html                                 (version stamp by control plane on startup)
M core/viewer/screen-share-native.js                     (reverted to DXGI DD)
M core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp (LOW_LATENCY + AQ + 1s VBV + VUI + LEVEL=AUTOSELECT + INIT PARAM DUMP)
?? core/libwebrtc-local/                                 (vendored crate, entire directory untracked)
?? tools/clumsy/                                         (network throttling tool, untracked)
```

**Key difference from prior handover's in-flight list:**
- `core/control/src/sfu_proxy.rs` is NEW in main's working tree — prior session had this committed only in the `funny-davinci` worktree. This session copied it to main and rebuilt control plane.
- `core/client/src/desktop_capture.rs` is NEW — the capture loop reinit hotfix
- `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` has the new `h264.level = NV_ENC_LEVEL_AUTOSELECT` + init param dump on top of prior session's LOW_LATENCY/AQ/VBV/VUI changes
- `core/deploy/config.json` was changed from domain URL → LAN IP for SAM-PC push-build testing. **Must be restored to domain URL before shipping** or future push-build deployments will go to the wrong address.

---

## 🎯 Recommended fresh session plan (pure ship work)

### Phase 1: Commit and verify (~15 min)
1. Read this whole document
2. Restore `core/deploy/config.json` to the domain URL (`https://echo.fellowshipoftheboatrace.party:9443`) — it's currently the LAN IP from this session's SAM-PC test
3. Verify all files in the in-flight list above are actually present and match expectations
4. Run `cargo check` in `core/` to verify nothing is broken
5. Commit all working tree changes to `claude/funny-davinci` worktree (or a fresh ship branch if you prefer) with a clear message like `fix: v0.6.2 final — DXGI capture reinit + NVENC level autoselect + remote-validated proven wins`
6. Do NOT push yet

### Phase 2: Update changelog (~10 min)
Update `core/viewer/changelog.js` with a v0.6.2 entry covering:
- Screen share stability (proxy full-duplex, DXGI reinit recovery)
- Image quality (HDR gamma fix, NVENC tuning, colorspace tagging)
- Stream recovery (2.5 Mbps bitrate floor prevents 0fps drops)
- Grid layout fixes, chime fixes, fullscreen button CSS
- Known limitation: cursor not visible in entire-screen share (will fix in v0.6.3)
- Known limitation: cross-receiver interference when a slow subscriber joins (will fix in v0.6.3)

The "What's New" popup fires on version change so friends will see this on auto-updater.

### Phase 3: Version and tag (~5 min)
1. Verify `Cargo.toml` and `tauri.conf.json` both say `0.6.2` (per prior session they should already)
2. If force-updating the stale tag: `git tag -f v0.6.2` on the new commit
3. If creating a new tag: `v0.6.2a` or similar (less clean)

### Phase 4: GitHub push (DESTRUCTIVE — needs explicit Sam confirmation)
Show Sam the exact commands, wait for "yes", then execute:
```bash
git push origin claude/funny-davinci
git push --force-with-lease origin refs/tags/v0.6.2          # ⚠️ DESTRUCTIVE
git push --force-with-lease origin release/v0.6.2            # ⚠️ DESTRUCTIVE if release branch is updated
```

**Rationale for force-update over new names**: the stale `v0.6.2` tag on GitHub right now points to a broken commit. Any friend who pulls `v0.6.2` gets a broken version. Leaving it in place is actively bad. Force-update is the responsible fix. Alternative is to bump to v0.6.3, but that's pre-mature — v0.6.3 should be the next REAL release with cursor + NVENC 144 + cross-receiver fixes.

### Phase 5: Sign + latest.json + CI (~20 min)
Standard release workflow — whatever Sam's normal process is. CI is `workflow_dispatch` for builds + tag-triggered for releases per the project CLAUDE.md.

---

## 🔮 v0.6.3 candidates (for the session AFTER the one that ships v0.6.2)

In no particular order, pick ONE per session:
1. **NVENC 144fps init (resume research)** — init param dump is in place, apply OBS pattern suspects wholesale, retest
2. **Cursor compositing into DXGI DD frames** — safe path, no WGC, ~100-150 lines in `desktop_capture.rs`
3. **PLI cascade investigation and mitigation** — verify hypothesis with SFU logs, then LiveKit config or NVENC GOP tweak
4. **David's audio path** (only after he upgrades to v0.6.2)
5. **Infinity mirror detection / workaround**

Do NOT try to combine these. Prior session and this session both proved that multi-track work within a single session causes context bloat and bisecting. One thing per session.

---

## Key files (unchanged list, for quick reference)

### Capture pipeline
- `core/client/src/capture_pipeline.rs` — SFU publish options (min_bitrate, max_framerate=60)
- `core/client/src/desktop_capture.rs` — DXGI DD capture loop (**NEW: reinit hotfix**)
- `core/client/src/screen_capture.rs` — WGC window capture (fine) + dead WGC monitor capture (do not use)
- `core/client/src/gpu_converter.rs` — HDR→SDR compute shader

### Encoder (webrtc-sys-local)
- `core/webrtc-sys-local/src/nvidia/h264_encoder_impl.cpp` — NVENC H.264
  - Lines ~225-270: InitEncode (60fps cap, VUI BT.709, AQ, 1s VBV, **level=AUTOSELECT new**)
  - Lines ~285-320: **NEW init param dump**
  - Lines ~470-540: SetRates (bitrate-only soft reconfigure)

### Signaling / control plane
- `core/control/src/sfu_proxy.rs` — full-duplex WebSocket proxy (**fresh build this session**)

### LiveKit forks
- `core/livekit-local/src/room/options.rs` — `VideoEncoding.min_bitrate`
- `core/livekit-local/src/rtc_engine/peer_transport.rs` — SDP min-bitrate hint
- `core/libwebrtc-local/` — vendored crate with `RtpEncodingParameters.min_bitrate` field

### Viewer
- `core/viewer/changelog.js` — **update BEFORE shipping v0.6.2**
- `core/viewer/connect.js` — chime fix
- `core/viewer/grid-layout.js` — 2x2 bias
- `core/viewer/screen-share-native.js` — routes monitors to DXGI DD
- `core/viewer/style.css` — fullscreen button + volume slider positioning

---

## Validation data from this session (for the record)

### Proxy connections observed
| ID | Type | Lifetime | Close reason | Notes |
|----|------|----------|--------------|-------|
| proxy:1 | Sam main | 1435.0s | clean client-close | ~24 min, the LONGEST lifetime of the session |
| proxy:6 | Sam main | 589.0s | clean client-close | ~10 min |
| proxy:13 | Sam main | 552.1s | clean client-close | ~9 min |
| proxy:17 | Sam $screen | **1299.9s** | clean client-close | ~21.7 min, the key $screen validation |
| proxy:19 | D $screen | still open at session end | N/A | WAN publisher, no cycling |

### Capture stats peak
- 118,244 frames captured in one continuous share, zero timeouts, zero reinits
- NVENC encoded 118,031 calls, zero skipped
- Target bitrate sustained at 19.5-20.0 Mbps
- Capture rate ranged 91-143fps depending on DWM load
- Clean user-initiated stop (`stop requested`, not a crash path)

### David's visual report on Sam's stream
- Stable 30fps
- "Image is good"
- No drops
- Cursor not visible (known, confirmed)

### Sam's visual report on David's stream
- Stable 60fps for 1-2 min
- Brief transient dip, clean self-recovery
- David's game audio not coming through (deferred — old binary suspected)

### Failures observed
- Two DXGI capture crashes in the first David test → fixed by reinit hotfix
- NVENC 144 init failure → level=AUTOSELECT applied, still failing, deferred
- SAM-PC join caused cross-receiver FPS degradation → PLI cascade hypothesis, deferred

---

## Token usage / session discipline note

This session ran very long and accumulated a lot of context. Key discipline notes for the next session:
1. **One goal per session.** Ship v0.6.2, then stop. Don't try to also fix NVENC 144 or cursor.
2. **Read this whole handover FIRST.** Before touching code, before checking git, before anything.
3. **Update this file at session end.** Non-negotiable.
4. **Do not bisect NVENC.** Pattern-match OBS wholesale.
5. **Do not test WGC monitor capture on Sam's daily driver.** Ever. See DO NOT TOUCH.
