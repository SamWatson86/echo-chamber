# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-10
**Working On**: Settings persistence + upgrade lessons documented
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- **Tauri native client is now the primary app** — browser viewer is legacy/debug only
- Core stack: LiveKit SFU (native exe) + Rust control plane + TURN server (native Go) + web viewer + Tauri native client
- **Docker is REMOVED** — all services run as native Windows processes

## What Happened This Session (2026-02-10)

### 40. Tauri IPC Fix — Local Page Loading
- **Problem**: Tauri IPC (`window.__TAURI__`) was NOT available when the viewer was loaded from a remote URL (`https://server/viewer`). The remote URL capabilities/permissions system in Tauri v2 didn't inject the IPC bridge for custom app commands.
- **Symptom**: Native audio capture dropdown never appeared after screen sharing. `hasTauriIPC()` returned false.
- **Root cause**: Tauri v2's ACL system doesn't auto-generate permissions for app-level `#[tauri::command]` functions when loaded from remote URLs. Only `core:default` and `updater:default` were in the capabilities, which don't cover custom commands.
- **Fix**: Changed from remote loading (`WebviewUrl::External`) to local loading (`WebviewUrl::App`):
  - `tauri.conf.json`: `frontendDist` stays `"../viewer"` (serves `core/viewer/`)
  - `main.rs`: `WebviewUrl::App("index.html".into())` instead of `External(viewer_url)`
  - `index.html`: Asset paths changed from `/viewer/style.css` to `style.css` (relative)
  - `app.js`: Added `apiUrl()` helper to prefix API paths with server URL for native client
  - `app.js`: Added `_echoServerUrl` global, set from `get_control_url` Tauri command on startup
  - All 10+ `fetch("/api/...")` calls wrapped with `apiUrl()`
- **Impact**: Tauri IPC now works natively. `window.__TAURI__` is available. All custom commands callable.
- **Browser viewer**: Still works — relative paths resolve correctly at `https://server/viewer/`

### 41. Auto-Detect Per-Process Audio Capture
- **Previous behavior**: After screen sharing, a dropdown appeared asking user to select which window to capture audio from. This dropdown NEVER appeared because IPC was broken (see #40).
- **New behavior**: When screen sharing starts, the system automatically:
  1. Gets the video track label from `getDisplayMedia` (contains window title)
  2. Calls `list_capturable_windows()` via Tauri IPC to enumerate running windows
  3. Matches the track label against window titles (exact match, then partial word match)
  4. If match found, automatically starts WASAPI per-process audio capture
  5. Audio flows: WASAPI → base64 PCM → Tauri events → AudioWorklet → MediaStream → LiveKit
- **Function**: `showNativeAudioPicker()` replaced with `autoDetectNativeAudio(trackLabel)`
- **Matching strategy**: Two passes:
  1. Full title containment (track label contains window title or vice versa)
  2. Word-based partial match (3+ char words from track label searched in window titles)
  3. Echo Chamber's own window is always excluded
- **No UI needed**: Completely automatic, no dropdown

### 42. Deploy to SAM-PC
- Release build pushed to SAM-PC (192.168.5.149:8080)
- Config updated with LAN server URL (`https://192.168.5.70:9443`)
- Client restarted with new build

### Files Changed
- `core/client/src/main.rs` — Local WebviewUrl, removed on_navigation handler
- `core/client/tauri.conf.json` — Unchanged (frontendDist still ../viewer)
- `core/viewer/index.html` — Relative asset paths (style.css, app.js, badge.jpg, livekit-client.umd.js)
- `core/viewer/app.js` — apiUrl() helper, auto-detect audio capture, simplified IPC shim, server URL from Tauri config
- `core/viewer/style.css` — No changes

### 43. WASAPI Process Loopback Fix
- **Problem**: WASAPI `ActivateAudioInterfaceAsync` fails on SAM-PC with `0x80070002` (file not found)
- **Root cause**: Process loopback capture requires Windows 10 build 20348+. SAM-PC runs build 19045. The `VAD\Process_Loopback` virtual audio device doesn't exist on older builds.
- **Also fixed**: Device path was `w!("")` (empty string) — changed to correct `w!("VAD\\Process_Loopback")`
- **Added**: Windows build check in Rust that returns a clear error message before even attempting activation
- **Fallback**: If WASAPI isn't supported, user sees clear message in debug log. System audio from getDisplayMedia is kept as fallback.
- **SAM-PC limitation**: Per-process audio capture won't work. For window shares, SAM-PC must share entire screen with "Share system audio" checked instead.
- **Files**: `core/client/src/audio_capture.rs`, `core/client/Cargo.toml`, `core/viewer/app.js`

### 44. External User Connection Fix (Jeff's "engine not connected" error)
- **Symptom**: Jeff (external, over internet) could see participants but mic publishing failed with "publishing rejected as engine not connected within timeout"
- **Root cause 1**: LiveKit config had `use_external_ip: false` — SFU advertised LAN IP `192.168.5.70` in ICE candidates, unreachable from internet
- **Root cause 2**: TURN URL in app.js used `window.location.hostname` which resolves to `tauri.localhost` in the native Tauri client — TURN was unreachable
- **Fix 1**: `core/sfu/livekit.yaml` — changed `use_external_ip: false` to `use_external_ip: true` (LiveKit now uses STUN to detect and advertise public IP)
- **Fix 2**: `core/viewer/app.js` — Extract hostname from `sfuUrl` (the actual server URL) instead of `window.location.hostname` for TURN URL construction
- **Files**: `core/sfu/livekit.yaml`, `core/viewer/app.js`

### 45. WebView2 Cache Clear on Upgrade
- **Symptom**: Jeff had to Ctrl+Shift+R after installing v0.2.0 over v0.1.0 — stale cached content from the old remote-loading version persisted
- **Fix**: Added `clear_cache_on_upgrade()` in `core/client/src/main.rs` — checks stored version against current version, clears WebView2 Cache/Code Cache/GPUCache directories on mismatch
- **Impact**: Future updates will auto-clear stale cache, no manual refresh needed
- **Files**: `core/client/src/main.rs`

### 46. WASAPI Audio Format Conversion + Diagnostics
- **Problem**: Remote participants (DMountain) can't hear audio from window shares. Pipeline: getDisplayMedia (0 audio tracks for window shares) -> autoDetectNativeAudio -> WASAPI capture -> base64 events -> AudioWorklet -> LiveKit publish. Audio was being sent as raw bytes but JS always interprets as Float32Array, so non-float32 formats (int16, int24) produce garbage.
- **Fix 1 (Rust)**: Added format detection in `audio_capture.rs` — checks `wFormatTag` for `WAVE_FORMAT_IEEE_FLOAT` (3) or `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) SubFormat GUID. If NOT float32, converts:
  - Int16 PCM: divide by 32768.0
  - Int24 PCM: sign-extend + divide by 8388608.0
  - Float32: pass through (existing behavior)
- **Fix 2 (Rust)**: Added `formatTag` and `isFloat` to the `audio-capture-format` event payload. Added first-frame byte logging for diagnostics.
- **Fix 3 (JS)**: Added `await`/`.catch()` on `autoDetectNativeAudio()` call — was fire-and-forget, errors were silently lost.
- **Fix 4 (JS)**: Added Strategy 4 exe_name matching in `autoDetectNativeAudio` — matches window's exe name against track label. Edge track labels for window shares often contain the process name.
- **Fix 5 (JS)**: Added green "Native Audio Active" indicator (fixed bottom-right) when WASAPI capture is running. Hidden when capture stops.
- **Fix 6 (JS)**: Added "FIRST NON-SILENT chunk" log message — confirms when real audio data starts flowing through the pipeline.
- **Files**: `core/client/src/audio_capture.rs`, `core/viewer/app.js`
- **Build**: `cargo check` passes clean.

### 47. WASAPI Process Loopback Fix — NOW WORKING
- **Problem**: WASAPI per-process audio capture silently failed. `ActivateAudioInterfaceAsync` succeeded but capture loop errored with `E_NOTIMPL (0x80004001)`.
- **Root cause 1**: `GetMixFormat()` returns `E_NOTIMPL` on process loopback IAudioClient — unlike regular audio clients, the process loopback client doesn't support this call.
- **Root cause 2**: Missing `AUDCLNT_STREAMFLAGS_LOOPBACK` flag in `Initialize()` — only had `EVENTCALLBACK`, but loopback mode requires both flags.
- **Fix**: In `core/client/src/audio_capture.rs`:
  1. Wrapped `GetMixFormat()` in match — if E_NOTIMPL, falls back to default WAVEFORMATEX (IEEE float32, 48000 Hz, stereo, 8 bytes block align)
  2. Added `AUDCLNT_STREAMFLAGS_LOOPBACK` to `Initialize()` flags in both success and fallback paths
- **Result**: WASAPI per-process audio capture is NOW WORKING. Audio flows through the full pipeline.
- **Files**: `core/client/src/audio_capture.rs`

### 48. Ultrawide Screen Share Grid Layout Fix
- **Problem**: Screen share video spanned full width on ultrawide monitors, pushing other participants off-screen
- **Fix**: Removed the full-width spanning CSS rule for screen share tiles in the grid layout
- **Files**: `core/viewer/style.css`

### 49. Persistent Settings (Origin-Independent Storage)
- **Problem**: Switching from remote (`WebviewUrl::External`) to local (`WebviewUrl::App`) loading changed the WebView2 origin from `https://127.0.0.1:9443` to `tauri://localhost`. All localStorage settings vanished — theme, soundboard favorites, device selections, noise cancel, UI opacity.
- **Root cause**: localStorage is origin-scoped. Data stored under the old origin is physically on disk but invisible to the new origin.
- **Fix (Rust)**: Added `save_settings`/`load_settings` IPC commands in `core/client/src/main.rs` that read/write `settings.json` in `%APPDATA%/com.echochamber.app/`
- **Fix (JS)**: Added `echoGet(key)`/`echoSet(key, value)` wrappers in `core/viewer/app.js`:
  - In-memory `_settingsCache` (synchronous reads, same API as localStorage)
  - Debounced file writes (300ms) via Tauri IPC for native client
  - localStorage fallback for browser viewer
  - One-time migration: copies known keys from localStorage to file on first native run
- **Replaced**: ALL ~25 `localStorage.getItem`/`localStorage.setItem` and 4 `safeStorageGet`/`safeStorageSet` calls replaced with `echoGet`/`echoSet`
- **Startup**: `await loadAllSettings()` called before any UI initialization
- **Files**: `core/client/src/main.rs`, `core/viewer/app.js`

### 50. Ultra Instinct GIF Background Fix
- **Problem**: Ultra Instinct theme's animated GIF background disappeared after switching to local loading
- **Root cause**: CSS had `url('/viewer/ultrainstinct.gif')` — absolute path that doesn't exist in Tauri local loading
- **Fix**: Changed to relative `url('ultrainstinct.gif')` in `core/viewer/style.css`

### 51. Lessons Learned Documentation
- Created `memory/upgrade-lessons.md` with 7 detailed lessons from WASAPI migration and upgrade distribution
- Updated `memory/MEMORY.md` with 7 new Key Lesson bullets linking to the topic file
- Topics: localStorage origin scoping, CSS asset URLs, adaptive bitrate, LiveKit config fields, Windows paths with spaces, NSIS settings survival, WebView2 cache persistence

### 52. macOS Cross-Platform Support
- **Goal**: Allow Sam's Mac friends to use Echo Chamber via a native macOS DMG installer
- **Approach**: Platform guards (`#[cfg(target_os)]`) + stub module + GitHub Actions CI
- **Changes to `core/client/src/main.rs`**:
  - Windows-only: WebView2 browser args (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`), WebView2 cache clearing, `cmd /c start` for URL opening
  - macOS: WKWebView cache clearing, `open` command for URLs
  - Conditional module: `audio_capture` on Windows, `audio_capture_stub` on non-Windows
- **New file: `core/client/src/audio_capture_stub.rs`** — No-op implementations of `list_capturable_windows`, `start_capture`, `stop_capture` for non-Windows platforms. Mac users use screen share with "Share system audio" instead.
- **`core/client/Cargo.toml`** — Already had Windows deps gated with `[target.'cfg(windows)'.dependencies]`
- **`core/client/tauri.conf.json`** — No changes needed. Workflow overrides with `--bundles dmg`
- **`.github/workflows/build-macos.yml`** — New workflow: manual dispatch + tag push, builds on macOS-latest (Apple Silicon), auto-disables updater artifacts if signing key not configured
- **Commit**: `6770f3f` — pushed to main, macOS CI workflow triggered

### What Needs Testing
1. **Settings persistence**: Change theme, close client, reopen → theme should persist
2. **Soundboard favorites**: Verify favorites/order persist across restarts
3. **Noise cancel toggle**: Re-enable noise cancellation in settings → verify it persists
4. **External user audio**: Confirm friends over WAN hear per-process audio from window shares
5. **Ultrawide grid**: Verify screen share tiles no longer span full width

## Current Status

**macOS support committed and CI running.** Waiting for GitHub Actions macOS build to complete.

**Commit `6770f3f`**: Platform guards + stub audio + macOS CI workflow pushed.

**Key remaining**: Verify CI produces DMG, set up GitHub secrets for signing key (optional), test DMG on a real Mac.

## Previous Session Work (2026-02-09)
See git log and previous session notes for: screen share codec fixes, noise cancellation, custom chime sounds, soundboard, avatar system, device selection, screen grid fixes, and more.

## Next Steps
1. **Verify macOS CI** — Check that GitHub Actions produces a working DMG
2. **Test on real Mac** — Have a Mac friend download and test the DMG
3. **Optional: Add signing key secret** — Enables auto-updater for macOS
4. **Optional: Apple code signing** — Removes "unidentified developer" warning ($99/year Apple Developer account)
5. **Split app.js into modules** — currently ~6800+ lines

## Network Setup
- **ATT BGW320-500**: IP passthrough / bridge mode
- **Eero**: Real router — DHCP, NAT, port forwarding, Wi-Fi
- **Public IP**: `99.111.153.69` (verified 2026-02-09)
- **Port forwards** (on Eero): 9443 TCP, 3478 UDP, 40000-40099 UDP, 7881 TCP

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (native Windows exe) — handles media routing
- **Control**: Rust control plane — auth, rooms, admin (`core/control`)
- **Client**: Tauri hybrid native app — web UI loaded locally + Rust backend (`core/client`) **PRIMARY APP**
- **Viewer**: Web viewer — same files served by control plane for browser access (`core/viewer`)
- **Deploy**: HTTP deploy agent for test PC (`core/deploy`)
- **TURN**: Native Go TURN server (`core/turn`)

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Stop script: `F:\Codex AI\The Echo Chamber\core\stop-core.ps1`
- Health: `https://127.0.0.1:9443/health`
- Viewer: `https://127.0.0.1:9443/viewer/` (browser)
- Native client: `core/target/debug/echo-core-client.exe`

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. The Tauri client now loads viewer files locally — `window.__TAURI__` IPC works
4. Native audio capture auto-detects shared window — no manual selection needed
5. WASAPI per-process audio capture is NOW WORKING (LOOPBACK flag + GetMixFormat fallback fixed)
6. Settings now persist via `echoGet`/`echoSet` → `settings.json` in `%APPDATA%` (survives origin changes + upgrades)
7. macOS cross-platform support added — platform guards in main.rs, stub audio module, GitHub Actions CI for DMG builds (commit `6770f3f`)
8. Next priority: verify macOS CI produces DMG, test on a real Mac
