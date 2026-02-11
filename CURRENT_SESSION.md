# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-10
**Working On**: Native per-process audio capture + Tauri IPC fix
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

### What Needs Testing
1. **Main PC**: Launch client, connect, screen share a window → verify WASAPI works (build should be high enough)
2. **SAM-PC**: Deploy new build, screen share → should see clear "requires build 20348" message in debug log instead of cryptic error
3. **SAM-PC workaround**: Share entire screen with "Share system audio" checked — audio should come through

## Current Status

**Debug client rebuilt** on Main PC. SAM-PC needs new release build deployed.

**Control plane running.** Restarted with updated viewer files.

**Key finding**: WASAPI per-process audio capture is a Windows 10 build 20348+ feature. SAM-PC (build 19045) cannot use it. Main PC should work if running a newer build. For SAM-PC, the workaround is sharing entire screen instead of a window.

## Previous Session Work (2026-02-09)
See git log and previous session notes for: screen share codec fixes, noise cancellation, custom chime sounds, soundboard, avatar system, device selection, screen grid fixes, and more.

## Next Steps
1. **Test screen share audio end-to-end** — Verify auto-detect works with VLC/games
2. **Git commit all changes** — massive amount of uncommitted work
3. **Custom chime sounds plan** — See plan file (joyful-conjuring-taco.md)
4. **Split app.js into modules** — currently ~6500+ lines

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
5. Next priority: test screen share audio, git commit
