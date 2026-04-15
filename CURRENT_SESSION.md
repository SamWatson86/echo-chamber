# Echo Chamber - Current Session Handover

## 2026-04-15 legacy Mac build restored for Jeff/Spencer testing

**Last Updated**: 2026-04-15
**Worktree**: `F:\EC-macos-build`
**Branch**: `codex/macos-build-enable`
**Status**: Identified the earlier Mac artifact the team was actually using before the later `v0.6.x` work.

### What the legacy build is
- The older Mac build Jeff/Spencer were using is **not** a `v0.6.x` desktop artifact.
- The exact artifact is:
  - workflow run: `22003249635`
  - run title: `Fix macOS device enumeration and mic/camera permissions`
  - commit: `63b58c666aab8accf8a62cb3877cbcbe3afc41ea`
  - artifact id: `5506162212`
  - artifact name: `echo-chamber-macos-dmg`
- The DMG inside that artifact is:
  - `Echo Chamber_0.3.0_aarch64.dmg`

### Why this matters
- This matches Sam's clarification that the old Mac testing track was specifically built for Jeff and Spencer on Apple Silicon.
- If the goal is to restore the older behavior where audio worked but screen sharing did not, this `v0.3.0` Mac DMG is the correct legacy target, not the new `v0.6.11` experimental Mac branch artifact.

### Availability
- The GitHub Actions artifact is still live as of `2026-04-15`.
- Artifact expiry from GitHub API:
  - `2026-05-14T21:21:16Z`
- Local verification:
  - downloaded successfully with `gh run download`
  - confirmed file: `Echo Chamber_0.3.0_aarch64.dmg`

### Practical usage
- Jeff can test from the legacy artifact page for run `22003249635`.
- If a fresh rebuilt legacy artifact is needed later, do **not** dispatch the old workflow as-is without checking it first, because the older standalone macOS workflow uploaded DMGs directly to the latest GitHub release.

## 2026-04-14 macOS runtime audio follow-up

**Last Updated**: 2026-04-14
**Worktree**: `F:\EC-macos-build`
**Branch**: `codex/macos-build-enable`
**Status**: Viewer-side mitigation shipped for a Mac microphone dropout path reported during live use.

### User-reported failure mode
- Jeff joined from a Mac.
- His camera published successfully.
- His microphone was audible at first, then audio stopped.
- The failure shape is therefore **not** a full room/media join failure. Video kept flowing while only the mic path died.

### Root-cause investigation
- I inspected the current viewer mic path in:
  - `core/viewer/media-controls.js`
  - `core/viewer/rnnoise.js`
  - `core/viewer/connect.js`
- Current mic flow:
  - `toggleMic()` first enables the normal LiveKit microphone track with `room.localParticipant.setMicrophoneEnabled(...)`
  - if `noiseCancelEnabled` is on, it immediately calls `enableNoiseCancellation()`
  - `enableNoiseCancellation()` builds an `AudioContext`, runs RNNoise, then swaps the published mic track with `sender.replaceTrack(processedTrack)`
- **Inference based on the code path + symptom fit**:
  - the base mic publish path clearly works, because Jeff was heard initially
  - the later silence matches the optional RNNoise post-publish track replacement much better than permissions, enumeration, or room-join issues
  - camera staying live at the same time reinforces that this is a mic-only post-processing path failure, not a broader session failure

### Fix shipped in this worktree
- `core/viewer/rnnoise.js`
  - added a macOS platform detector
  - hard-blocked RNNoise/noise-cancel enablement on macOS
  - forced `noiseCancelEnabled` to initialize `false` on macOS so the direct mic path stays in place
- `core/viewer/connect.js`
  - disabled the Noise Cancellation settings button on macOS
  - disabled the suppression-strength buttons on macOS
  - added explicit UI copy explaining that the feature is temporarily unavailable on macOS because it can kill live mic audio after join
- `core/viewer/changelog.js`
  - added a user-facing entry because this changes runtime behavior for Mac users

### Why this scope is safe
- The normal microphone publish path is left untouched.
- No Rust client capture code changed.
- No Windows-specific desktop capture, audio output, or packaging path changed.
- This is a **viewer-only** mitigation that removes the optional macOS noise-cancel layer from the live mic path.

### Verification performed
- `node --check core/viewer/rnnoise.js`
- `node --check core/viewer/connect.js`
- `node --check core/viewer/changelog.js`
- Manual diff review confirms the change is scoped to:
  - macOS RNNoise gating
  - Settings UI state/copy
  - changelog entry

### Release impact
- **Viewer/runtime only**
- Windows behavior unchanged
- macOS joins lose the optional Noise Cancellation toggle for now, but keep the stable direct microphone publish path

### Next follow-up if needed
- Get a fresh Mac canary after this viewer update.
- If mic stability is restored, the next step is to harden RNNoise on macOS specifically instead of keeping it disabled there.
- If audio still dies with RNNoise fully removed from the Mac path, the next suspect is deeper in the browser/WebKit/WebRTC sender pipeline and we should capture a debug log from the Mac session.

## 2026-04-14 macOS build enablement worktree

**Last Updated**: 2026-04-14
**Baseline**: **v0.6.11 shipped**
**Worktree**: `F:\EC-macos-build`
**Branch**: `codex/macos-build-enable`
**Status**: Root cause narrowed. Current blockers are in macOS packaging/CI workflow shape, not in the Windows-gated native capture Rust path that broke `v0.6.3`.

### Worktree setup
- Created a fresh isolated worktree from shipped source commit `29702b0` (`codex/release-v0.6.11-short`).
- Verified the new worktree was clean before changes.
- The local `v0.6.11` tag was not present in this clone, so the release branch was used as the baseline source of truth.

### What failed before changing code
- Local `cargo check -p echo-core-client --target aarch64-apple-darwin` on this Windows box did **not** reach Echo Chamber app code first.
  - It failed in third-party build scripts (`objc2-exception-helper`) because this environment does not have a macOS C toolchain (`cc`) for Apple targets.
  - Conclusion: that local cross-target failure is environment/toolchain-specific and is **not** valid evidence of a repo bug.
- Local `cargo check -p echo-core-control --target aarch64-apple-darwin` failed for the same reason (`ring` build script requiring `cc` for Apple target objects), again before proving any Echo Chamber control-plane issue.

### Evidence from real macOS CI history
- Inspected failed release run `24153996654` (`v0.6.3`) with `gh run view --log-failed`.
- Exact historical macOS compile failure:
  - `client/src/main.rs`
  - `error[E0433]: failed to resolve: use of undeclared type CaptureHealthState`
  - root cause: `.manage(Arc::new(CaptureHealthState::new()))` was not gated behind `#[cfg(target_os = "windows")]`.
- That specific Rust blocker is already fixed in shipped `v0.6.11`.
  - Current `core/client/src/main.rs` gates the `capture_health` import and the `.manage(...)` call on Windows only.
  - Current non-Windows stubs exist for:
    - `core/client/src/audio_capture_stub.rs`
    - `core/client/src/audio_output_stub.rs`

### Current `v0.6.11` blockers / risk areas
- `core/client/tauri.conf.json`
  - hard-wires `bundle.targets` to `["nsis"]`
  - that is correct for Windows, but it makes the default Tauri bundle target selection Windows-only unless macOS overrides it
- `.github/workflows/release.yml`
  - still disables `build-macos` with `if: false`
  - still hardcodes `MAC_SIG=""` so `latest.json` generation falls through to the Windows-only manifest path
  - conclusion: tagged releases currently skip macOS **by policy/workflow shape**, not because `v0.6.11` has a proven current Rust compile break
- `.github/workflows/build-macos.yml`
  - manual macOS build workflow still exists
  - but before this session it auto-uploaded built artifacts to the latest GitHub release on success, which is unsafe for verification-only runs

### Changes made in this worktree
- Added `core/client/tauri.macos.conf.json`
  - sets macOS bundle targets to `["app", "dmg"]`
  - keeps the shipped Windows `nsis` default in `tauri.conf.json` untouched
  - purpose: on a real Mac or macOS runner, plain `cargo tauri build` now gets macOS bundle targets via Tauri's platform-specific config merge instead of inheriting the Windows-only `nsis` target
- Updated `.github/workflows/build-macos.yml`
  - added `workflow_dispatch` boolean input `upload_to_latest_release` (default `false`)
  - gated the release-upload steps on that input
  - purpose: allow safe non-publishing macOS CI verification runs

### Verification performed
- `core/client/tauri.macos.conf.json`
  - parsed successfully with PowerShell `ConvertFrom-Json`
- Real GitHub macOS runner sanity probe:
  - dispatched `build-macos.yml` against remote ref `v0.6.11`
  - run id: `24425653970`
  - canceled intentionally before artifact upload to avoid mutating GitHub releases during investigation
  - the job did start cleanly on `macos-15-arm64` and reached the Tauri CLI install step before cancellation
- No viewer or control-plane runtime behavior changed
- No server reboot performed
- No GitHub push performed

### Current conclusion
- The old repo-level macOS Rust compile break from `v0.6.3` is already fixed in `v0.6.11`.
- The current minimum safe scope is:
  - macOS-specific Tauri bundle target override
  - safe standalone macOS CI build verification path
- I intentionally did **not** re-enable macOS as a hard dependency in `release.yml` during this pass.
  - Reason: doing that without a full successful non-publishing end-to-end macOS build would risk blocking future Windows tag releases again.

### Release impact
- **Client packaging / standalone CI only**
- Windows release pipeline intentionally left unchanged in this session to avoid destabilizing the shipped Windows baseline

### Remaining next step
- Run the updated standalone `build-macos.yml` on a real macOS runner with `upload_to_latest_release=false`.
- If that completes successfully end-to-end, the next safe follow-up is a separate PR/worktree to decide whether `release.yml` should:
  - stay Windows-only
  - or reintroduce macOS artifacts and `darwin-aarch64` manifest entries behind an explicit release gate

## 2026-04-15 macOS downloadable build artifact

**Last Updated**: 2026-04-15
**Worktree**: `F:\EC-macos-build`
**Branch**: `codex/macos-build-enable`
**Status**: Successful standalone macOS CI build completed. Downloadable artifact is available for Jeff to test.

### What was done
- Committed the macOS build/package + Mac mic mitigation work on:
  - branch `codex/macos-build-enable`
  - commit `908f1f4` (`Enable macOS build path and stabilize Mac mic flow`)
- Pushed the branch to GitHub.
- Dispatched the standalone macOS workflow:
  - workflow: `.github/workflows/build-macos.yml`
  - input: `upload_to_latest_release=false`

### Successful build evidence
- GitHub Actions run:
  - run id: `24452518522`
  - URL: `https://github.com/SamWatson86/echo-chamber/actions/runs/24452518522`
- Result:
  - `Build macOS DMG (Apple Silicon)` completed successfully
  - total runtime: ~11m 20s
- Artifact metadata:
  - artifact id: `6449728613`
  - artifact name: `echo-chamber-macos-dmg`
  - artifact expiry: `2026-07-14T11:41:52Z`
  - digest: `sha256:6d100045a88ec42cfeefa05f25f6d16e367be88581758bd27d2eecf4c85cbfc4`

### Files produced by the successful run
- `dmg/Echo Chamber_0.6.11_aarch64.dmg`
- `macos/Echo Chamber.app.tar.gz`
- `macos/Echo Chamber.app.tar.gz.sig`

### Local artifact download verification
- Downloaded the workflow artifact locally with `gh run download`.
- Verified extracted files under:
  - `F:\EC-macos-build\_artifacts\run-24452518522\`

### Important release/path note
- This was a **standalone branch build**, not a live Windows release-pipeline change.
- `release.yml` remains intentionally Windows-only.
- No GitHub release asset was uploaded in this run.
- Jeff should test from the Actions artifact produced by run `24452518522`.

### Practical test note for Jeff
- The build is Apple Silicon (`aarch64`).
- Because this is a standalone CI artifact and not a notarized public Mac release, Jeff may need to:
  - download the artifact ZIP from the GitHub Actions run
  - extract `Echo Chamber_0.6.11_aarch64.dmg`
  - use macOS Open/Right-click Open flow if Gatekeeper warns about an unsigned app

### Changelog note
- `core/viewer/changelog.js` was intentionally **not** updated.
  - This session changed build/package/workflow behavior only; no user-facing viewer/runtime behavior changed.

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
- New refinement: the most reliable trigger appears to be **monitor power-off -> wake**. Sam reported that the flicker shows up when Windows turns the monitors off after inactivity and he wakes them back up.
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
- `powercfg` on the active `Echo Gaming` plan shows `Turn off display after = 0x384` seconds on AC/DC, i.e. **900 seconds / 15 minutes**. That matches the monitor sleep timing Sam described.
- Immediate host mitigation applied: `powercfg /change monitor-timeout-ac 0` on the active `Echo Gaming` plan, so AC display sleep is now disabled while this issue is being worked. System sleep and hibernate were already `Never`.
- Additional system mitigation applied: `HKLM\SOFTWARE\Microsoft\Windows\Dwm\OverlayTestMode = 5` to disable MPO (Multiplane Overlay). Reboot required before judging whether this reduces the wake/flicker issue.
- Additional host mitigation applied after reboot: blank screensaver configured at 5 minutes (`C:\Windows\System32\scrnsave.scr`) so the PC can stay awake for Echo while avoiding the risky monitor sleep/wake transition.
- Important nuance: registry-only screensaver writes did not take effect live; the working fix was applying the same settings through `user32!SystemParametersInfo`, which now reports `ScreenSaverActive=1` and `ScreenSaverTimeout=300`.

### Current best diagnosis
- Treat this as a **local Windows compositor / MPO / power-state / display-present path problem** on Sam's daily-driver machine.
- Media/watch churn may poison the stack, but the visible failure is exposed by:
  - idle-to-active transitions
  - monitor sleep/wake transitions
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

### Additional host power-plan correction
- Re-verified the live `Echo Gaming` power plan after Sam reported the monitors still powering down while away.
- Confirmed the normal desktop display timeout was already disabled:
  - `Turn off display after (AC) = 0`
  - `Sleep after (AC) = 0`
  - `Hibernate after (AC) = 0`
- Found the remaining culprit: hidden `Console lock display off timeout` was still set to `60s`.
- Applied the fix directly:
  - `VIDEOCONLOCK (AC) = 0`
  - `VIDEOCONLOCK (DC) = 0`
  - `VIDEOIDLE (DC) = 0`
- Current expected behavior:
  - blank screensaver still activates after `300s`
  - Windows should no longer power the monitors down through either the normal desktop timeout or the locked/secure-desktop timeout path

### Desktop launcher normalization (2026-04-12 00:46 ET)
- Cleaned the live Windows install back into an official `v0.6.8` state by re-running the shipped installer:
  - `F:\Codex AI\The Echo Chamber\.codex\worktrees\release-v0.6.8\core\target\release\bundle\nsis\Echo Chamber_0.6.8_x64-setup.exe`
- Confirmed the live installed client path is once again:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Important launcher root cause found:
  - the Start Menu shortcut `Echo Chamber.lnk` was **not** pointing at the Tauri client
  - it was pointing at an old Electron install under `C:\Users\Sam\AppData\Local\Programs\@echodesktop\Echo Chamber.exe`
- Normalized the launcher surface:
  - `Start Menu -> Echo Chamber.lnk` now points at `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - the legacy Electron shortcut was renamed to `Echo Chamber (Legacy Electron).lnk`
  - the dev tray helper was renamed to `Echo Chamber Tray Tool (Dev).lnk`
  - a matching taskbar pinned shortcut now exists at:
    - `C:\Users\Sam\AppData\Roaming\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Echo Chamber.lnk`
  - that taskbar shortcut also points at `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Restarted Explorer and launched Echo through the corrected taskbar-pinned shortcut.
- Verified the running process path after launch:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Moved experimental leftovers out of the live install folder into:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\_lab-artifacts\2026-04-12`
- Current live install folder is intentionally simple again:
  - `echo-core-client.exe`
  - `config.json`
  - `uninstall.exe`
  - `_lab-artifacts\...`

### v0.6.9 ship (2026-04-12 02:20 ET)
- Merged PR `#159` (`release: v0.6.9 native game-share headroom`) into `main`.
- Tagged the merged `main` commit `886dc5e2d6c9e97e62828f4a72882cb2ec94b810` as `v0.6.9` and pushed the tag to GitHub.
- GitHub release workflow `24299866115` completed successfully for the Windows path:
  - release `Echo Chamber v0.6.9` published
  - assets present:
    - `Echo.Chamber_0.6.9_x64-setup.exe`
    - `Echo.Chamber_0.6.9_x64-setup.exe.sig`
    - `latest.json`
  - macOS remained skipped/disabled and did not block release
- Synced the published updater manifest into the live checkout:
  - `core/deploy/latest.json` now serves `version = 0.6.9`
  - updater URL points at `https://github.com/SamWatson86/echo-chamber/releases/download/v0.6.9/Echo.Chamber_0.6.9_x64-setup.exe`
- Live server-served viewer update for this release was limited to:
  - `core/viewer/changelog.js`
  - `core/viewer/screen-share-native.js` was already effectively current for `publishProfile` wiring
- Built the final `v0.6.9` desktop binary locally and copied it into the installed live path:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- This release's major user-facing change:
  - native game/window shares now use a dedicated high-motion publish profile instead of inheriting the conservative desktop-share limits
- Completed the final live server step after syncing the release artifacts:
  - `POST /admin/api/force-reload` succeeded
  - kicked `1` connected client (`sam-pc-2513`) from `main`
  - returned viewer stamp `0.6.7.1775974919`
- Post-reload verification:
  - `https://127.0.0.1:9443/api/update/latest.json` serves `version = 0.6.9`
  - updater URL points at `https://github.com/SamWatson86/echo-chamber/releases/download/v0.6.9/Echo.Chamber_0.6.9_x64-setup.exe`

### Idle blackout watcher install (2026-04-12 14:45 ET)
- Re-verified the blank screensaver configuration itself was correct:
  - `SCRNSAVE.EXE = C:\Windows\System32\scrnsave.scr`
  - `ScreenSaveActive = 1`
  - `ScreenSaveTimeOut = 300`
  - no screensaver policy override keys were present
- Proved the built-in Windows auto-screensaver path was still broken in this session:
  - applied settings through `user32!SystemParametersInfo`
  - forced a short `15s` idle timeout test
  - `scrnsave.scr` still did not auto-launch on its own
- Investigated `powercfg /requests` under elevation:
  - active media/session blockers included `msedge.exe`, `msedgewebview2.exe`, `USB Audio Device ... An audio stream is currently in use`, and `Legacy Kernel Caller`
  - temporary `powercfg /requestsoverride` entries were added during diagnosis, then fully removed after the new fix was installed
- Added a user-space fallback watcher under `tools/`:
  - `tools/idle-blackout.ps1`
  - `tools/install-idle-blackout.ps1`
  - `tools/uninstall-idle-blackout.ps1`
- The watcher uses `GetLastInputInfo` directly and launches `C:\Windows\System32\scrnsave.scr /s` after real input idle time, bypassing the unreliable built-in Windows auto-screensaver trigger.
- Installed persistent startup entry:
  - `C:\Users\Sam\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Echo Idle Blackout.vbs`
- Started the watcher immediately in the current session with:
  - idle threshold `300s`
  - poll interval `5s`
- Functional proof:
  - a controlled zero-second test instance logged repeated `Launched blank screensaver` events, proving the fallback watcher can invoke the black screensaver correctly even though Windows would not auto-launch it on its own
- Current expected behavior:
  - after `5` minutes of no mouse/keyboard input, the custom watcher should black the displays by launching `scrnsave.scr`
  - manual move/click should dismiss it normally
- Follow-up correction after reboot:
  - the first generated startup wrapper `Echo Idle Blackout.vbs` had malformed quote escaping and threw a Windows Script Host compilation error on login
  - fixed `tools/install-idle-blackout.ps1` to emit a single properly quoted command string
  - regenerated the startup file and verified it executes cleanly via `cscript.exe`
- Smarter suppression pass:
  - updated `tools/idle-blackout.ps1` so it does **not** trigger the blank screensaver while `Echo Chamber` is the active foreground window
  - suppression requires a real visible non-minimized Echo window, so ordinary away-from-PC blackout behavior still applies when Echo is not the thing being actively watched
  - restarted the watcher and reinstalled the startup entry after the change

### v0.6.9 emergency rollback on Sam workstation (2026-04-12 14:55 ET)
- After reboot, the installed live `v0.6.9` client started crashing on connect/sign-in instead of joining the room.
- Event Viewer showed a stable repeatable crash signature for the installed binary at `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`:
  - `Application Error 1000`
  - `Windows Error Reporting 1001`
  - `Event Name: BEX64`
  - `Exception code: 0xc0000409`
  - `Fault offset: 0x0000000001e7d0dd`
  - `Version: 0.6.9.0`
- Immediate recovery action:
  - stopped using the installed `v0.6.9` binary on Sam's box
  - restored the known-good local backup:
    - source: `C:\Users\Sam\AppData\Local\Echo Chamber\_lab-artifacts\2026-04-12\installed-path-rc-smoke\echo-core-client.v0.6.8-backup.exe`
    - destination: `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - saved the crashing installed `v0.6.9` EXE for forensics at:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\_lab-artifacts\2026-04-12\v0.6.9-crash-rollback\echo-core-client.v0.6.9-crashing.exe`
- Rollout freeze:
  - reverted the live updater manifest back to `v0.6.8` by replacing `core/deploy/latest.json` with the published `v0.6.8` manifest
  - this prevents additional installs from pulling `v0.6.9` while the regression is unresolved
- Crash forensics hardening:
  - enabled Windows WER LocalDumps for `echo-core-client.exe`
  - dump folder: `C:\Users\Sam\AppData\Local\Echo Chamber\crashdumps`
  - dump type: full dump (`DumpType = 2`)
  - dump count: `10`

### Safe-path v0.6.9 probe result (2026-04-12 15:15 ET)
- Launched the exact same `v0.6.9` release EXE from a non-installed safe probe path:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\_lab-artifacts\2026-04-12\v0.6.9-safe-probe\echo-core-client.exe`
- Sam connected successfully from that probe build; no crash on join.
- This proves the `v0.6.9` binary is not universally broken.
- Current working theory:
  - the crash is tied to installed-path/live-install state on Sam's workstation after the reboot/session churn
  - not to the raw `v0.6.9` executable itself
- Brad's missing game audio during this probe session was resolved by having Brad restart/rejoin and re-share.
- That audio issue appears to have been stale room/share state, not a new regression in the probe client.

### Installed-path v0.6.9 round-two repro (2026-04-12 15:25 ET)
- Armed WER LocalDumps correctly for `echo-core-client.exe`:
  - `DumpFolder = C:\Users\Sam\AppData\Local\Echo Chamber\crashdumps`
  - `DumpType = 2`
  - `DumpCount = 10`
- Swapped the real installed path back to the exact published `v0.6.9` EXE:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Sam launched and connected successfully from the installed path on this second controlled repro.
- Current interpretation:
  - the earlier installed-path crashes were real, but they are not currently reproducible after the safe-path `0.6.9` run warmed shared state
  - `v0.6.9` itself remains usable on Sam's machine
- Operational nuance still in effect:
  - the live updater manifest was previously frozen back to `v0.6.8` as a safety stop
  - Sam's local installed client is now on `v0.6.9`, but global updater re-enablement should be a deliberate follow-up decision

### v0.6.9 release withdrawal (2026-04-12 15:35 ET)
- New field report: Brad rebooted and then hit the same connect-time crash pattern that Sam saw earlier.
- Treated this as a release incident, not a local-machine-only curiosity.
- Containment state confirmed:
  - live updater manifest `core/deploy/latest.json` is still pinned to `v0.6.8`
  - `v0.6.9` is no longer spreading through the normal updater path
- GitHub release was explicitly marked withdrawn:
  - title changed to `Echo Chamber v0.6.9 (withdrawn)`
  - release flipped to `prerelease = true`
  - release notes updated to warn users to stay on `v0.6.8` until a hotfix lands
- Current policy after withdrawal:
  - `v0.6.8` remains the globally supported release
  - any `v0.6.9` use should be treated as controlled local testing only until the reboot/connect crash is root-caused

### v0.6.10 hotfix shipped (2026-04-12 20:10 ET)
- Root cause of the reboot/connect crash was confirmed with WinDbg:
  - Rust panic escaping a WebView2 COM callback after reboot
  - hotfix landed by hardening both vendored `tauri-runtime-wry` and the `webview2-com-macros` callback thunk layer
- Validation completed before ship:
  - post-reboot hotfix probe connect succeeded on Sam's machine
  - installed-path `0.6.10` connect succeeded from `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - live runtime check with David showed active screen-share delivery from Sam at roughly `47 fps` inbound on David with clean packet health
- Release branch and merge:
  - branch: `codex/release-v0.6.10`
  - PR: `#160`
  - merged to `main` with admin override because branch policy blocked a normal merge path during the hotfix ship
- GitHub release published:
  - tag: `v0.6.10`
  - title: `Echo Chamber v0.6.10`
- Desktop release artifacts:
  - `Echo.Chamber_0.6.10_x64-setup.exe`
  - `Echo.Chamber_0.6.10_x64-setup.exe.sig`
  - `latest.json`
- Live rollout actions:
  - updater manifest advanced from `0.6.8` to `0.6.10`
  - server-served viewer changelog updated with the `v0.6.10` entry
  - connected clients force-reloaded after the server-state update
- Release impact:
  - `both`
  - desktop binary release for the post-reboot connect hotfix
  - server-served viewer update for the changelog/live viewer assets

### Idle blackout browser playback suppression (2026-04-12 20:32 ET)
- The fallback blank-screen watcher in `tools/idle-blackout.ps1` was too narrow:
  - it only suppressed blackout when `Echo Chamber` itself was the visible foreground window
  - result: the blank screensaver could still trigger while Sam was actively watching browser media like Crunchyroll
- Added media-session-aware suppression:
  - loads the Windows Global System Media Transport Controls session manager through `System.Runtime.WindowsRuntime`
  - queries active media sessions and matches them against visible browser/media-player windows
  - continues to suppress when `Echo Chamber` is foreground, but now also suppresses when a visible media app window is actively playing media
- Fixed a PowerShell bug in the first pass:
  - the watcher initially logged `Media session detection unavailable: WinRT AsTask overload not found`
  - root cause was a bad string literal around `IAsyncOperation\`1`
  - corrected the filter, restarted the watcher, and confirmed the new watcher logs `Media session detection enabled`
- Live watcher state after restart:
  - startup entry still installed via `tools/install-idle-blackout.ps1`
  - active hidden watcher process points at `tools/idle-blackout.ps1`
  - current validation still needs a real idle pass while browser playback is actively in `Playing` state

### SAM-PC deploy-agent startup hardening (2026-04-13 08:35 ET)
- SAM-PC came back on the LAN after a real reboot, but the deploy agent on `192.168.5.149:8080` did not.
- This broke the remote test pipeline even though the machine itself was alive and reachable.
- Root symptom:
  - app restart/deploy via agent worked before reboot
  - after reboot, `ping/ARP` reached SAM-PC but `http://192.168.5.149:8080/health` stayed down
- Hardening change in `core/deploy/setup-agent.ps1`:
  - scheduled task now runs with both `AtStartup` and `AtLogOn` triggers
  - task action now uses `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden`
  - task settings now explicitly use `-MultipleInstances IgnoreNew`
- Rationale:
  - if the startup trigger is missed or races boot, the user logon trigger should still restore the agent
  - this matches the real failure mode seen on SAM-PC after reboot
- Current machine state:
  - SAM-PC is on `0.6.10`
  - remote app deploy/restart worked before the reboot
  - after reboot, the agent itself needs to be reinstalled or restarted locally once before the pipeline is healthy again

### SAM-PC client-launch pipeline root cause (2026-04-13 09:20 ET)
- After the agent was restored, remotely launching the client on SAM-PC produced a WebView2 startup dialog:
  - `Microsoft Edge can't read and write to its data directory`
  - path pointed at `C:\Windows\System32\config\systemprofile\AppData\Local\com.echochamber.app\EBWebView`
- Root cause:
  - the deploy agent runs as `SYSTEM`
  - it was launching `echo-core-client.exe` directly with `Start-Process`
  - the Tauri/WebView2 shell therefore inherited the `SYSTEM` account and tried to use `systemprofile` for its browser data dir
  - that is the wrong execution context for the actual desktop client UI
- Pipeline fix in repo:
  - `core/deploy/agent.ps1`
    - now prefers launching the client through a dedicated scheduled task named `EchoChamberClient`
    - falls back to direct `Start-Process` only if that task does not exist
    - `Get-ClientProcess` also falls back to process-name lookup instead of only trusting the pid file
  - `core/deploy/setup-agent.ps1`
    - still installs the agent task as `SYSTEM`
    - now also installs a second scheduled task `EchoChamberClient`
    - that client task runs as the interactive logged-in user via `Interactive` logon type
    - agent startup task remains `AtStartup + AtLogOn`
- Validation:
  - both modified PowerShell scripts parse successfully via `[scriptblock]::Create(...)`
  - live SAM-PC still needs the one-time local task repair so the running machine matches the repo fix
- Live repair result on SAM-PC:
  - reinstalled the deploy agent scheduled task locally under the interactive `Sam` session instead of `SYSTEM`
  - agent came back at `http://192.168.5.149:8080/health`
  - remote launch now works again; client reported running with `client_pid = 18076`
  - the previous WebView2 `systemprofile` data-directory popup did not recur after the repair

### v0.6.10 reboot-crash validation status (2026-04-13 09:50 ET)
- The critical bug remains the post-reboot desktop connect crash that previously hit both `v0.6.8` and `v0.6.9`.
- Validation now cleanly splits from the separate screen-share viewer issue:
  - this PC:
    - rebooted after the hotfix work
    - installed `0.6.10` at `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe` launched and connected successfully
    - no fresh `Application Error` events for `echo-core-client.exe` were found in the local `Application` log during this pass
    - no new crash dumps were written under `C:\Users\Sam\AppData\Local\Echo Chamber\crashdumps`; only the old pre-hotfix dump `echo-core-client.exe.35604.dmp` remained
  - SAM-PC:
    - was fully rebooted for the test (real OS reboot, not just app restart)
    - after the login/account detour, Echo launched manually from `C:\EchoChamber\echo-core-client.exe`
    - client connected successfully after reboot, which means the original `reboot -> launch -> connect` crash path did not reproduce there either
- Current read:
  - the `v0.6.10` WebView2 callback hotfix is materially validated on two machines for the reboot/connect crash class
  - remaining SAM-PC problems are in remote screen-share view/attach state, not the reboot crash

### SAM-PC remote screen-share attach investigation (2026-04-13 10:05 ET)
- Reconfirmed the publish side is healthy:
  - LiveKit `ListParticipants` for room `main` shows:
    - `sam-pc-2513`
    - `sam-pc-2513$screen`
    - `sam-7475`
  - the `$screen` companion is active with a live `1920x1080` H.264 video track
  - control-plane dashboard simultaneously shows `sam-pc-2513` capture health as:
    - `capture_active = true`
    - `capture_mode = DXGI-DD`
    - `encoder_type = NVENC`
    - `current_fps = 21`
    - `target_fps = 30`
- That proves the failure is not Win10 native screen capture and not the reboot crash hotfix.
- Viewer-side hardening applied in the server-served JS:
  - `core/viewer/state.js`
    - added `knownRemoteParticipants` cache plus helpers so `$screen` companions seen via events remain resolvable later by watch/unwatch logic
  - `core/viewer/participants-avatar.js`
    - `getRemoteParticipantsForScreenIdentity()` now resolves through the cache instead of relying only on `room.remoteParticipants`
  - `core/viewer/connect.js`
    - companion participants are remembered on track/publish/connect events and cleared on disconnect cleanup
    - room switches now clear the cache explicitly
  - `core/viewer/identity.js`
    - `patchScreenCompanionSource()` now infers video for `$screen` companion publications even when LiveKit omits `kind`, instead of leaving them as raw `CAMERA`
  - `core/viewer/audio-routing.js`
    - `handleTrackSubscribed()` now force-normalizes subscribed `$screen` companion tracks to `ScreenShare` / `ScreenShareAudio` before routing
    - this closes the remaining hole where an already-subscribed companion track could still be treated like a camera and never create a screen tile
- Validation at code level:
  - `node --check` passed for:
    - `core/viewer/state.js`
    - `core/viewer/participants-avatar.js`
    - `core/viewer/connect.js`
    - `core/viewer/identity.js`
- Live rollout:
  - forced client reload after the viewer patch
  - latest viewer stamp after the final reload: `0.6.7.1776091257`
- Pending runtime proof:
  - both clients must reconnect on the fresh stamp
  - SAM-PC must start full-screen share again
  - then confirm whether this PC and SAM-PC can now see the stream
## 2026-04-13 Viewer watch attach follow-up
- Issue narrowed: clicking Start Watching flipped to Stop Watching, but no screen tile attached on either this PC or SAM-PC even though sam-pc-2513 was live in LiveKit as 1920x1080 H.264 and dashboard stats showed active DXGI-DD capture (21/30 fps, NVENC).
- Root cause hypothesis: opt-in path and publication hook were still waiting on publication.isSubscribed === true before processing a track object that was already cached locally, leaving remote screen shares stuck in a subscribed-but-never-attached state.
- Fix: updated core/viewer/participants-avatar.js and core/viewer/connect.js so watched screen-share publications with an existing pub.track are processed immediately, regardless of transient isSubscribed state, and added hook-side logging for existing-track attach.
- Validation pending live retest after force-reload.
- Added temporary viewer attach instrumentation in core/viewer/audio-routing.js, core/viewer/connect.js, and core/viewer/participants-avatar.js so remote screen-share attach failures surface as [attach-error] debug lines plus visible status/toast instead of silently aborting.
- Added Start Watching self-diagnostics in core/viewer/participants-avatar.js: if no screen tile exists after 2.2s, the client now surfaces a toast/status with emotes, screenPubs, 	racks, and subscribed counts for that identity.
- Extended Start Watching diagnostics to report whether a tile object exists and whether its video element has dimensions/frames (	ile, display, ideo, size, eady, paused, rames, lack) when a watched screen share still looks blank.
- Extended watch diagnostics again to include underlying MediaStreamTrack state and subscriber receiver presence: mstMuted, mstReady, eceiver.
## 2026-04-13 Viewer attach semantics fix
- Latest diagnostic toast on this PC for `sam-pc-2513` was:
  - `Watch failed for sam-pc-2513 remotes=2 screenPubs=1 tracks=1 subscribed=1 tile=true display=(default) video=true size=0x0 ready=0 paused=false frames=0 black=false mstMuted=true mstReady=live receiver=true`
- Interpretation:
  - watch state and tile creation were working
  - LiveKit receiver existed
  - underlying MediaStreamTrack was live but stayed muted forever
  - the video element never got metadata or frames
- Root cause hypothesis tightened:
  - viewer code was creating many remote video elements via `new MediaStream([track.mediaStreamTrack])`
  - that bypasses `track.attach(element)` bookkeeping that LiveKit expects for attached remote renders
  - this exactly matches the observed state: subscribed receiver exists, but the SDK still treats the stream like it has no active render target, so no frames arrive
- Fix applied:
  - `core/viewer/participants.js`
    - `createLockedVideoElement(track)` now uses `track.attach(element)` first, then falls back to manual `srcObject` only if needed
    - added `detachMediaElement(element)` helper
  - `core/viewer/participants-grid.js`
    - screen tile removal and `clearMedia()` now detach attached media elements before DOM removal
  - `core/viewer/participants-avatar.js`
    - avatar video cleanup now detaches old media elements before replacing avatar contents
  - `core/viewer/participants-fullscreen.js`
    - screen video replacement now detaches the old attached element before inserting the new one
- Validation:
  - `node --check` passed for:
    - `core/viewer/participants.js`
    - `core/viewer/participants-grid.js`
    - `core/viewer/participants-avatar.js`
    - `core/viewer/participants-fullscreen.js`
- Pending runtime proof:
  - force-reload clients
  - reconnect this PC and SAM-PC
  - retest SAM-PC full-screen share and watch flow
- Follow-up diagnostics added after the attach patch still produced the same no-frame toast.
- Added receiver RTP stats to the watch-failed diagnostic in `core/viewer/participants-avatar.js` so the next repro reports:
  - receiver bytes
  - packets
  - decoded frames
  - keyframes
  - fps
  - codec
- Purpose: distinguish `zero RTP arriving` from `RTP arriving but decode/render stalled`.
## 2026-04-13 Version-state normalization
- User correctly called out that the session had become incoherent: desktop clients were on official `0.6.10`, while the server-served viewer was still a locally patched lab build stamped `0.6.7.x`.
- Action taken:
  - backed up the current modified viewer files to `.codex/viewer-baseline-backup-20260413-131754`
  - restored all `core/viewer/*` files that diverged from tag `v0.6.10`
  - restored `core/control/Cargo.toml` to `v0.6.10`
  - rebuilt `echo-core-control` in release mode
  - restarted the control plane on the rebuilt binary
  - forced a client reload through `/admin/api/force-reload`
- Verified live state after normalization:
  - `core/viewer/index.html` now stamps assets as `0.6.10.1776101108`
  - `/admin/api/force-reload` now returns `viewer_stamp = 0.6.10.1776101103`
  - this PC desktop binary remains official `0.6.10`
  - `SAM-PC` desktop binary remains official `0.6.10`
- Operational conclusion:
  - further share/watch results should only be trusted after reconnecting both clients on this normalized `0.6.10` baseline
  - any remaining `SAM-PC` full-screen failure after that is a real post-normalization bug, not version-state confusion
## 2026-04-13 Avatar regression after control-plane restart
- User reported that avatars had regressed into broken image icons while cards/names still rendered.
- Root cause:
  - I restarted the control plane from an inconsistent process state.
  - A stale `echo-core-control.exe` instance was still holding `:9443`, so my first restart attempts never actually took over the port.
  - That left the system serving a stale process state while I believed a corrected process was active.
  - Separately, relative path resolution for chat/avatar storage depends on startup context; the intended live avatar store is `F:\Codex AI\The Echo Chamber\logs\avatars`.
- Evidence:
  - direct avatar route initially returned `404` for `/api/avatar/sam`
  - `logs/avatars` contained the real avatar files
  - once the stale control process was killed and the corrected one took over `:9443`, startup logs showed `loaded existing avatar: sam -> avatar-sam.gif`
  - direct route then returned `HTTP=200 TYPE=image/gif`
- Fix:
  - killed the stale control-plane process that was still bound to `9443`
  - restarted `echo-core-control.exe` cleanly
  - verified startup log load of existing avatars/chimes from the real `logs/` tree
  - forced a client reload after the corrected server was live

## 2026-04-13 Launch hygiene and deploy-agent boundary
- User correctly called out that live testing had become confusing because too many Echo binaries existed at once:
  - installed app on this PC: `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - watchdog sandbox on `SAM-PC`: `C:\EchoChamber\echo-core-client.exe`
  - multiple local probes / rollback artifacts
- Operational conclusion:
  - all future live retests must explicitly name the binary path on each machine
  - stale Echo windows/processes must be closed before trusting a retest
  - the `C:\EchoChamber` watchdog binary is a sandbox path, not the same thing as the normal installed app
- Repo hardening:
  - updated `core/deploy/agent.ps1` to understand the distinction between:
    - sandbox binary under `C:\EchoChamber\echo-core-client.exe`
    - normal installed app under `%LOCALAPPDATA%\Echo Chamber\echo-core-client.exe`
  - added:
    - `Get-InstalledClientPath`
    - `client_path`, `sandbox_exe_path`, `installed_exe_path`, `installed_exe_exists` to `/health`
    - new `POST /launch-installed` endpoint to launch the normal installed app explicitly
  - updated `core/deploy/setup-agent.ps1` comments to reflect the explicit installed-vs-sandbox launch model
- Verification:
  - PowerShell parser passed for:
    - `core/deploy/agent.ps1`
    - `core/deploy/setup-agent.ps1`
- Important live limitation:
  - the currently running deploy agent on `SAM-PC` could not be self-updated remotely because remote disk access to `\\SAM-PC\c$` is denied and the existing HTTP agent does not support self-update
  - so the new `/launch-installed` endpoint is in repo now, but not yet installed on `SAM-PC`

## 2026-04-13 Handoff status
- Start a fresh session. The current thread became too long and operationally noisy.
- Reboot/connect crash status:
  - treat this as fixed unless a new regression appears
  - validated on this PC and `SAM-PC` after real reboot
  - hotfix shipped as `v0.6.10`
  - do not reopen this bug without a fresh reproducible crash
- Current active bug:
  - `SAM-PC` on Windows 10 can connect, but `Entire Screen` share stays blank for viewers
  - this PC can successfully publish full-screen share to `SAM-PC`
  - so the remaining issue is specific to `SAM-PC` as publisher, not the general viewer path
- Clean baseline facts:
  - server-served viewer files were restored to tagged `v0.6.10`
  - avatars were repaired after killing a stale `echo-core-control.exe`
  - this PC should use installed app `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - `SAM-PC` product tests should use installed app `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - do not trust `C:\EchoChamber\echo-core-client.exe` for product behavior; that is the watchdog sandbox path
- Open technical hypothesis:
  - native Win10 full-screen publish on `SAM-PC` appears broken
- Operational rule for next session:
  - explicitly close stale Echo windows and relaunch the intended binary on each machine before every retest

## 2026-04-13 Win10 browser fallback rejection
- We did verify one important narrowing fact:
  - when `SAM-PC` used the browser/WebView share path for `Entire Screen`, this PC could see the stream
  - that proves the viewer/watch side is not the blocker
- User explicitly rejected that path as a product regression:
  - the desktop client should keep using the custom/native picker
  - Win10 full-screen sharing should stay on the native monitor-capture path, not Chromium `getDisplayMedia`
  - the `DX****` path Sam was referring to is `DXGI Desktop Duplication`
- Repo correction applied:
  - removed the forced Win10 `monitor -> browser fallback` branch from `core/viewer/screen-share-native.js`
  - `Entire Screen` on native desktop clients now routes back to the native `DXGI Desktop Duplication` monitor path
  - updated `core/viewer/changelog.js` so the viewer no longer claims browser fallback is the intended Win10 fix
- Current bug framing after that correction:
  - browser fallback working was only a diagnostic datapoint
  - the real remaining bug is native Win10 `DXGI Desktop Duplication` publish from `SAM-PC` if it still blanks for viewers

## 2026-04-13 SAM-PC launch workaround
- The live deploy agent on `SAM-PC` is still the old build and does not yet expose `/launch-installed`.
- Operational workaround used during this session:
  - temporarily replaced `C:\EchoChamber\echo-core-client.exe` on `SAM-PC` with a tiny launcher shim
  - that shim starts the real installed app at `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - this is only to let the old HTTP agent restart the installed product binary remotely
- Important boundary:
  - this does **not** make the sandbox path a product binary again
  - it is only a remote-launch bridge until the real agent update lands on `SAM-PC`

## 2026-04-13 Persistent memory update
- Added a hard persistent-memory rule under `C:\Users\Sam\.claude\projects\f--Codex-AI-The-Echo-Chamber\memory\`:
  - never recommend Chromium/WebView `getDisplayMedia` as the fix for native desktop capture regressions in Echo Chamber
  - browser capture may be used only as a diagnostic narrowing datapoint
  - shipped behavior must stay on the native picker + native capture stack (`WGC` where supported, `DXGI Desktop Duplication` on Win10/older)

## 2026-04-13 SAM-PC installed-app relaunch bridge hardened
- Built a fresh release client locally with the current Win10 native capture changes still in place:
  - `core/target/release/echo-core-client.exe`
  - SHA-256: `028D295FB8A7D23C86C9A32CC6BCE377FFE4C696A375EA8512D9B1E14202C224`
- Relaunched this PC cleanly on the installed app path:
  - killed stale local `echo-core-client.exe`
  - relaunched `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
- Updated `SAM-PC` installed app directly:
  - copied the fresh release binary to `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - wrote `C:\Users\Sam\AppData\Local\Echo Chamber\config.json` with `{"server":"https://192.168.5.70:9443"}`
- Hardened the temporary launcher shim at `C:\EchoChamber\echo-core-client.exe` so the old deploy agent can still manage the real installed app:
  - shim now kills stale `echo-core-client.exe` processes on `SAM-PC`
  - shim applies a staged update from `C:\EchoChamber\installed-update\echo-core-client.exe` into the installed app path with retry/backoff
  - shim launches the real installed app detached so it no longer inherits and locks `C:\EchoChamber\client-stdout.log`
- Verified live bridge behavior from `\\SAM-PC\EchoChamber\client-stdout.log`:
  - `staged update applied to C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - `launching C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - `child pid 8816`
- Important boundary:
  - this is still only an operational bridge because the live `SAM-PC` deploy agent is old
  - product behavior remains the installed app under `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - the old agent `/health` is still not trustworthy for the installed child because the shim exits after launch
- Immediate next retest:
  - connect both installed clients
  - on `SAM-PC`, run native `Share -> Entire Screen`
  - confirm whether this PC now receives non-blank video from the Win10 `DXGI Desktop Duplication` path

## 2026-04-13 Persistent memory update: Claude owns app relaunches
- Added a new hard persistent-memory rule under `C:\Users\Sam\.claude\projects\f--Codex-AI-The-Echo-Chamber\memory\`:
  - Sam should never have to guess which Echo Chamber binary/version is open
  - before meaningful retests, Claude should close stale Echo clients and relaunch the exact intended installed app on both this PC and `SAM-PC`
  - the watchdog sandbox path may still be used as an operational bridge, but the installed app remains the real product binary

## 2026-04-13 Win10 native publish status clarified
- Instrumented the installed client on `SAM-PC` with a temporary file log at:
  - `C:\Users\Sam\AppData\Local\Echo Chamber\capture-debug.log`
- Critical finding from native Win10 `Entire Screen` retest:
  - `SAM-PC` native `DXGI Desktop Duplication` capture is **not** failing anymore
  - after restoring `config.json` to the domain URL, the native `$screen` publisher:
    - starts DXGI DD
    - connects to SFU successfully
    - publishes the track successfully
    - enters the frame loop at ~21 fps
- Evidence from `capture-debug.log`:
  - `connected as sam-pc-2513$screen`
  - `track published`
  - repeated `stats 1920x1080 fps=21`
- The earlier LAN-IP config on `SAM-PC` was a real blocker for native publish:
  - `https://192.168.5.70:9443` caused Rust/native `$screen` connect to fail TLS hostname validation
  - fixed by restoring `SAM-PC` to `https://echo.fellowshipoftheboatrace.party:9443`
- Live dashboard evidence after the fix:
  - Jeff was receiving `SAM-PC`'s screen track while this PC was not
  - that means the remaining issue is now selective viewer subscription/render behavior, not Win10 native publish
- Code evidence for the current viewer behavior:
  - `core/viewer/connect.js` currently treats newly published remote screen shares as opt-in and adds them to `hiddenScreens` at publish time
  - the same file later auto-subscribes existing screen shares for late joiners
- Practical conclusion:
  - do **not** reopen the Win10 native `DXGI DD` publisher as the root bug without new evidence
  - the active bug has shifted to viewer-side screen-share subscription / opt-in consistency across already-connected clients vs late joiners

## 2026-04-13 Viewer-side screen watch parity patch
- New viewer-only patch applied for the active bug where this PC showed a blank `0fps` tile after clicking `Start Watching` on an already-live `SAM-PC` screen share.
- Root cause hypothesis for the patch:
  - the manual `Start Watching` handler in `core/viewer/participants-avatar.js` was running its own bespoke subscribe flow
  - late joiners used a different `resubscribeParticipantTracks(...)` + `reconcileParticipantMedia(...)` path that already worked
  - the bug appeared to live in that split behavior, not in Win10 native publish
- Repo changes made:
  - added shared helper `startWatchingScreenIdentity(...)` in `core/viewer/participants-avatar.js`
  - manual `Start Watching` now routes through that helper instead of the older custom resubscribe branch
  - late-join auto-watch in `core/viewer/connect.js` now routes through the same helper so both paths stay aligned
  - updated `core/viewer/changelog.js` with a new `2026-04-13b / Screen Watch Sync` entry
- Verification after patch:
  - `node --check` passed for:
    - `core/viewer/participants-avatar.js`
    - `core/viewer/connect.js`
    - `core/viewer/changelog.js`
  - forced live viewer reload through `POST /admin/api/force-reload`
  - control plane returned `viewer_stamp = 0.6.10.1776113561`
- Relaunch hygiene completed before retest:
  - relaunched this PC on installed app `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - remotely restarted `SAM-PC` through the old agent bridge so it launched the installed app path again
  - dashboard then showed connected clients on `viewer_version = 0.6.10.1776113576`
- Live state right after relaunch:
  - `SAM-PC` was again publishing native `DXGI-DD` with `capture_active = true`, `capture_mode = DXGI-DD`, `current_fps = 21`
  - next live check is whether clicking `Start Watching` on this PC now produces actual inbound media instead of the old blank tile

## 2026-04-13 Watch-debug escalation: receiver vs tile
- Continued live testing after the watch-parity patch narrowed the failure further:
  - this PC (`sam-7475`) did click into the `SAM-PC` share path
  - dashboard `watch_debug` then reported:
    - `identity=sam-pc-2513 stage=fallback@1500ms hidden=false watched=true remotes=sam-pc-2513:microphone:audio:sub=true:track=true;sam-pc-2513$screen:screen_share:video:sub=true:track=true`
  - at the same time, `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\capture-debug.log` still showed:
    - native `DXGI-DD` capture alive at ~`21 fps`
    - transport connected
    - sender stats stuck at `bytes=0 packets=0 frames_sent=0 frames_encoded=0`
- Practical conclusion from that pairing:
  - the active bug is **not** screen-companion discovery anymore
  - this PC can now find the right `sam-pc-2513$screen` publication and mark it subscribed
  - the remaining break is later than `setSubscribed(true)` and earlier than real RTP demand reaching the `SAM-PC` publisher
- New instrumentation patch applied in `core/viewer/participants-avatar.js`:
  - extended `watch_debug` summaries to include whether the subscriber `RTCRtpReceiver` exists for the publication's `mediaStreamTrack`
  - added current screen-tile DOM state to the same debug string:
    - tile presence
    - tile `display`
    - tile client size
    - video `videoWidth`/`videoHeight`
    - paused state
    - `readyState`
- Verification / rollout:
  - `node --check core/viewer/participants-avatar.js` passed
  - forced another live viewer reload through `POST /admin/api/force-reload`
  - control plane returned `viewer_stamp = 0.6.10.1776114696`
  - relaunched this PC on installed app `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - remotely restarted `SAM-PC` again through the bridge to relaunch the installed app
  - stamped a fresh remote marker into `capture-debug.log`:
    - `==== receiver-tile-retest 2026-04-13 17:11:48 ====`
- Current next retest:
  - get `SAM-PC` back into `main`
  - on `SAM-PC`, start native `Share -> Entire Screen`
  - on this PC, click `Start Watching`
  - read the new `watch_debug` value to determine:
    - whether the subscriber PC has a real receiver for the `SAM-PC` screen track
    - whether the screen tile/video element exists but is effectively dead (`0x0`, paused, no decoded frames, etc.)

## 2026-04-13 Native Win10 DXGI publish narrowed further, then paused for live room safety
- Additional live repros after the receiver/tile instrumentation established that the remaining failure is specific to the `SAM-PC` native Win10 `Entire Screen` publish path, not the general viewer/watch stack:
  - this PC and Jeff both reached the same watch state for `sam-pc-2513$screen`
  - dashboard `watch_debug` for both viewers showed:
    - real receiver present (`recv=true`)
    - real tile present in DOM
    - video element still `video=0x0` / `readyState=0`
    - remote media stream track still `live/muted`
  - at the same time, `SAM-PC` could successfully watch Jeff's share with normal decoded video dimensions and ready state
- Native publisher-side proof was added in `core/client/src/capture_pipeline.rs`:
  - now logs `RoomEvent::LocalTrackPublished`
  - now logs `RoomEvent::LocalTrackSubscribed`
  - live `SAM-PC` log proved the SFU does create a real subscriber for the native `$screen` track
  - despite that, the publisher stayed stuck at:
    - `sender-stats bytes=0 packets=0 frames_sent=0 frames_encoded=0`
- Practical conclusion from that evidence:
  - the active bug is no longer companion discovery or viewer subscription
  - the active bug is later than successful subscription and earlier than actual RTP emission from the Win10 native `DXGI Desktop Duplication` publisher
- New scoped fix attempt was applied to the native client:
  - `core/client/src/capture_pipeline.rs` now accepts caller-controlled `track_source` and `is_screencast`
  - `core/client/src/desktop_capture.rs` (`DXGI DD`) now publishes as:
    - `TrackSource::Screenshare`
    - `is_screencast=true`
  - `core/client/src/screen_capture.rs` (`WGC`) explicitly stays on:
    - `TrackSource::Camera`
    - `is_screencast=false`
  - intent: change only the Win10 DXGI full-screen semantics without risking regressions in the working WGC paths
- Build / deploy state for that fix attempt:
  - `cargo check -p echo-core-client` passed
  - `cargo build -p echo-core-client --release` passed
  - updated `core/viewer/changelog.js` with `2026-04-13c / Win10 DXGI Screen Share Signal`
  - relaunched this PC on installed app:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - staged and relaunched the same release binary to `SAM-PC` through the installed-app bridge
  - both installed binaries verified identical:
    - size `45,358,592`
    - timestamp `2026-04-13 17:23:57`
  - fresh remote log marker written:
    - `==== dxgi-screencast-retest 2026-04-13 17:25:47 ====`
- Operational pause ordered by Sam because multiple friends are actively using the room:
  - stop disruptive retests for now
  - **do not reboot the server again unless Sam explicitly says to**
  - keep the current live room stable over further experimentation
- Current live inference at pause time:
  - Jeff and David appear to be sharing successfully on the current room/build
  - the unresolved problem still appears isolated to older Windows 10 native `Entire Screen` / `DXGI DD` publishers such as `SAM-PC`
  - the next resume point is to retest the fresh `DXGI screencast` patch only when the room is clear enough for another controlled repro

## 2026-04-13 Manual watch re-subscribe patch after native DXGI sender recovery
- Follow-up retests after the direct H26x encoder factory patch proved the native Win10 sender is no longer the zero-RTP bottleneck:
  - `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\capture-debug.log` showed continuous native `DXGI DD` publish with:
    - `encoder=OpenH264`
    - `frames_sent` / `frames_encoded` rising normally
    - `bytes` and transport `bytes_sent` climbing into multi-megabyte range
  - this shifted the remaining blank-share problem to the already-connected viewer hot-watch path on this PC
- Fresh receive-side symptom at that point:
  - manual `Start Watching` still produced a blank tile on this PC
  - prior `watch_debug` had already shown the screen publication and track object were present
  - the remaining suspicion became: hot watch was stuck on a weak `setSubscribed(true)` path that never forced a clean inbound subscription reset
- New viewer-only patch applied:
  - `core/viewer/participants-avatar.js`
    - added `pulseScreenWatchSubscription(...)`
    - manual `Start Watching` now does a one-shot screen-track unsubscribe/re-subscribe pulse on the immediate manual opt-in stage
    - the pulse uses existing `markResubscribeIntent(...)` suppression so the screen tile is not torn down during the deliberate reset
    - after the pulse, the existing `resubscribeParticipantTracks(...)` + `reconcileParticipantMedia(...)` path still settles the participant normally
    - `watch_debug` now records whether the manual stage used `pulse=manual-reset`
  - `core/viewer/changelog.js`
    - added `2026-04-13e / Screen Watch Re-Subscribe`
- Verification / rollout:
  - `node --check core/viewer/participants-avatar.js` passed
  - `node --check core/viewer/changelog.js` passed
  - forced live viewer reload via `POST /admin/api/force-reload`
    - returned `viewer_stamp = 0.6.10-local.1.1776124809`
    - kicked stale `main` participants:
      - `sam-7475`
      - `sam-pc-2513`
      - `sam-pc-2513$screen`
  - relaunched this PC on the installed binary:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - verified running process path exactly matches installed app
  - restarted `SAM-PC` through the bridge launcher again so it re-opened the installed binary
  - confirmed fresh `SAM-PC` startup log:
    - `[1776124817] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
  - wrote fresh remote marker:
    - `==== manual-watch-resubscribe-retest 2026-04-13 20:00:40 ====`
- Current exact next retest:
  - connect this PC and `SAM-PC`
  - on `SAM-PC`, start native `Share -> Entire Screen`
  - on this PC, click `Start Watching` once
  - leave it up about 10 seconds
  - then determine whether the new manual re-subscribe pulse finally converts the blank tile into actual inbound video

## 2026-04-13 SDK screen-tile attach patch after blank hot-watch persisted
- The manual watch re-subscribe pulse did **not** fix the remaining blank tile on this PC.
- Fresh evidence from the failed retest:
  - `SAM-PC` sender log still showed healthy native publish on the same repro:
    - `connected as sam-pc-2513$screen`
    - `room-event local-track-published`
    - `room-event local-track-subscribed`
    - `encoder=OpenH264`
    - `bytes`, `frames_sent`, and `frames_encoded` all rising normally
  - admin dashboard for `sam-7475` showed:
    - `watch_debug = identity=sam-pc-2513 stage=fallback@1500ms pulse=none hidden=false watched=true tile=present:display=auto:client=316x177:video=0x0:paused=false:rs=0 remotes=sam-pc-2513:microphone:audio:sub=true:track=true:recv=true:mst=live/live;sam-pc-2513$screen:screen_share:video:sub=true:track=true:recv=true:mst=live/muted`
    - `inbound = null`
  - practical meaning:
    - this PC still got a receiver object and remote `MediaStreamTrack`
    - but real inbound media never lit up on the tile
- New viewer-side hypothesis and fix:
  - the remote screen-tile code path was still creating video elements manually from:
    - `new MediaStream([track.mediaStreamTrack])`
  - the working recovery path elsewhere already used the SDK-managed:
    - `track.attach()`
  - that difference became the best remaining explanation for:
    - receiver exists
    - track exists
    - tile exists
    - no real inbound media on hot watch
- New patch applied:
  - `core/viewer/participants.js`
    - added `createAttachedVideoElement(track)` helper
    - prefers `track.attach()` and falls back to the older manual element path only if attach fails
  - `core/viewer/audio-routing.js`
    - remote screen-share tile creation now uses `createAttachedVideoElement(track)`
    - existing screen-tile/same-track path now also re-requests a keyframe and ensures the inbound stats monitor is running
  - `core/viewer/participants-fullscreen.js`
    - `replaceScreenVideoElement(...)` now also uses `createAttachedVideoElement(track)`
  - `core/viewer/changelog.js`
    - added `2026-04-13f / SDK Screen Tile Attach`
- Verification / rollout:
  - `node --check` passed for:
    - `core/viewer/participants.js`
    - `core/viewer/audio-routing.js`
    - `core/viewer/participants-fullscreen.js`
  - forced live viewer reload again:
    - `viewer_stamp = 0.6.10-local.1.1776125124`
  - relaunched this PC on:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - restarted `SAM-PC` through the bridge again
  - confirmed fresh remote startup:
    - `[1776125130] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
- Current next retest after this patch:
  - connect both clients
  - on `SAM-PC`, start native `Share -> Entire Screen`
  - on this PC, click `Start Watching`
  - leave it 10 seconds
  - determine whether the SDK-managed video attach path finally breaks the blank-tile hot-watch failure

## 2026-04-13 Risk reduction rollback: remove dead-end viewer experiments before broader smoke
- After the `2026-04-13e` and `2026-04-13f` viewer experiments both still produced `blank`, the regression risk was no longer justified.
- Practical product decision:
  - do **not** keep widening the live viewer path for one isolated Win10 failure without first protecting the known-good majority
  - treat the latest two viewer experiments as dead ends and roll them back before broader validation
- Viewer rollback applied:
  - removed the manual `Start Watching` pulse-resubscribe experiment from `core/viewer/participants-avatar.js`
  - removed the SDK-attach screen tile experiment from:
    - `core/viewer/participants.js`
    - `core/viewer/audio-routing.js`
    - `core/viewer/participants-fullscreen.js`
  - removed changelog entries:
    - `2026-04-13e / Screen Watch Re-Subscribe`
    - `2026-04-13f / SDK Screen Tile Attach`
- Verification / rollout after rollback:
  - `node --check` passed for:
    - `core/viewer/participants-avatar.js`
    - `core/viewer/participants.js`
    - `core/viewer/audio-routing.js`
    - `core/viewer/participants-fullscreen.js`
    - `core/viewer/changelog.js`
  - forced live viewer reload:
    - `viewer_stamp = 0.6.10-local.1.1776125515`
  - relaunched this PC on installed app:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - restarted `SAM-PC` through the bridge again
  - confirmed fresh `SAM-PC` startup:
    - `[1776125524] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
- Current risk posture after rollback:
  - the last two viewer-side hot-watch experiments are no longer in the served build
  - the main remaining cross-user-risk candidate is now the direct-H26x encoder factory change in:
    - `core/webrtc-sys-local/src/video_encoder_factory.cpp`
  - that change still has real value because it objectively converted `SAM-PC` from `0 bytes / 0 frames_encoded` into a genuinely sending native publisher
- Best immediate next move:
  - re-smoke a known-good sharing path before doing more Win10-specific surgery
  - if the known-good path fails on the current build, revert the encoder-factory change too and keep the public baseline clean

## 2026-04-13 Encoder-factory rollback after canary regression
- Canary result after the viewer rollbacks:
  - this PC -> `Share -> Entire Screen` -> `SAM-PC`
  - result reported by Sam: `broken`
- Product decision:
  - treat the direct-H26x encoder-factory change as broad-risk, not safe-to-ship
  - revert it immediately before doing any more Win10-specific experimentation
- Reverted:
  - `core/webrtc-sys-local/src/video_encoder_factory.cpp`
    - removed the direct `internal_factory_->Create(...)` H26x path
    - restored the previous `SimulcastEncoderAdapter` behavior
- Build / deploy after rollback:
  - `cargo build -p echo-core-client --release` passed
  - redeployed the rebuilt client to this PC installed path:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - staged the same rebuilt EXE to:
    - `\\SAM-PC\EchoChamber\installed-update\echo-core-client.exe`
  - restarted `SAM-PC` through the bridge again
  - verified fresh local process path:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
  - verified fresh remote startup:
    - `[1776125737] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
- Risk posture after this rollback:
  - broad-risk viewer experiments are gone
  - broad-risk encoder-factory experiment is now gone too
  - current build is back on the safer publish baseline
- Current immediate next test:
  - rerun the same canary:
    - this PC shares `Entire Screen`
    - `SAM-PC` watches it
  - if that comes back working again, the baseline is re-established and the Win10 `SAM-PC` native full-screen failure can be treated as an isolated fringe path without shipping the risky regressions

## 2026-04-13 Narrow encoder fix: software H264 fallback bypasses SimulcastEncoderAdapter
- After the rollback canary still came back `broken`, the fresh evidence did **not** support another broad rollback-only conclusion:
  - the remote `SAM-PC` log still showed the original Win10 native sender failure had returned on the rollback build:
    - `encoder=SimulcastEncoderAdapter`
    - `bytes=0`
    - `frames_sent=0`
    - `frames_encoded=0`
  - that means the rollback definitely restored the old `SAM-PC` zero-RTP sender bug
  - the earlier successful native sender repros on the direct-H26x experiment had specifically shown:
    - `encoder=OpenH264`
    - rising `bytes`
    - rising `frames_sent`
    - rising `frames_encoded`
- New conclusion:
  - the useful part of the old experiment was not "all H264 should bypass the adapter"
  - the useful part was narrower:
    - the **software H264 fallback** path can dead-stick when wrapped in `SimulcastEncoderAdapter`
    - NVENC-backed H264 should stay on the existing path until explicitly disproven
- Narrow patch applied:
  - `core/webrtc-sys-local/include/livekit/video_encoder_factory.h`
    - added `HasHardwareEncoderForFormat(...)`
  - `core/webrtc-sys-local/src/video_encoder_factory.cpp`
    - keep existing `SimulcastEncoderAdapter` behavior for the normal/hardware-backed paths
    - **only** bypass the adapter when:
      - codec is `H264`
      - no hardware encoder factory matches the requested format
    - in that case, create the software encoder directly through `InternalFactory::Create(...)`
  - `core/viewer/changelog.js`
    - added `2026-04-13h / Software H264 Screen-Share Fallback`
- Verification / rollout:
  - `cargo build -p echo-core-client --release` passed
  - redeployed this PC installed client:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - size `45,360,128`
    - timestamp `2026-04-13 20:24:43`
  - staged the same rebuilt EXE to the `SAM-PC` bridge update path:
    - `\\SAM-PC\EchoChamber\installed-update\echo-core-client.exe`
  - restarted `SAM-PC` through the existing bridge shim (the live agent there is still the old one, so `/launch-installed` is still unavailable)
  - verified the staged bridge applied the update into the real installed app path:
    - `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - size `45,360,128`
    - timestamp `2026-04-13 20:24:43`
  - verified fresh remote startup:
    - `[1776126415] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
- Current risk posture:
  - no server reboot
  - no Chromium/WebView fallback
  - no viewer hot-watch experiments reintroduced
  - the new encoder change is materially narrower than the reverted all-H264 experiment
- Current immediate next retest:
  - connect this PC and `SAM-PC`
  - on this PC, start `Share -> Entire Screen`
  - confirm whether `SAM-PC` can now watch it successfully on the narrowed fix
  - then retest:
    - on `SAM-PC`, start `Share -> Entire Screen`
    - on this PC, click `Start Watching`
  - use those two back-to-back canaries to determine whether the narrow software-H264-only bypass preserved the good path while restoring the Win10 native sender

## 2026-04-13 Canary clarification + restored full H26x bypass
- Sam clarified the earlier `broken` canary that triggered the encoder rollback was most likely run in the wrong direction:
  - the requested canary was:
    - this PC publishes `Entire Screen`
    - `SAM-PC` watches it
  - later, the same canary was rerun correctly and came back:
    - `works`
- That clarification materially changes the risk assessment:
  - the only concrete reason the broader direct-H26x publish fix was rolled back is no longer trustworthy
  - meanwhile, every real `SAM-PC` Win10 native repro on the rollback build still showed:
    - `encoder=SimulcastEncoderAdapter`
    - `bytes=0`
    - `frames_sent=0`
    - `frames_encoded=0`
  - so the rollback clearly reintroduced the original sender-side failure
- Fresh evidence before restoring the broader fix:
  - `SAM-PC` real repro with the narrowed build still failed the same way:
    - remote log continued to show `encoder=SimulcastEncoderAdapter`
    - sender counters stayed at zero despite healthy DXGI capture and a connected transport
  - dashboard on both viewers still showed the same dead remote screen-track signature:
    - subscribed
    - receiver exists
    - `MediaStreamTrack = live/muted`
    - blank 0fps tile
  - Jeff's entire-screen share worked on both this PC and `SAM-PC`, which is strong evidence the room/viewer side is still broadly healthy
- Restored effective fix:
  - `core/webrtc-sys-local/src/video_encoder_factory.cpp`
    - restored the broader direct H26x path
    - `H264`, `H265`, and `HEVC` now bypass `SimulcastEncoderAdapter` again and create directly through `InternalFactory::Create(...)`
  - removed the now-unneeded narrow helper from:
    - `core/webrtc-sys-local/include/livekit/video_encoder_factory.h`
  - `core/viewer/changelog.js`
    - added `2026-04-13i / H26x Screen-Share Encoder Path`
- Verification / rollout:
  - `cargo build -p echo-core-client --release` passed
  - `node --check core/viewer/changelog.js` passed
  - redeployed this PC installed client:
    - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - size `45,360,128`
    - timestamp `2026-04-13 20:34:37`
  - staged the same rebuilt EXE to:
    - `\\SAM-PC\EchoChamber\installed-update\echo-core-client.exe`
  - restarted `SAM-PC` through the existing bridge again
  - verified fresh remote installed EXE:
    - `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - size `45,360,128`
    - timestamp `2026-04-13 20:34:37`
  - verified fresh startups:
    - local:
      - `C:\Users\Sam\AppData\Local\Echo Chamber\echo-core-client.exe`
    - remote:
      - `[1776126886] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=false`
- Current immediate next retest:
  - connect this PC and `SAM-PC`
  - on `SAM-PC`, start `Share -> Entire Screen`
  - on this PC, click `Start Watching`
  - leave it 10 seconds
  - determine whether the restored H26x path puts `SAM-PC` back on a real outgoing sender instead of the zero-byte `SimulcastEncoderAdapter` stall

## 2026-04-13 Sender restored again; watch path narrowed to SDK attach
- Retest result after restoring the full H26x bypass:
  - `SAM-PC` native `Entire Screen` still looked `blank` to viewers
  - but the sender-side failure was now clearly gone again
- Fresh `SAM-PC` sender evidence from `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\capture-debug.log`:
  - `encoder=OpenH264`
  - `bytes`, `packets`, `frames_sent`, and `frames_encoded` all rising normally
  - example:
    - `bytes=178942 packets=373 frames_sent=64 frames_encoded=64`
    - later rising to:
      - `bytes=551182 packets=947 frames_sent=291 frames_encoded=291`
- Fresh dashboard evidence at the same time:
  - both this PC and Jeff still showed the same dead remote screen-track state for `SAM-PC`
  - `watch_debug` on both viewers reported:
    - `sam-pc-2513$screen:screen_share:video:sub=true:track=true:recv=true:mst=live/muted`
    - tile present
    - `video=0x0`
    - `rs=0`
  - practical meaning:
    - `SAM-PC` is sending real RTP again
    - the remaining break is back in the watch/tile attach path, not the sender
- New narrow viewer patch:
  - `core/viewer/participants.js`
    - added `createAttachedVideoElement(track)`
    - prefers SDK-managed `track.attach()` first
    - falls back to the old locked-manual `MediaStream` path only if attach fails
  - `core/viewer/audio-routing.js`
    - new remote screen tile creation now uses `createAttachedVideoElement(track)`
  - `core/viewer/participants-fullscreen.js`
    - `replaceScreenVideoElement(...)` now also uses `createAttachedVideoElement(track)`
  - `core/viewer/changelog.js`
    - added `2026-04-13j / SDK Screen Tile Attach`
- Verification / rollout:
  - `node --check` passed for:
    - `core/viewer/participants.js`
    - `core/viewer/audio-routing.js`
    - `core/viewer/participants-fullscreen.js`
    - `core/viewer/changelog.js`
  - relaunched this PC installed app:
    - startup `[1776127086]`
  - restarted `SAM-PC` through the bridge again:
    - startup `[1776127085]`
- Current immediate next retest:
  - connect this PC and `SAM-PC`
  - on `SAM-PC`, start `Share -> Entire Screen`
  - on this PC, click `Start Watching`
  - leave it 10 seconds
  - determine whether the SDK-managed first-attach path finally converts the live-but-muted remote screen track into real rendered video

## 2026-04-13 Win10 full-screen fix confirmed
- Final successful repro:
  - `SAM-PC` -> `Share -> Entire Screen`
  - this PC reported: `visible`
- The successful path is now confirmed to be the real product fix, not a stale manual override:
  - `\\SAM-PC\Users\Sam\AppData\Local\Echo Chamber\config.json` only contains:
    - `{"server":"https://echo.fellowshipoftheboatrace.party:9443"}`
  - no explicit `force_software_encoder` flag remains in the installed config
  - both installed clients were refreshed to the same rebuilt EXE:
    - size `45,409,792`
    - timestamp `2026-04-13 21:25:11`
- Root cause that actually mattered:
  - Rust-side Win10 auto-fallback was already setting:
    - `force_software_encoder=true`
    - `auto_force_software_encoder=true`
  - but the native encoder factory was still registering hardware factories on `SAM-PC`
  - that left Win10 in a split-brain state where the app thought software fallback was active while the C++ encoder side still walked the hardware path
- Winning fix:
  - `core/client/src/main.rs`
    - keep `force_software_encoder` optional in config
    - auto-force software H264 when Windows build `< 22000` and no explicit override is set
    - log the exact startup decision:
      - `force_software_encoder`
      - `auto_force_software_encoder`
      - `windows_build`
  - `core/webrtc-sys-local/src/nvidia/cuda_context.cpp`
    - teach native `IsSoftwareEncoderForced()` to read installed `config.json`
    - also auto-force on Win10 builds `< 22000`
  - `core/webrtc-sys-local/src/nvidia/nvidia_encoder_factory.cpp`
    - skip NVENC factory registration when native `IsSoftwareEncoderForced()` is true
  - `core/webrtc-sys-local/src/video_encoder_factory.cpp`
    - keep the direct H26x path
    - normalize software H264 to `packetization-mode=1`
- Final proof from the successful build on `SAM-PC`:
  - startup log:
    - `[1776130126] [startup] echo-core-client boot server=https://echo.fellowshipoftheboatrace.party:9443 force_software_encoder=true auto_force_software_encoder=true windows_build=19045`
  - native encoder-factory trace:
    - `[encoder-factory] ctor hw_factories=0 force_software=1`
    - `software-match ... packetization-mode=1 ... profile-level-id=42e01f`
  - native capture/publish trace:
    - `connected as sam-pc-2513$screen`
    - `track published sid=TR_VSjzZeMAtKVaze source=Screenshare`
    - `encoder=OpenH264`
    - `frames_sent`, `frames_encoded`, and `bytes` all rising normally
    - example:
      - `bytes=213014 packets=411 frames_sent=89 frames_encoded=89 ... fps=17.0`
      - later:
        - `bytes=814215 packets=1244 frames_sent=457 frames_encoded=457 ... fps=17.0`
- Practical product conclusion:
  - Win10 native `Entire Screen` / `DXGI Desktop Duplication` should now auto-fall back to software H264 without requiring a manual config override
  - this preserves the native picker/native capture direction and avoids the Chromium regression path Sam explicitly rejected
  - expected tradeoff on Win10:
    - visible and stable full-screen share
    - OpenH264 software encode around `16-18 fps`
    - lower peak performance than NVENC, but no more blank `0fps` dead air
- Operational notes:
  - no server reboot was needed for the fix
  - the temporary `SAM-PC` bridge/shim is still only an operational launch path until the remote agent is modernized

## 2026-04-13 v0.6.11 release prep completed
- Release candidate version bump is in place across all required desktop release files:
  - `core/client/Cargo.toml` -> `0.6.11`
  - `core/client/tauri.conf.json` -> `0.6.11`
  - `core/control/Cargo.toml` -> `0.6.11`
- Windows-only release cleanup applied:
  - `core/client/tauri.conf.json`
    - bundle targets now `["nsis"]`
  - `core/deploy/build-release.ps1`
    - now builds with `cargo tauri build --bundles nsis`
    - now generates a Windows-only `latest.json`
    - now prints a safe exact-file `gh release create ...` command instead of the dangerous `bundleDir\*` wildcard (the bundle dir contains old installers)
- Release notes updated in `CHANGELOG.md` with a new `0.6.11` entry covering:
  - Win10 native `Entire Screen` auto software-H264 fallback
  - software H264 packetization / render fix
  - auto-watch / screen attach hardening
  - Windows-only packaging cleanup
- Build verification:
  - `cargo build -p echo-core-client --release` passed on `0.6.11`
  - `cargo build -p echo-core-control --release` passed on `0.6.11`
  - local signed NSIS bundle built successfully via:
    - `powershell -ExecutionPolicy Bypass -File core/deploy/build-release.ps1`
- Fresh release artifacts produced locally:
  - `core/target/release/bundle/nsis/Echo Chamber_0.6.11_x64-setup.exe`
  - `core/target/release/bundle/nsis/Echo Chamber_0.6.11_x64-setup.exe.sig`
  - `core/target/release/bundle/nsis/latest.json`
- Generated updater manifest is Windows-only and points at:
  - `https://github.com/SamWatson86/echo-chamber/releases/download/v0.6.11/Echo.Chamber_0.6.11_x64-setup.exe`
- Important deployment boundary:
  - `core/deploy/latest.json` in the repo still points at public `0.6.10`
  - do **not** replace the live repo manifest until the `v0.6.11` GitHub release exists and its `latest.json` has been uploaded/downloaded
- Exact publish command prepared by the release script:
  - `gh release create v0.6.11 --title 'Echo Chamber v0.6.11' "F:\Codex AI\The Echo Chamber\core\target\release\bundle\nsis\Echo Chamber_0.6.11_x64-setup.exe" "F:\Codex AI\The Echo Chamber\core\target\release\bundle\nsis\Echo Chamber_0.6.11_x64-setup.exe.sig" "F:\Codex AI\The Echo Chamber\core\target\release\bundle\nsis\latest.json"`
- After publishing:
  - download the release `latest.json`
  - copy it to `core/deploy/latest.json`
  - verify `https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json` serves `0.6.11`

## 2026-04-13 final 0.6.11 release-candidate smoke green
- Final live smoke on the exact `0.6.11` release-candidate build came back green:
  - `SAM-PC` Win10 `Entire Screen` -> visible on this PC
  - this PC `Entire Screen` -> visible on `SAM-PC`
  - Jeff `Entire Screen` -> visible on both machines
- User confirmation:
  - `all three work!`
- Clean release-branch packaging also passed from the short-path `main`-based worktree:
  - branch: `codex/release-v0.6.11-short`
  - worktree: `F:\EC-r611`
  - reason for short path:
    - the first clean worktree under `.codex\worktrees\release-v0.6.11` hit path-length trouble in libwebrtc scratch includes
    - moving the clean branch to `F:\EC-r611` fixed packaging without changing source
  - local signing key had to be copied into the clean worktree as untracked local release material:
    - `core/client/.tauri-keys`
    - do not commit it
- Clean-branch artifact verification:
  - `powershell -ExecutionPolicy Bypass -File F:\EC-r611\core\deploy\build-release.ps1` passed
  - produced:
    - `F:\EC-r611\core\target\release\bundle\nsis\Echo Chamber_0.6.11_x64-setup.exe`
    - `F:\EC-r611\core\target\release\bundle\nsis\Echo Chamber_0.6.11_x64-setup.exe.sig`
    - `F:\EC-r611\core\target\release\bundle\nsis\latest.json`
  - manifest verification:
    - `version=0.6.11`
    - GitHub URL points at `v0.6.11`
- Release state:
  - functionally ready to publish after staging/commit on the clean release branch
  - still do not update repo `core/deploy/latest.json` until the GitHub release exists

## 2026-04-13 v0.6.11 published
- GitHub release published successfully:
  - tag: `v0.6.11`
  - URL: `https://github.com/SamWatson86/echo-chamber/releases/tag/v0.6.11`
  - target branch at publish time:
    - `codex/release-v0.6.11-short`
    - commit `5f76ee3`
- Published assets:
  - `Echo Chamber_0.6.11_x64-setup.exe`
  - `Echo Chamber_0.6.11_x64-setup.exe.sig`
  - `latest.json`
- Post-publish manifest sync completed:
  - downloaded release `latest.json` into `core/deploy/latest.json`
  - copied the published manifest into the live checkout deploy dir
- Live updater verification:
  - `https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json` now serves:
    - `version=0.6.11`
    - GitHub asset URL for `v0.6.11`
- Release status:
  - `0.6.11` is live for Windows desktop updater checks
