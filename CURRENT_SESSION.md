# Echo Chamber - Current Session Handover

## 2026-04-10 Codex Handover Override

This block supersedes the older v0.6.6 summary below it.

**Last Updated**: 2026-04-10
**Current Version**: **v0.6.7 SHIPPED**
**Status**: Codex now follows the repo operating rules pinned in `AGENTS.md`. Work stays under `core/`. PR `#143` (`fix/heartbeat-frame-duplication`) must remain unmerged until Sam manually validates the installed client against the static browser-window freeze case.

### Current Priorities
- Browser audio extraction from browser-window shares
- Outbound NACK and packet-loss signals in capture health
- Tauri signing key recovery

### Known Bugs
- GPU driver flicker on Sam's RTX 4090 setup
- Static WGC browser-window streams can freeze without the heartbeat fix
- Browser audio remains silent for browser-window shares
- Encoder detection still has edge-case lag

**Last Updated**: 2026-04-09 (v0.6.6 shipped after v0.6.5 false-ship; first 4-friend session; Jeff crash post-mortem; share chime bug fixed)
**Current Version**: **v0.6.6 SHIPPED ✅** (GitHub release only — latest.json still points at v0.6.5 until next session updates it)
**Status**: v0.6.6 has working delay-load nvcuda.dll (verified via dumpbin — nvcuda in DELAY IMPORTS section). AMD/Intel friends can install and run. First real 4-publisher test ran for ~54 min before Jeff's AMD machine crashed under software-encoder load; post-mortem written. Share chime bug fixed live via force-reload (PR #147). Substantial v0.6.7 backlog queued.

---

## ⚠️ READ FIRST — CRITICAL DEFERRED TASK

**`core/deploy/latest.json` still points at v0.6.5 (broken).** We deliberately held it there so Brad/David wouldn't get an auto-update prompt mid-session. The moment you confirm nobody is in the middle of a session, **update it to v0.6.6**:

```bash
cd "F:/Codex AI/The Echo Chamber"
gh release download v0.6.6 --pattern "*.sig" --dir . --clobber
# Then manually edit core/deploy/latest.json: bump version to 0.6.6, update URL, paste sig
# PR + merge + verify https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json serves 0.6.6
```

Until this happens, any new AMD friend who auto-updates will get bricked on v0.6.5. Jeff already has v0.6.6 via manual install.

---

## 🆕 2026-04-09 SESSION SUMMARY

### Releases shipped this session (in order)

1. **v0.6.4** (earlier in session): WGC classifier false-alarm fix (PR #141) — classifier now skips fps check in WGC mode
2. **v0.6.5** (emergency): intended to fix the AMD/Intel nvcuda.dll brick from v0.6.3-v0.6.4. **FALSE SHIP** — `/DELAYLOAD:nvcuda.dll` was emitted from `webrtc-sys-local/build.rs` (a library crate), but cargo silently drops `rustc-link-arg` from library crates. The v0.6.5 binary had nvcuda in the normal IMPORTS section, identical to v0.6.4, still bricked Jeff. Discovered when Jeff reported the same error after auto-updating.
3. **v0.6.6** (real fix, PR #150): moved the linker flags to `core/client/build.rs` (the bin crate) where cargo actually propagates them. Verified with `dumpbin -imports` showing `nvcuda.dll` in the **"Section contains the following delay load imports"** section. Published to GitHub release, signed, live.

### Hard lesson learned

Before claiming any "delay-load" or "linker flag" fix works, **verify the shipped binary with `dumpbin -imports`**. The `cargo:warning=` messages in the build log are NOT proof the flag was actually applied. The cargo doc explicitly says `rustc-link-arg` from library crates is dropped. This cost us 25+ minutes of CI + Jeff being bricked longer than necessary. Added to the v0.6.6 commit message as a permanent reminder.

### Global rule added

`~/.claude/CLAUDE.md` now has a **"NEVER build macOS targets without Sam explicitly asking"** rule. Sam + all friends are Windows-only. macOS builds were burning 20+ min per release + blocking publish-manifest on failure. The `build-macos` job in `release.yml` is now gated `if: false` and `publish-manifest` no longer depends on it. `MAC_SIG=""` is hardcoded so the latest.json generator falls through to the windows-only manifest path.

### First successful 4-friend session

Brad, David, Sam, Jeff all in the room simultaneously. All on CI-built v0.6.x binaries. Brad + David + Sam on NVIDIA (hardware NVENC), Jeff on AMD 7600 XT (OpenH264 software fallback — v0.6.6 delay-load let him launch).

Stats mid-session (before crash):
- Brad/David/Sam: Green WGC/NVENC, 60fps, ~6 Mbps, near-zero packet loss
- Jeff: Chip showed Green NVENC (detection bug — actually OpenH264), wire output 24-48 fps at ~3.2 Mbps, **28,435 NACKs + 2,447 lost packets on his outbound** (massive retransmit storm, invisible to his own chip because the classifier has no outbound network signals)
- ICE paths: all direct UDP (srflx↔host or prflx↔host), zero TURN relay usage

After ~54 minutes, Jeff's client crashed. Full post-mortem at `~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/bug_jeff_crash_4publisher_stress_test.md`.

### Share chime bug fixed live

Sam noticed during the session: when David started screen sharing, David's PERSONAL intro music played instead of a universal share chime. Root cause: `$screen` companion publishers fire `ParticipantConnected`, which called `playChimeForParticipant` which falls back to the parent identity's personal chime. PR #147 fixed it (pure viewer JS, no rebuild), merged live, force-reload kicked all 5 participants, everyone reconnected to the updated JS, confirmed working.

Three components of the fix:
1. New `playStopShareChime()` in `chimes.js` (descending G major arpeggio, mirror of the existing ascending `playScreenShareChime`)
2. Guard personal enter chime in `ParticipantConnected` handler when identity endsWith('$screen')
3. Guard personal exit chime in `ParticipantDisconnected` handler + fire `playStopShareChime()` from `TrackUnpublished`

### The v0.6.7 backlog (now substantial)

The next release bundle should include ALL of these:

1. **PR #143 — heartbeat frame duplication for static WGC content** (unmerged, awaiting Sam validation). Without this, sharing a static browser window produces 1-5 fps wire output because WGC is event-driven. Heartbeat thread re-pushes the last frame every 33ms, NVENC dedupes, wire rate stays at target.

2. **PR #148 — cold-start grace + classifier hysteresis + GPU flicker recovery script** (unmerged). Cold-start grace suppresses fps Red for 10s after capture activates. Hysteresis requires 2 consecutive Red cycles before firing the banner (stops oscillation spam). Flicker recovery script is a PowerShell one-shot that tries pnputil + disable/enable before falling back to reboot.

3. **Encoder detection bug fix** (the big one from Jeff's session). At client startup, `LoadLibraryW(w!("nvcuda.dll"))` — if it fails, set a global `HAS_NVCUDA=false`. In `CaptureHealthState::set_active()`, read that global and default to `EncoderType::OpenH264` instead of `EncoderType::Nvenc`. This would have immediately flagged Jeff's chip as Red (since the existing rule auto-Reds on OpenH264 fallback).

4. **Outbound NACK + packet loss rate as capture_health signals**. Pull them from the publisher's own outbound stats (already collected in `screen-share-native.js` for `/admin/api/stats`). Add `outbound_packets_lost_rate`, `outbound_nack_rate_per_sec` to `CaptureHealthSnapshot`. Classify: Yellow at 10 NACKs/sec, Red at 50 NACKs/sec. Apply hysteresis from #148.

5. **OpenH264 capture rate cap**. If `EncoderType::OpenH264` is active, throttle the capture loop to ~20 fps in software (instead of the native display refresh rate). Prevents the CPU cascade that likely caused Jeff's crash — software H264 at 20 fps is survivable on mid-range CPUs, at 60+ fps it's a sink.

6. **Browser audio extraction** (spec already written at `docs/superpowers/specs/2026-04-08-browser-audio-extraction-design.md`). Approach B: audio session enumeration via IAudioSessionManager2. Fixes the "friends can't share YouTube/Twitch audio" bug. Ready for `writing-plans` next session.

### Ready-to-merge but NOT YET MERGED

- **PR #143** (heartbeat) — needs Sam's live validation first. Branch: `fix/heartbeat-frame-duplication`
- **PR #148** (cold-start + hysteresis + flicker script) — mixed JS (hysteresis, can merge now) + Rust (cold-start, needs v0.6.7). Branch: `fix/capture-health-false-positives`

### Ongoing backlog items (unchanged)

- **GPU driver flicker recovery path** — PowerShell script is in #148 and will ship when that PR merges
- **Tauri signing key local recovery** — find it in password manager so future emergencies can skip the 20+ min CI cycle
- **v0.6.5 graveyard** — document that v0.6.5 is a known-broken release, maybe mark it "pre-release" or delete it from the GitHub releases page to avoid future confusion

---

---

## ⚠️ AWAITING SAM VALIDATION — PR #143

**Bug the PR fixes:** Sam observed during v0.6.4 live friend testing that when David shared a specific browser window (WGC path), his stream stopped entirely unless he moved his mouse. This is WGC working as designed (event-driven, only fires on repaints) but terrible UX — static content produces zero wire frames. PR #140 / v0.6.4 only silenced the false RED capture-health alerts, not the underlying wire-silent problem.

**PR #143 approach:** A dedicated heartbeat thread in `CapturePublisher` wakes every 33 ms. If `push_frame_strided` hasn't been called in that long, it re-pushes the stored last BGRA frame. NVENC dedupes repeated identical frames into tiny skip-frame markers, so the wire rate stays at 30 fps regardless of content change rate. DXGI DD is unaffected because its polling cadence is always faster than heartbeat.

**Why it wasn't merged by Claude:** written during an autonomous hour while Sam was away. Compiles clean, logic is well-reasoned, but NOT live-tested against the real regression scenarios. Sam must validate before merging. The PR body has a 4-point checklist.

**Validation checklist (copy to local build + run before merging):**
1. Entire-screen share (DXGI DD) still works normally — no frame rate regression, no visual artifacts
2. Specific-window share (WGC) of a static browser page produces a continuously flowing wire stream to other viewers
3. Client log shows periodic `[heartbeat] N duplicate frames pushed in last 10s` when sharing static content
4. Client log shows zero or near-zero heartbeat dup pushes when capture source is actively moving

**To validate:** check out `fix/heartbeat-frame-duplication` branch, `cargo build -p echo-core-client --release` from `core/`, copy binary to `%LocalAppData%\Echo Chamber\echo-core-client.exe`, relaunch, share a browser window, check the log at `%LocalAppData%\Echo Chamber\client-stdout.log` or wherever. If all 4 checks pass, merge #143, cut v0.6.5 following the release-checklist rule (bump 3 version files + changelog entry + tag push).

---

## 🔴 HIGH PRIORITY BACKLOG: Browser Audio Extraction

During the same live session, Sam flagged: "we are also unable to extract audio from browsers which is a problem." Browser processes (Chrome/Edge/Firefox) produce audio through sibling helper processes, not the main PID that the capture picker identifies, so WASAPI per-process loopback returns silence. Full notes at `~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/project_browser_audio_extraction.md`. This is a real friend-blocker (YouTube/Twitch sharing without audio is unusable). Needs a brainstorming session before any code changes — not a one-liner.

---

## ✅ SHIPPED 2026-04-08

- **v0.6.3 (#133+#134+#135)**: per-receiver instrumentation, capture pipeline health monitor, admin login from Tauri viewer, DXGI INVALID_CALL fix (Win+P recovery), target_fps plumbing, encoder fallback detection, **NVENC in CI release builds** (the biggest fix — friends' installers now ship with hardware encode).
- **v0.6.4 (#140+#141+#142)**: WGC classifier exception (fps threshold only applies to DXGI DD mode; WGC is content-driven so low fps on a static window is normal, not degraded). Silences the false Red alerts Sam was getting during live testing. macOS build also fixed (PR #139 gating on `capture_health::*`).

**Currently running on Sam's PC:**
- Tauri client: v0.6.4 (clean build from main, post-restore)
- Server version: 0.6.4 (control plane, SFU, TURN all up)
- Admin dashboard updater endpoint serves v0.6.4 for auto-update to friends

---

## 🔴 GPU DRIVER FLICKER BUG — P1 BACKLOG (unchanged from earlier in session)

Still unresolved. 2nd documented occurrence. Full notes at `~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/bug_gpu_driver_flicker_recurring.md`. Non-reboot recovery path research is the next step when Sam has bandwidth.

---

## 🗂 Other backlog items (low priority)
- Share-start/stop chimes (not personal intro/outro music) — `project_share_chimes.md`
- capture_health cold-start false positive (10s grace after set_active true)
- Classifier hysteresis (require 2+ Red cycles before firing banner)
- v0.6.5 heartbeat frame duplication (PR #143, awaiting validation)
- GPU flicker non-reboot recovery path

---

## Original session summary below (pre-v0.6.4)

---

## ✅ NVENC IN CI RELEASE BUILDS — SHIPPED 2026-04-08 (#135)

**Root cause of the ~9fps mystery that drove all of v0.6.2 debugging:** the CI-built installer every friend downloaded via auto-updater had ZERO NVENC support. GitHub's `windows-latest` runner didn't have CUDA Toolkit, so `webrtc-sys-local/build.rs` saw no `cuda.h`, emitted `cargo:warning=cuda.h not found ... building without NVIDIA hardware encoding`, and produced a binary that could only OpenH264 software encode at ~9 fps. Meanwhile the capture-health classifier from #133 treats `encoder_type == "OpenH264"` as auto-Red — so friends' installed clients would light up red in the admin panel the moment they joined, while not understanding why. Fixing CI is the upstream fix for all of it.

**What shipped in PR #135:**
- `release.yml` adds a `Jimver/cuda-toolkit@v0.2.21` step before the cargo tauri build. Installs CUDA 12.6.0 with minimal sub-packages (nvcc, cudart, visual_studio_integration). Cached via `use-github-cache` so subsequent runs are fast. Passes `CUDA_HOME` through to the build step.
- `release.yml` adds a `workflow_dispatch` trigger with a `dry_run` boolean input, so we can validate CI builds end-to-end without cutting a real release tag. When `dry_run=true`: Windows build runs fully, but `Create GitHub Release`, `build-macos`, and `publish-manifest` jobs are skipped. This is the ONLY way to validate the CUDA-in-CI path without polluting release history.
- `build.rs` refactored into TWO independent gates instead of one:
  - **Gate A** (`cuda.h` present) → compile encoder path only (h264/h265 impl, NvEncoder, NvEncoderCuda, nvidia_encoder_factory, cuda_context). Defines `USE_NVIDIA_VIDEO_CODEC=1`.
  - **Gate B** (`nvcuvid.lib` present) → ADDITIONALLY compile decoder path + link nvcuvid. Defines `USE_NVIDIA_VIDEO_DECODER=1`.
- `build.rs` replaces the hardcoded `F:/Codex AI/The Echo Chamber/core/nvcuvid.lib` path with `CARGO_MANIFEST_DIR`-based repo-relative lookup (`<repo>/core/nvcuvid.lib`). This unblocks CI AND any other dev machine that clones the repo.
- `video_decoder_factory.cpp` updated to gate decoder registration on `USE_NVIDIA_VIDEO_DECODER` instead of `USE_NVIDIA_VIDEO_CODEC`, so encoder-only builds don't reference `NvidiaVideoDecoderFactory` symbols that weren't compiled.

**Validated via dry-run** (workflow_dispatch on the PR branch before merge):
- CUDA Toolkit installed on the runner (5-6 min cold, cached after)
- `Verify CUDA install` step confirmed cuda.h + cuda.lib at expected paths
- `cargo tauri build` completed successfully
- Build log contained: `warning: webrtc-sys@0.3.27: NVIDIA NVENC + NVDEC support enabled (cuda.h at "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\include", nvcuvid at "D:\a\echo-chamber\echo-chamber\core\nvcuvid.lib")`
- **Bonus discovery**: `core/nvcuvid.lib` is vendored in the repo (10KB import library, already git-tracked). Previously invisible because of the hardcoded `F:/` path. With the new resolution, CI gets BOTH encoder AND decoder (not just encoder-only as planned). Friends get NVENC + NVDEC on the next release.

**What's left:**
- Cut a v0.6.3 release tag to actually ship the NVENC-enabled installer to friends via auto-updater
- Next session or whenever v0.6.3 is ready, verify friends' installed clients report `encoder_type: "NVENC"` in the admin panel chip instead of OpenH264 Red

---

## ✅ DXGI INVALID_CALL FIX + CAPTURE-HEALTH FOLLOW-UPS — SHIPPED 2026-04-08 (#134)

Three related fixes that came out of capture-health validation:

1. **DXGI_ERROR_INVALID_CALL on display switch** — Win+P display mode changes were silently killing screen-share streams. The `reinit_with_backoff` handler only matched `DXGI_ERROR_ACCESS_LOST` (0x887A0026) and `DXGI_ERROR_WAIT_TIMEOUT` (0x887A0027). On Win+P switches, DXGI returns `DXGI_ERROR_INVALID_CALL` (0x887A0001) instead — the old code routed this into the generic-error branch which broke the loop after 10 hits, killing capture entirely. Fix: treat 0x887A0001 the same as 0x887A0026 (drop the broken interface, run `reinit_with_backoff`). Discovered live during capture-health validation — the new chip was supposed to go yellow on a single Win+P switch but the stream died before the chip could report.

2. **Real `target_fps` in capture_health** — Rust `set_active()` calls were hardcoding `target_fps=60`, but the actual wire publish framerate is 30 (NVENC frame_drop=1 throttles down to 30). Extracted `PUBLISH_TARGET_FPS` constant in `capture_pipeline.rs` and use it from both DXGI DD and WGC `set_active()` call sites + the existing `max_framerate` hardcodes. The chip now shows a meaningful capture/wire ratio.

3. **NVENC → OpenH264 fallback detection** — `set_active()` default-assumes NVENC but only WebRTC's `getStats()` knows which encoder libwebrtc actually selected. New `CaptureHealthState::set_encoder_type_from_string()` method + Tauri IPC `report_encoder_implementation`. `screen-share-native.js` stats reporter posts the codec back through this IPC whenever it changes. The classifier already auto-Reds on `encoder_type == "OpenH264"` so the chip will go red automatically if libwebrtc falls back.

---

## 🔴 GPU DRIVER FLICKER BUG — P1 BACKLOG (2026-04-08)

**Recurring, now documented twice.** Sam's RTX 4090 / 4K HDR / 144Hz multi-monitor setup enters a wedged flickering state on certain capture pipeline transitions. First incident: WGC monitor capture in Rgba16F. Second incident this session: Win+P display mode switching while screen-sharing. Both times required a full reboot — `Win+Ctrl+Shift+B`, sign-out, and process kills did not clear it.

Full diagnosis + workaround paths logged in `~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/bug_gpu_driver_flicker_recurring.md`. MEMORY.md index updated with a critical-rule entry. P1 backlog item for v0.6.3: investigate `pnputil /restart-device` as a non-reboot recovery path, pre-stage an elevated PS script Sam can run when it happens, and consider whether `IDXGIOutputDuplication::ReleaseFrame()` ordering or catching `DXGI_ERROR_DEVICE_REMOVED` prevents the wedge in the first place.

---

## ✅ CAPTURE PIPELINE HEALTH MONITOR — SHIPPED 2026-04-08 (#133)

The instrumentation pipeline from earlier this session has been extended with a full capture-side health monitor: every publisher's local capture pipeline emits real-time telemetry (DXGI reinits, consecutive timeouts, capture FPS, encoder type, shader errors) that flows from the Tauri client → IPC → viewer reporter → server merge → admin dashboard with a colored chip and banner UI inside the same Tauri viewer.

**Visually confirmed working** with Sam in the room: floating bottom-right panel shows per-participant rows with live capture-health chips. Sam's row showed `● Green DXGI-DD NVENC` with `fps 143/60  reinits 0/5m  skip 0.0%  consec_to 0`. SAM-PC (pure subscriber) correctly shows `● None —`.

### What's in this milestone

**Spec:** `docs/superpowers/specs/2026-04-08-capture-health-monitor-design.md`
**Plan:** `docs/superpowers/plans/2026-04-08-capture-health-monitor.md`
**Branch:** `feat/per-receiver-instrumentation` (local only — see push gate below)

**Phase 0 — Admin login from Tauri viewer (5 commits)**
- 🛡 Admin button on the existing viewer login screen → password modal → JWT in `state.js` `adminToken` global, persisted to `localStorage["echo_admin_token"]`
- Auto-restore on page load via `restoreAdminFromStorage` (probes `/admin/api/dashboard` to validate)
- Admin badge `🛡 ADMIN | Panel | Sign out` appears in the header once signed in
- Click handler uses **document-level event delegation** so it survives connect/disconnect DOM rebuilds (initial direct addEventListener was a real bug — caught during Sam's manual test)
- Side panel polls `/admin/api/dashboard` every 3s when open, hidden on close, toggleable from the badge

**Phase 1 — Capture pipeline telemetry collector (7 commits)**
- New module `core/client/src/capture_health.rs` (303 lines) — `CaptureHealthState` with atomic counters + 5-min rolling event windows for reinits / shader errors / max consecutive timeouts
- Pure-function `classify()` returns `(HealthLevel, Vec<String> reasons)` from a snapshot. Thresholds: Yellow at 1 reinit / 5 consec timeouts / fps <80% target / skip rate ≥2%; Red at 3 reinits / 10 consec timeouts / fps <50% / skip rate ≥10% / OpenH264 fallback / any shader error
- 13 unit tests covering nominal + each threshold + multi-signal max-level — all passing
- Tauri IPC `get_capture_health()` returns `Option<CaptureHealthSnapshot>` (None when capture inactive) — registered in `invoke_handler`, state managed via `Arc<CaptureHealthState>` in `tauri::Builder.manage()`
- DXGI Desktop Duplication path (`desktop_capture.rs`) wired with 10 hook sites: set_active(true/false), record_reinit x2, record_consecutive_timeout x2, reset_consecutive_timeouts x3, record_capture_fps x1
- WGC path (`screen_capture.rs`) wired with 6 hook sites for both `share_loop` and `share_loop_monitor` (no reinit hooks because WGC has no retry loop today — DXGI exercises that signal)
- gpu_converter shader error hook on the `Map` staging error path (DXGI path only — WGC handler struct doesn't carry health state, deferred as v1 limitation)

**Phase 2 — Server data plumbing + viewer reporter + admin panel UI (5 commits incl. 2 hotfixes)**
- New `CaptureHealth` struct on the server in `admin.rs` mirroring `CaptureHealthSnapshot`. New `capture_health: Option<CaptureHealth>` field on `ClientStats`. `client_stats_report` handler extends merge logic to handle the new field
- Viewer reporter in `screen-share-adaptive.js` extended to call `tauriInvoke("get_capture_health")` and include the result in the existing `/api/client-stats-report` POST (already added last night for per-receiver inbound stats)
- **Hotfix #1**: relaxed the POST gate from `_inboundDropTracker.size > 0` to `inboundArr.length > 0 || captureHealth` so publishers alone in a room (no remote video tracks) still report their capture health
- **Hotfix #2**: `startInboundScreenStatsMonitor()` is now also called unconditionally on room connect from `connect.js` (previously only fired when audio-routing detected a remote tile, which left publisher-alone clients with no reporter)
- New `core/viewer/admin-panel.js` (Phase 0 minimal version then Phase 2 chip+banner version): polls `/admin/api/dashboard` every 3s, renders per-room per-participant chips with `chip-green` / `chip-yellow` / `chip-red` / `chip-none` classes plus per-participant detail row (fps, reinits, skip rate, consec timeouts)
- Top banner triggered on Yellow→Red or Green→Red transitions per-identity, with synthesized Web Audio chime (square wave 880→660 Hz, 280ms, gain 0.08), 60s mute button, and per-identity prev-level tracking so the chime fires once per transition
- **Hotfix #3 (UX)**: Floating bottom-right panel (360x65vh) instead of full-height right rail — was covering Sam's screen-share controls in v1
- **Hotfix #4 (UX)**: Badge label and "Panel" button both toggle the panel show/hide — auto-restore from localStorage no longer auto-opens the panel, only an explicit click does

**Files changed across this milestone:**
- New: `core/client/src/capture_health.rs`, `core/viewer/admin-panel.js`
- Modified Rust: `core/client/Cargo.toml` (parking_lot), `core/client/src/main.rs` (mod, state, IPC, command), `core/client/src/desktop_capture.rs` (10 hooks), `core/client/src/screen_capture.rs` (6 hooks), `core/client/src/gpu_converter.rs` (shader error hook), `core/control/src/admin.rs` (CaptureHealth struct + ClientStats field + merge)
- Modified JS/CSS/HTML: `core/viewer/auth.js` (admin helpers + delegation + badge toggle), `core/viewer/index.html` (modal + badge slot + panel + admin-panel.js script tag), `core/viewer/style.css` (admin login + floating panel + chips + banner), `core/viewer/screen-share-adaptive.js` (capture_health POST + gate fix), `core/viewer/connect.js` (start monitor on room connect), `core/viewer/app.js` (defer admin init to DOMContentLoaded)

### How to use it (any future session)

1. Click 🛡 Admin on viewer login screen → type `EchoCore-8a8e3854` (from `core/control/.env`) → click Sign in
2. Badge appears in header. Click "Panel" or the 🛡 ADMIN label to open the floating side panel
3. Panel polls every 3s, shows server version, per-room participant rows, chips, fps, reinits, skip rate, consec timeouts, and any classifier reasons
4. RED transitions trigger top banner + chime once per transition; "Mute 60s" button suppresses repeats

### Tuning needed

Thresholds in `core/client/src/capture_health.rs` (top-of-file constants) are first-pass guesses. Phase 3 of the plan calls for tuning against real-session data after a week of use. The `target_fps` is currently hardcoded to 60 in `set_active()` calls — we may want to plumb the real publish opt later.

### Push gate

**Branch is local only.** Per HARD RULE 7 (never push without Sam's explicit confirmation), no `git push` has been done. To push the entire instrumentation + health-monitor work as one PR:
```bash
cd "F:/Codex AI/The Echo Chamber"
git push -u origin feat/per-receiver-instrumentation
gh pr create --title "feat: per-receiver instrumentation + capture pipeline health monitor" --body "..."
```

---

## 🆕 2026-04-08 SESSION SUMMARY (FIRST HALF — per-receiver instrumentation, still relevant)

### What got built (committed locally on `feat/per-receiver-instrumentation`, branch NOT pushed)

1. **LiveKit Prometheus metrics** on `:6789` — `core/sfu/livekit.yaml` now has `prometheus_port: 6789`. Per-DownTrack `livekit_jitter_us`, `livekit_forward_latency`, etc. Restart of livekit.yaml is gitignored — change is server-local only.
2. **`POST /api/client-stats-report` endpoint** in `core/control/src/admin.rs` (route registered in `main.rs`). Auth via existing `ensure_livekit` (any logged-in viewer's room JWT, no admin needed — this is what unblocks David/Decker stats reporting). Merges into existing `client_stats` map keyed by JWT subject.
3. **`SubscriptionStats` struct** alongside `ClientStats`. Fields: `from`, `source`, `fps`, `width`, `height`, `bitrate_kbps`, `jitter_ms`, `lost`, `dropped`, `decoded`, `nack`, `pli`, `avg_fps`, `layer`, `codec`, `ice_local_type`, `ice_remote_type`. Also new `ClientStats.inbound: Option<Vec<SubscriptionStats>>`.
4. **`#[serde(default)]` on ClientStats container** — partial payloads (no `updated_at`, no publisher fields) now deserialize cleanly. Without this the endpoint returned 422 for every viewer POST and we lost ~15 minutes diagnosing it.
5. **`core/viewer/screen-share-adaptive.js`** — inbound stats poller now also captures ICE candidate-pair types (`lType`, `rType`, `rtt`) and stores them on `dt._lastReport`. After each 3s poll, EVERY connected viewer (publisher or pure subscriber) POSTs its `inbound[]` array to `/api/client-stats-report` with its LiveKit JWT.
6. **Existing dashboard JSON now exposes per-receiver data**: `GET /admin/api/dashboard` returns each participant's `stats.inbound[]` automatically because `admin_dashboard` already pulls `client_stats.get(&p.identity)`.

### Smoke test results (2026-04-08 @ ~22:42)

Sam (main, publisher) + SAM-PC (LAN test rig) + TestBot (Edge probe in Chrome DevTools MCP, joined via WAN domain):

| Receiver | From | FPS | Resolution | Bitrate | Lost | NACK | PLI | Jitter | ICE pair | Codec |
|---|---|---|---|---|---|---|---|---|---|---|
| **TestBot** | sam-7475$screen | **61** | 1920×1080 | 5898 kbps | 0 | 0 | 0 | 2ms | srflx→host | H264 |
| **SAM-PC** | sam-7475$screen | **60** | 1920×1080 | 6253 kbps | 0 | 0 | 0 | 2ms | srflx→host | H264 |

**Both receivers report perfect 60fps with zero loss, zero NACK, zero PLI** on a clean test (Sam alone publishing, no kick-restart cycles in flight). This is what "working" looks like in the new dashboard. When David/Decker numbers come in tomorrow, any anomaly will be a real signal — not a measurement bug.

This also strongly suggests the previous session's "4fps for David, 7fps for Decker" numbers were either (a) the unreliable viewer FPS counter lying, or (b) real chaos from 6+ kick-restart cycles disrupting in-flight WebRTC connections. Tomorrow's clean test will tell us which.

### How to use it tomorrow

1. **Get friends in** the room first, with NO restart cycles after they join.
2. Sam shares his screen (or whoever's testing).
3. Wait 30 seconds for two stats poll cycles.
4. Pull data:
   ```bash
   TOKEN=$(curl -sk -X POST https://127.0.0.1:9443/v1/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"password":"EchoCore-8a8e3854"}' | python -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
   curl -sk https://127.0.0.1:9443/admin/api/dashboard -H "Authorization: Bearer $TOKEN" | python -m json.tool
   ```
5. Look at each participant's `stats.inbound[]` for their view of `sam-7475$screen`. Compare side-by-side:
   - Different `fps` values → real per-receiver problem
   - Different `ice_local_type` (e.g. David is on `relay`, Decker on `srflx`) → ICE / TURN routing issue
   - High `nack` or `pli` on one but not the other → packet loss specific to that receiver's path
   - High `jitter_ms` on one → that receiver's network is buffering
   - All similar → the viewer FPS counter we were chasing was lying all along
6. Also pull Prometheus for SFU-side per-DownTrack outbound counters:
   ```bash
   curl -s http://127.0.0.1:6789/metrics | grep -E "livekit_(forward|jitter|packet_loss)" | head -50
   ```

### What is NOT done (deferred)

- **`feat/per-receiver-instrumentation` branch is local only** — NOT pushed to GitHub. Sam to confirm before pushing. Worktree binary is the running server.
- **Sam-as-publisher's outbound stats are still gated on admin login** — the existing `/admin/api/stats` POST requires `adminToken`, which Sam's Tauri client doesn't have. If we want publisher-side outbound numbers (encoder fps, BWE, qualityLimitationReason) tomorrow, either log in as admin in the Tauri client (button exists in viewer UI) or relax that endpoint to also accept room JWTs. Tomorrow problem.
- **No dashboard UI for the new inbound array** — the data flows through `/admin/api/dashboard` JSON but the admin web UI doesn't render it. For tomorrow, just `curl + python -m json.tool` is enough. If we want a panel later, it's `core/admin/` HTML.
- **Friends did not test tonight** — they had to leave after the LiveKit + control plane restart cycles. Smoke test was Sam + SAM-PC + Edge probe only.

### Files changed this session
- `core/sfu/livekit.yaml` (server-local, gitignored) — added `prometheus_port: 6789`
- `core/control/src/admin.rs` (committed) — `SubscriptionStats`, `ClientStats.inbound`, `client_stats_report` handler, `#[serde(default)]`
- `core/control/src/main.rs` (committed) — route registration
- `core/viewer/screen-share-adaptive.js` (committed) — ICE capture + POST loop

### Footguns hit this session (don't repeat)
- **Don't `cp` worktree files into main repo if you've already edited the main repo files** — overwrites your own edits silently. Either edit one place consistently, or build from the same place you edit. (Lost ~10 minutes to this.)
- **Don't trust "Edit succeeded" without grepping** — `Edit` tool always returns success even when a later `cp` clobbers the change. Always grep before assuming the edit landed.
- **`Json<T>` extractor errors return 422 not 401** — the auth helper is called inside the handler, AFTER the body extractor. Missing required fields hit 422 long before auth runs, so a 422 doesn't mean "wrong token" — it means "schema mismatch."
- **`Json<ClientStats>` needs `#[serde(default)]` for partial payloads** — `derive(Default)` alone doesn't make Serde use defaults for missing fields. Container-level `#[serde(default)]` does.
- **Each control-plane restart kicks every LiveKit client** — even with the SFU running unchanged. Try to batch all changes into a single restart. Tonight burned 4 restarts where 2 would have sufficed.

---

## ⚠️ ORIGINAL READ-FIRST FROM 2026-04-07 (still partly relevant)

---

## ⚠️ READ THIS FIRST — TOMORROW'S TOP PRIORITIES

The "FPS counter" we've been reading from the viewer tiles **may not be accurate**. Late in the session, Sam observed his SELF-VIEW reporting the same low FPS as remote viewers — but per CURRENT_SESSION findings C, self-view is "known unreliable." If self and remote both show the same low number, we may have been chasing a measurement bug, not a real performance bug.

**Before any more performance debugging next session, do these in order:**

1. **Enable LiveKit Prometheus metrics** (one-time cost: SFU restart) — add `prometheus_port: 6789` to `core/sfu/livekit.yaml`. This gives PER-DOWNTRACK packet loss / NACK / PLI / bitrate counters that the twirp API does not expose. Without this, you are debugging blind.
2. **Add a `/admin/api/getstats` endpoint** that polls each connected client's `room.engine.client.peerConnectionRTC.getStats()` via a data-channel command and dumps to a JSON. This lets you see real `framesPerSecond`, `framesDecoded`, `framesDropped`, `nackCount` from each receiver's perspective, INCLUDING David's.
3. **Add a debug overlay in the viewer** showing source-of-truth getStats() data on each tile (separate from the existing UI FPS counter). The current FPS readout might be doing something wrong.
4. **Test changes ONE AT A TIME** with a 5-minute observation window between each. The session below cycled through 6+ rebuild/relaunch loops, each of which caused LiveKit "duplicate participant" events that disrupted everyone's streams temporarily — making it impossible to tell if any change actually helped.

---

## 🧩 THE PER-RECEIVER MYSTERY (UNSOLVED)

### Symptom matrix (last observed)

| Source → Sink   | Sam        | David      | Decker    |
|-----------------|------------|------------|-----------|
| Sam (publisher) | self: low  | 4 fps      | 7 fps     |
| David (pub)     | 35 fps     | self: ?    | 60 fps    |
| Decker (pub)    | ?          | ?          | self: ?   |

**Asymmetry**: Decker can RECEIVE everything fine; David specifically struggles to receive from Sam. But also: Sam's self-view shows the same low FPS as David's view of Sam. So either Sam's encoder→SFU→loopback path is broken OR the FPS counter is lying.

### What we know is TRUE
- Sam's NVENC encoder log shows `encoded=N skipped=0 sending=1` continuously at 90+fps capture, 30fps wire output
- Sam's localhost path to SFU cannot have NAT/ICE/network problems (it's localhost!)
- David has 678 Mbps fiber / 11 ms jitter / 40 ms RTT (speedtest)
- David CAN publish to Decker successfully (60 fps observed)
- All clients are on viewer JS that has the new forced-banner code
- LiveKit's `rtc.turn_servers` is configured (verified syntax against config-sample.yaml)
- LiveKit's `congestion_control.enabled: false` and `allow_pause: false` (allocator disabled)
- Force-reload + kick-all are reliably working server-side (LiveKit twirp confirmed kicks)

### What we know is FALSE
- ❌ NOT bandwidth (David has 678 Mbps)
- ❌ NOT LiveKit allocator pausing (already disabled)
- ❌ NOT decoder CPU saturation (when Decker stopped sharing, David's view of Sam did NOT recover)
- ❌ NOT a publisher encoder issue (Sam's encoder log is clean)
- ❌ NOT NVENC fallback to OpenH264 (Sam's installed binary now has NVENC compiled in)
- ❌ NOT the WebRTC pacer / capture loop pacer (reverted, capture is back to 100+fps)
- ❌ NOT the LiveKit StreamAllocator pausing tracks (research-confirmed via subagent, then verified config)

### What we DON'T know
- David's actual ICE candidate pair selection (direct UDP / TCP fallback / TURN relay)
- David's actual receive-side packet loss & NACK rate (not exposed by twirp API at v1.9.11)
- Whether the viewer FPS counter is even measuring correctly
- Whether `removing duplicate participant` events from kick/restart cycles caused some of the chaos
- Decker's location/network (he's WAN like David but no other detail gathered)
- Whether the "$screen companion" identity reconnect storm during force-reload causes lasting subscriber drift

### The single most-leverage diagnostic for tomorrow

Add `getStats()` plumbing. The viewer JS already uses livekit-client SDK; `room.engine.pcManager.publisher.getStats()` and `...subscriber.getStats()` give the canonical WebRTC stats with `framesPerSecond`, `framesDecoded`, `nackCount`, `bytesReceived`, `jitter`, plus `iceCandidatePair` showing the actual selected ICE pair (host/srflx/relay/tcp). Plumb this to a /api/admin/client-stats endpoint that polls each connected client. This single addition would have collapsed the entire hypothesis space tonight.

---

## ✅ WHAT SHIPPED THIS SESSION (post-v0.6.2 fixes)

### 1. v0.6.2 release sequence (PR #127, #128, #129)
Three PRs to ship v0.6.2 with installer signature + handover doc.

### 2. Control plane version bump fix (PR #130)
`core/control/Cargo.toml` was missed during v0.6.2 ship. The dashboard reported v0.6.0 because that's what `CARGO_PKG_VERSION` returned. Bumped to 0.6.2. **Memory rule added: bump THREE version files, not two.** See `feedback_release_checklist.md`.

### 3. Forced auto-reload banner + nuclear /admin/api/force-reload (PR #131)
- Viewer-side forced banner with 5-second countdown + procedural smooth-jazz Web Audio chord progression (Dm7→G7→Cmaj7) + robot-voice "The server is restarting" via SpeechSynthesis. Validated live with friends.
- Server-side `POST /admin/api/force-reload` endpoint: bumps `viewer_stamp` AND rewrites `index.html` on disk via `stamp_viewer_index()` (without the disk rewrite, clients infinite-loop), then iterates LiveKit `ListRooms` → `ListParticipants` → `RemoveParticipant` for every room/participant including `$screen` companion publishers (which the dashboard filters out by design, leaving them as ghost zombies after parent client death).
- `admin_kick_participant` now also best-effort kicks `{identity}$screen`.
- New helpers in `rooms.rs`: `livekit_list_rooms`, `livekit_list_participants`, `livekit_remove_participant`.
- New "⚠️ Force Reload All" button in admin dashboard top-right.
- **Memory rule added**: after any server-state change (SFU/TURN restart, livekit.yaml edit), POST to `/admin/api/force-reload`. See `feedback_force_reload_after_server_changes.md`.
- **Memory rule added**: always launch the installed binary (`%LocalAppData%\Echo Chamber\echo-core-client.exe`), never the dev build at `core/target/release/`. See `feedback_installed_vs_dev_client.md`.

### 4. NVENC discovery (uncommitted as a code change but documented)
**The CI-built v0.6.2 release binary has ZERO NVENC support.** GitHub Actions runners don't have CUDA Toolkit installed → `webrtc-sys-local/build.rs:204` falls through the conditional and emits `cargo:warning=cuda.h not found ... building without NVIDIA hardware encoding`. The released installer is OpenH264-only, which caps at ~9fps for 1080p. This is a critical CI gap.

**Current workaround**: build `cargo build -p echo-core-client --release` locally on Sam's machine (where CUDA is at `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.6\`) and copy the binary over `%LocalAppData%\Echo Chamber\echo-core-client.exe`. Verified working — log shows `Nvidia Encoder is supported. ... [encoder-factory] HW factory matched! Delegating. ... [NVENC-factory] >>> CREATING NVENC H264 ENCODER <<<`.

**v0.6.3 P0**: get NVENC into CI builds. Either install CUDA Toolkit on the runner or vendor `cuda.h` + `cuda.lib` stubs into `webrtc-sys-local/`.

### 5. Per-publisher caps (capture_pipeline.rs — IN THIS COMMIT)
- `max_framerate: 30.0` (was 60). Validated as the right cap with 3 simultaneous publishers.
- `max_bitrate: 4_000_000` (was 20_000_000 → 8_000_000 → 4_000_000). 4 Mbps × 3 publishers = 12 Mbps aggregate, friendly to residential downlinks.

### 6. DXGI capture loop pacer EXPERIMENT — REVERTED (desktop_capture.rs — IN THIS COMMIT)
Tried capping the capture loop at 30fps to reduce wasted GPU shader work (HDR→SDR converter ran 100x/sec when only 30 frames/sec were encoded). Implementation slept 33ms before each `AcquireNextFrame(100ms)` call. Under multi-publisher GPU contention, this caused DWM's duplication interface to enter a degraded state where every-other AcquireNextFrame returned `DXGI_ERROR_WAIT_TIMEOUT`, triggering 50-consecutive-timeout reinit loops every few frames. Effective capture dropped to 9fps. **Reverted.** NVENC's `frame_drop=1` already throttles wire output regardless of capture rate, so the pacer was a premature optimization. Comment block in desktop_capture.rs documents this so we don't try it again.

### 7. DXGI reinit retry-with-backoff (desktop_capture.rs — IN THIS COMMIT)
The v0.6.2 reinit hotfix gave up after a single retry. During tonight's session, the elevated `Start-Process -Verb RunAs` UAC prompt for restarting LiveKit triggered DXGI ACCESS_LOST on Sam's capture; the immediate reinit failed with `E_ACCESSDENIED` because the secure-desktop transition wasn't complete; the loop bailed and Sam silently stopped publishing while everyone saw frozen tail-end frames. Fix: `reinit_with_backoff()` closure retries 5 times spaced 200ms / 400ms / 800ms / 1500ms / 2000ms (~5 seconds total) before giving up. Idle when not exercised; safety net for future UAC prompts and display mode changes.

### 8. Misleading "your game is impacting" warning fixed (screen-share-quality.js + screen-share-state.js — IN THIS COMMIT)
- Threshold lowered from 30fps to 18fps (since we now intentionally cap at 30, anything 18+ is healthy).
- Message changed from "Your game is impacting stream quality" to "Stream FPS is low — GPU may be contended" (Sam isn't running a game; the message was confusing).

### 9. TURN servers advertised in livekit.yaml (LOCAL-ONLY, not in commit since file is gitignored)
Added `rtc.turn_servers` block pointing to the existing `echo-turn.exe` on UDP 3478 with username `echo` and credential `chamber`. Verified syntax against LiveKit v1.9.11 `config-sample.yaml`. Was supposed to fix David's per-receiver path by giving his client a TURN relay candidate when direct UDP hole-punch failed. **Did not actually verify this fixed anything** — David's symptom persisted after restart + force-reload. Possibly correct config but not addressing the actual root cause; possibly David's client cached the old ICE servers list and never re-fetched.

---

## 🐛 BUGS DISCOVERED, NOT YET FIXED

### B1. CI builds have no NVENC
See section 4 above. v0.6.3 P0.

### B2. `removing duplicate participant` events disrupt all subscribers
Every kick/relaunch cycle (which happened ~6 times tonight) creates duplicate participant identities in LiveKit. The duplicate-removal causes SSRC changes that cascade as packet-loss / sequence-gap warnings to every subscriber. Symptoms include massive jitter spikes (6.5 SECONDS observed in livekit.err.log) that propagate. **Tomorrow**: don't kick Sam from his own SFU during testing. Use a separate test-only branch or test-only client identity.

### B3. `viewer_stamp` change without disk rewrite causes infinite reload loop
Already fixed in PR #131 — added `stamp_viewer_index()` call inside `admin_force_reload`. Documented as a "discovered live during testing" note in the code. Don't remove it.

### B4. Self-view FPS counter is unreliable, possibly all-tile FPS counters too
CURRENT_SESSION findings C already noted self-view unreliability. Tonight we observed BOTH self and remote tiles showing the same suspicious numbers. Suspect the JS-side FPS measurement uses something like `framesPerSecond` from getStats() but at the wrong layer or wrong sampling interval. **Tomorrow**: add a parallel debug overlay using known-good getStats() data and compare.

### B5. The TWO "Echo Chamber" apps on Sam's machine
Sam has an unrelated Node-based "Echo Chamber" at `C:\Users\Sam\AppData\Local\Programs\@echodesktop\Echo Chamber.exe` from some other project. Its Start Menu shortcut also says "Echo Chamber" and confused diagnostic earlier. **Action for Sam (manual)**: uninstall the @echodesktop one when convenient.

---

## 🔧 IN-FLIGHT FILES (this commit)

- `core/client/src/capture_pipeline.rs` — max_framerate=30, max_bitrate=4_000_000, comments
- `core/client/src/desktop_capture.rs` — reinit_with_backoff helper, pacer reverted, Instant import added then unused
- `core/viewer/index.html` — runtime-stamped, automatic
- `core/viewer/screen-share-quality.js` — message renamed
- `core/viewer/screen-share-state.js` — threshold 30→18

NOT in this commit (intentionally):
- `core/sfu/livekit.yaml` (gitignored, server-local)
- Any speculative per-receiver fixes — those need instrumentation first

---

**Ship sequence completed**:
  1. ✅ Bumped `Cargo.toml` + `tauri.conf.json` to 0.6.2 (`dfb7288`)
  2. ✅ PR #127 merged to main (`d914eb6`)
  3. ✅ `v0.6.2` tag force-updated `6abeb2a` → `d914eb6`
  4. ✅ `release/v0.6.2` branch force-updated `6abeb2a` → `d914eb6`
  5. ✅ CI Release workflow `24108444525` built NSIS installer + signed + uploaded to GitHub release
  6. ✅ PR #128 merged: `core/deploy/latest.json` updated with v0.6.2 signature (`230f490`)

**Final state on main**: `230f490 Merge pull request #128 from SamWatson86/fix/v0.6.2-signature`

**Auto-updater wiring** (verified this session, write down for next time):
  - Tauri client polls `https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json` (`tauri.conf.json:45`)
  - Control plane serves it from repo file `core/deploy/latest.json` via `file_serving.rs:46` — read on every request, hot-reloads (no server restart needed after `latest.json` changes)
  - CI uploads `latest.json` to GitHub release as an asset, but **this is not what friends fetch** — it's just the canonical generated copy. The repo file is the source of truth for live distribution.
  - **Lesson for next ship**: branch protection requires PR for `main` pushes. Don't try to push the signature commit directly — open PR (use `fix/v0.6.X-signature` branch), wait for `verify` check, merge.

**Auto-updater wiring** (verified this session, write down for next time):
  - Tauri client polls `https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json` (`tauri.conf.json:45`)
  - Control plane serves it from repo file `core/deploy/latest.json` via `file_serving.rs:46` — read on every request, hot-reloads
  - CI uploads `latest.json` to GitHub release as an asset, but **this is not what friends fetch** — it's just the canonical generated copy. The repo file is the source of truth for live distribution.

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

---

## 2026-04-11 flicker recurrence: idle/input-triggered compositor wedge

This session reproduced a third class of display instability on Sam's main RTX 4090 box while live-testing screen share and viewer watch/unwatch flows.

### Exact symptom pattern
- Main PC was publishing a WGC window share; `SAM-PC` could see it.
- After repeated watch/unwatch churn on the receiver side, Sam's main PC began flickering again.
- Flicker appeared on Monitor 1, then later on Monitor 2.
- The strongest trigger was **idle -> first input**: after stepping away briefly, the moment Sam touched the mouse or clicked a window, the monitors started flickering again.
- A UAC secure-desktop transition also caused an immediate flicker pulse on both monitors.
- Elevated recovery script did **not** clear it; full reboot was required again.

### What this rules out
- Receiver-side `Start Watching` / `Stop Watching` in `core/viewer/participants-avatar.js` does **not** call native capture start/stop. It only toggles LiveKit subscription and tile visibility.
- So this specific repro does **not** fit the older broad theory that viewer watch churn was directly restarting native capture tasks.

### What Windows showed
- During reboot, Windows showed a shutdown blocker labeled something like `Media Capture`, and Sam had to click `restart anyway`.
- System event log did **not** record a literal `Media Capture` process name. The only concrete shutdown-delay warnings at `2026-04-11 11:46:40 ET` were:
  - `F:\Codex AI\The Echo Chamber\core\sfu\livekit-server.exe`
  - `G:\Steam\bin\cef\cef.win64\steamwebhelper.exe`
- This machine does have the built-in Windows system app `Microsoft.Windows.CapturePicker` (`C:\Windows\SystemApps\Microsoft.Windows.CapturePicker_cw5n1h2txyewy`), so the reboot UI label could have been Windows capture infrastructure rather than Echo itself.
- CapabilityAccessManager entries confirm non-packaged graphics-capture access for:
  - installed Echo client: `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - packaged Echo desktop launcher
  - multiple WebView2 builds

### Current best diagnosis
- Treat this as a **local Windows compositor / MPO / power-state / display-present path problem** on Sam's daily-driver machine.
- Media/watch churn may poison the stack, but the visible failure is exposed by:
  - idle-to-active transitions
  - focus/input activity
  - secure-desktop transitions
- The `Media Capture` shutdown prompt is relevant because it suggests Windows still believed a capture session/broker was alive during reboot, but it is **not** yet proof that Echo alone was the blocker.

### Operating rule from here
- Do not continue churn/flicker stress testing on Sam's daily-driver PC.
- Use `SAM-PC` as the primary watcher/secondary endpoint for live validation.
- If this needs deeper root-cause work later, isolate with safer experiments first:
  - disable hardware-accelerated viewer composition / safe viewer mode
  - keep publish active without repeated watch churn
  - inspect DxgKrnl / GPU watchdog data separately from room media logic

### Post-reboot validation on the same machine
- Full reboot cleared the poisoned flicker state.
- After reboot, Echo was launched normally and Sam logged in with **no flicker while idle or on input** before sharing.
- Native `Windows` share (WGC window capture) of the Codex app was validated successfully:
  - `SAM-PC` could watch it
  - David could watch it
  - one clean stop/start cycle succeeded
  - no flicker during active use
  - no flicker after stepping away for ~2-3 minutes and resuming input
- Native `Screens` share (desktop/DXGI path) was also validated successfully:
  - `SAM-PC` could watch it
  - David could watch it
  - no flicker during active use
  - no flicker after brief idle/resume
- One follow-up UX note: after stopping a share, the screen-share tile took roughly **10 seconds** to disappear from the grid. That suggests stop/unpublish propagation lag still exists even though the machine remained stable.

### Current confidence after reboot
- Main PC is presently back in a **stable** state.
- Both major publish paths on the main PC are working with both LAN (`SAM-PC`) and WAN (David) receivers.
- The earlier display flicker now looks like a state-poisoning/churn problem rather than an always-on failure of normal publish/watch use.
- Reverse-direction receive path also passed: after Sam stopped sharing, David published a full-screen share and Sam could watch it locally with no flicker.
- Stop-behavior nuance now looks path-specific:
  - `Screens` / desktop share cleared from the grid immediately on stop.
  - Earlier `Windows` / WGC window share stop took roughly ~10 seconds to disappear.
  - Treat that as a separate stop/unpublish propagation bug to investigate before release, but **not** a blocker for the main post-reboot stability result.

### Release branch and packaging (v0.6.8)
- Clean release worktree created at `F:\Codex AI\The Echo Chamber\.codex\worktrees\release-v0.6.8` on branch `codex/release-v0.6.8`.
- Release set intentionally combines:
  - native/client changes from the reconnect branch (`main.rs`, `screen_capture.rs`, `desktop_capture.rs`, `capture_pipeline.rs`)
  - live-tested viewer fixes from the root checkout (`connect.js`, `identity.js`, `participants-avatar.js`, `screen-share-adaptive.js`, `screen-share-native.js`, `screen-share-state.js`, plus picker/update-banner support files)
- Release metadata bumped to `0.6.8` in:
  - `core/client/Cargo.toml`
  - `core/client/tauri.conf.json`
  - `core/control/Cargo.toml`
- In-app changelog and GitHub `CHANGELOG.md` updated for `0.6.8`.
- Local release script `core/deploy/build-release.ps1` updated to stay Windows-only and generate a Windows-only updater manifest.

### Verification on the release branch
- `node --check` passed for the touched viewer JS files.
- `cargo check -p echo-core-client` passed in `core/`.
- `cargo build -p echo-core-client --release` passed with:
  - `LK_CUSTOM_WEBRTC=F:\Codex AI\The Echo Chamber\core\target\debug\build\scratch-2a0faabf5e80148f\out\livekit_webrtc\livekit\win-x64-release-webrtc-7af9351\win-x64-release`
  - `RUSTFLAGS=-C target-feature=+crt-static`
- Produced EXE: `core\target\release\echo-core-client.exe`
- `dumpbin /imports` check confirmed `nvcuda.dll` is still in the **delay load imports** section of the shipped EXE.
- Signed NSIS bundle built successfully:
  - `core\target\release\bundle\nsis\Echo Chamber_0.6.8_x64-setup.exe`
  - `core\target\release\bundle\nsis\Echo Chamber_0.6.8_x64-setup.exe.sig`
  - `core\target\release\bundle\nsis\latest.json`

### v0.6.8 shipped
- PR `#157` merged to `main`.
- Tag `v0.6.8` pushed.
- GitHub release workflow `Release #24287070238` completed successfully:
  - Windows installer built and uploaded
  - release `latest.json` published
  - macOS job stayed disabled
- Live server checkout updated with the committed viewer files plus the published `core/deploy/latest.json`.
- `POST /admin/api/force-reload` succeeded and kicked `sam-pc-2513` from `main`.
- Server verification after deploy:
  - `/api/update/latest.json` now serves `version = 0.6.8`
  - updater URL points at `https://github.com/SamWatson86/echo-chamber/releases/download/v0.6.8/Echo.Chamber_0.6.8_x64-setup.exe`

### Native game-share publish profile hardening (2026-04-11 20:41 ET)
- New task branch/worktree created from the shipped `v0.6.8` baseline:
  - branch: `codex/native-game-publish-profile`
  - worktree: `F:\Codex AI\The Echo Chamber\.codex\worktrees\native-game-publish-profile`
- Trigger for this work: live `Crimson Desert` testing showed the native game/window share path only delivering roughly `16-18 fps` to `SAM-PC` at about `2.45 Mbps`, which is too low for a high-motion title.
- Root cause found in the native Rust publisher path:
  - `CapturePublisher` was hard-wired to the desktop-share profile for all native shares
  - game/window shares were incorrectly capped at `4 Mbps` and `30 fps`
  - desktop heartbeats were also being applied to game/window shares even though they are a poor fit for high-motion content
- Fix implemented:
  - added `PublishProfile::{Desktop, Game}` in `core/client/src/capture_pipeline.rs`
  - desktop shares keep the conservative profile: `30 fps`, `4 Mbps max`, `2.5 Mbps min`, heartbeat enabled
  - native game/window shares now use a high-motion profile: `60 fps`, `8 Mbps max`, `3 Mbps min`, heartbeat disabled
  - `screen_capture.rs` and `desktop_capture.rs` now pass the publish profile through to the native publisher and to capture-health targets
  - `main.rs` Tauri commands now accept an optional `publishProfile` argument and default older viewers to `Desktop`
  - `screen-share-native.js` now sends `publishProfile: 'game'` for native `game` sources and `publishProfile: 'desktop'` for monitor/window/desktop paths
  - `core/viewer/changelog.js` updated with the user-facing note
- Validation completed on this branch:
  - `node --check core/viewer/screen-share-native.js`
  - `node --check core/viewer/changelog.js`
  - `cargo check -p echo-core-client`
  - `cargo test -p echo-core-client capture_pipeline::tests -- --nocapture`
  - `cargo build -p echo-core-client --release`
- Runtime status:
  - build-verified only
  - not yet side-loaded into the installed client
  - no live before/after `Crimson Desert` receiver comparison yet
- Release impact for this branch is `both`:
  - desktop binary required for the new native publish profile
  - server-served viewer update required for the new `publishProfile` wiring and changelog note

### Post-midnight crash isolation for the experimental client (2026-04-12 00:30 ET)
- The experimental high-motion client build that had been side-loaded into the installed path was restored off the live machine after it caused sign-in crashes.
- Windows crash records proved the failure was real and stable:
  - `Application Error 1000`
  - `BEX64 / 0xc0000409`
  - faulting application/module: `echo-core-client.exe`
  - repeated offset: `0x0000000001e7d27d`
  - crash path: `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Important isolation result:
  - the exact same bad binary runs successfully when copied to an isolated probe path
  - it signed in successfully as both:
    - `crashprobe\echo-core-client-probe.exe`
    - `crashprobe\echo-core-client.exe`
  - that means the failure is not “this build cannot sign in” in general
  - the failure is specific to the installed-path identity/workflow
- Strongest current suspect is the updater/startup path, not the native game-share publish-profile logic itself.
- Safety hardening added on this branch:
  - client version bumped to `0.6.8-test.2`
  - auto-updater is now disabled automatically for prerelease/test builds
  - manual `check_for_updates` also returns `disabled` on prerelease/test builds
- Operational rule from here:
  - never side-load experimental builds over the live installed release path with the same release version again
  - risky client tests must use prerelease versioning and updater-disabled behavior

### v0.6.9 release-candidate prep (2026-04-12 01:35 ET)
- Created a clean release-candidate branch/worktree from the shipped `v0.6.8` manifest baseline:
  - branch: `codex/release-v0.6.9-rc`
  - worktree: `F:\Codex AI\The Echo Chamber\.codex\worktrees\release-v0.6.9-rc`
- Cherry-picked the two validated native-game-share commits from the experimental branch:
  - `449f4a9` — native game/window shares use a high-motion publish profile
  - `62ce553` — prerelease desktop builds disable the auto-updater and manual update check
- Normalized the release-candidate version to `0.6.9-rc.1` in the desktop and control manifests:
  - `core/client/Cargo.toml`
  - `core/client/tauri.conf.json`
  - `core/control/Cargo.toml`
- Added a clean top-level changelog entry for the native game-share improvement so the next release is no longer mixed into the `v0.6.8` notes.
- Release impact for this branch remains `both`:
  - desktop binary required for the native publish-profile change
  - server-served viewer update required for the `publishProfile` viewer wiring and changelog entry
- Verification on the clean RC worktree:
  - `node --check core/viewer/screen-share-native.js`
  - `node --check core/viewer/changelog.js`
  - `cargo check -p echo-core-client`
  - `cargo test -p echo-core-client capture_pipeline::tests -- --nocapture`
  - `cargo build -p echo-core-client --release`
- Clean-worktree build note:
  - the first raw `cargo check` failed because this new worktree did not have a complete local WebRTC include payload on its own
  - rerunning with `LK_CUSTOM_WEBRTC` pointed at the known-good local prebuilt payload under `F:\Codex AI\The Echo Chamber\core\target\release\build\scratch-df3657cc50cd1baa\out\livekit_webrtc\livekit\win-x64-release-webrtc-7af9351\win-x64-release` fixed that immediately
  - this was a local build-environment issue, not a code regression in the RC branch
- Additional generated files changed during RC prep:
  - `core/Cargo.lock`
  - `core/client/gen/schemas/desktop-schema.json`
  - `core/client/gen/schemas/windows-schema.json`

### v0.6.9 final release-branch prep (2026-04-12 01:42 ET)
- Promoted the RC work onto the final release task branch:
  - branch: `codex/release-v0.6.9`
- Dropped the prerelease suffix and normalized the release version to `0.6.9` in:
  - `core/client/Cargo.toml`
  - `core/client/tauri.conf.json`
  - `core/control/Cargo.toml`
  - `core/Cargo.lock`
- Installed-path smoke test completed against the real app location:
  - live install backed up to `C:\Users\Sam\AppData\Local\Echo Chamber\_lab-artifacts\2026-04-12\installed-path-rc-smoke\echo-core-client.v0.6.8-backup.exe`
  - `0.6.9-rc.1` was copied to `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - the old instant installed-path crash did **not** reproduce
  - the app stayed alive from the real installed path and was brought forward for taskbar pinning
- Release posture now:
  - code is being treated as the final `0.6.9` branch, not a local-only RC
  - next steps are final Windows artifact build, branch push, and PR creation
- Final `0.6.9` verification/build results:
  - `node --check core/viewer/screen-share-native.js`
  - `node --check core/viewer/changelog.js`
  - `cargo check -p echo-core-client`
  - `cargo build -p echo-core-client --release`
  - `powershell -ExecutionPolicy Bypass -File core/deploy/build-release.ps1`
- Local release artifacts generated successfully:
  - `core\target\release\bundle\nsis\Echo Chamber_0.6.9_x64-setup.exe`
  - `core\target\release\bundle\nsis\Echo Chamber_0.6.9_x64-setup.exe.sig`
  - `core\target\release\bundle\nsis\latest.json`
- Release-build environment note:
  - copied the existing signing key from `F:\Codex AI\The Echo Chamber\core\client\.tauri-keys` into this clean worktree so the NSIS installer and updater signature could be produced
  - reused the known-good local WebRTC payload via `LK_CUSTOM_WEBRTC` during the final build
- Installed app updated to the final release executable for live use:
  - copied `core\target\release\echo-core-client.exe` to `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - relaunched the installed app successfully from the real live path
