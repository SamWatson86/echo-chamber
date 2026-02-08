# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-07
**Working On**: Core version only (`/core` folder)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- We are building a **full-stack SFU pipeline** using the web interface for UI optimization BEFORE moving to the native Rust client
- Core stack: LiveKit SFU (native exe) + Rust control plane + TURN server (native Go) + web viewer + Tauri native client
- **Docker is REMOVED** — all services run as native Windows processes

## Project Vision
- **Goal**: 1080p at 60fps for all guests
- **Adaptive quality**: Guests with bad internet need on-the-fly adjustment so they can still participate
- **Pipeline**: Web viewer (current) -> Tauri hybrid native client (in progress)
- The web viewer is for rapid UI/UX iteration. The Tauri app wraps the same web UI in a native window.

## External Access — CONFIGURED AND WORKING

### Network Setup
- **Public IP**: 99.111.153.69 (may change — consider dynamic DNS later)
- **Router**: Eero
- **Port forwards**: 9443 TCP (control plane + WSS proxy) + 56100-56199 UDP (WebRTC media) + 7881 TCP (RTC) + 3478 UDP (TURN) + 40000-40099 UDP (TURN relay)
- **NOT forwarded**: 7880 (LiveKit signaling proxied through 9443)
- **Firewall**: `core/allow-firewall.ps1` covers 9443, 7880, 7881, 56100-56199, 3478, 40000-40099

### LiveKit STUN
- STUN servers configured in `core/sfu/livekit.yaml` (native config)
- Format: `stun.l.google.com:19302` (NOT `stun:host:port` — causes "too many colons" error)
- `use_external_ip: true` — LiveKit detects public IP via STUN automatically

### Two Installer Tracks
1. **SAM-PC (LAN only)**: Uses deploy agent on port 8080, config has `server: "https://192.168.5.70:9443"`
2. **External friends (GitHub Release)**: DEFAULT_SERVER baked as `https://99.111.153.69:9443`, published as v0.1.0

### GitHub Release v0.1.0 — PUBLISHED
- URL: https://github.com/SamWatson86/echo-chamber/releases/tag/v0.1.0
- `Echo Chamber_0.1.0_x64-setup.exe` (5 MB) — installer with public IP baked in
- `Echo Chamber_0.1.0_x64-setup.exe.sig` — signature for auto-updates
- `latest.json` — update manifest
- Friends download the .exe, install, and they connect to Sam's public IP

## Completed Work

### Docker Removed — All Native Now
- **LiveKit SFU**: Native Windows binary `core/sfu/livekit-server.exe` (v1.9.11, 49 MB)
- **Config**: `core/sfu/livekit.yaml` (no Redis needed — single-node mode)
- **TURN server**: Native Go binary `core/turn/echo-turn.exe` (5 MB, pion/turn v4)
- **Old Docker files** (`docker-compose.yml`, `livekit.docker.yaml`) still exist but are unused
- **Why**: Docker Desktop uses Hyper-V which causes gaming stutter. Native = no hypervisor overhead.
- **Docker Desktop is UNINSTALLED.** Hyper-V is removed from boot config.

### Native TURN Server — BUILT AND RUNNING
**Files**: `core/turn/` (Go project using pion/turn v4)
- **Binary**: `core/turn/echo-turn.exe` (5 MB standalone, built from Go)
- **Port**: UDP 3478 (standard TURN port)
- **Relay range**: UDP 40000-40099 (native Windows networking, NOT Docker)
- **Credentials**: username=`echo`, password=`chamber`, realm=`echo-chamber`
- **Config**: Environment variables or defaults in main.go
- **Start**: `core/turn/start-turn.ps1` or auto-started by `run-core.ps1` / `startup.ps1`
- **Stop**: `stop-core.ps1` handles cleanup via PID file
- **Client config**: `app.js` passes TURN server in `rtcConfig.iceServers` at room.connect()
- **Router forwards needed**: UDP 3478 + UDP 40000-40099 on Eero
- **Why native**: Runs outside Docker, uses Windows networking directly, no packet reordering

### Screen Share 60fps Fix — WORKING
**File**: `core/viewer/app.js`

**Problem**: Screen share was capped at 30fps even though 60fps was configured.
**Root cause**: LiveKit SDK passes `frameRate: 60` as a plain number to `getDisplayMedia()`, which Chromium interprets as `{ max: 60 }` (defaults to 30). The browser needs `{ ideal: 60 }` to actively target 60fps.
**Fix**: Bypassed LiveKit's `setScreenShareEnabled()` capture. Now calls `getDisplayMedia()` manually with explicit `frameRate: { ideal: 60 }` constraint, creates LiveKit `LocalVideoTrack`/`LocalAudioTrack` from the stream, and publishes them manually.
- `startScreenShareManual()` — manual capture + publish
- `stopScreenShareManual()` — unpublish + stop tracks
- Content hint `"motion"` set directly on MediaStreamTrack
- Browser "Stop sharing" button handled via `track.ended` event
- Debug log confirms: **"Screen capture actual FPS: 60, resolution: 1920x1080"**

### Video Quality Tuning
**File**: `core/viewer/app.js`
- Camera: H264 codec, 5 Mbps, 1080p60, simulcast with 3 layers (q/h/f)
- Screen share: VP9, L1T3 scalability, 8 Mbps, `maintain-framerate`, `contentHint: 'motion'`
- Manual `getDisplayMedia()` with `frameRate: { ideal: 60 }` for true 60fps capture
- `adaptiveStream: true` + `dynacast: true` for mixed-quality participant support
- Audio DTX enabled (near-zero bandwidth during silence)

### Chat Scroll to Latest Messages
**File**: `core/viewer/app.js`
- Chat now scrolls to the most recent message when opened
- `scrollTop = scrollHeight` applied in `openChat()` (not during hidden panel load)

### Camera Lobby Dynamic Grid
**Files**: `core/viewer/app.js`, `core/viewer/style.css`
- Camera feeds use maximum space, shrinking into grid as more people join
- CSS `data-count` attribute drives responsive grid columns
- 1 person = full width, 2 = 2 columns, 3-4 = 2 columns, 5-6 = 3 columns
- Aspect ratio changed from 4:3 to 16:9

### Track Subscription Race Condition Fix
**File**: `core/viewer/app.js`
- Reduced deduplication window from 1200ms to 200ms
- Added debug logging for dropped track events
- Added 200ms delay before attaching tracks to new participants

### Chat Feature
- Full chat system with image/file upload support
- Chat notification badge with pulse animation
- Auth, aspect ratio, and all-users visibility bug fixes

### Full UI Redesign
**File**: `core/viewer/style.css`
- Frosted glass aesthetic with CSS custom properties
- All panels use backdrop-filter blur
- Unified button styling, hover glow

### Theme System (7 Interactive Themes)
1. Frost (default), 2. Cyberpunk, 3. Aurora, 4. Ember, 5. Matrix, 6. Midnight, 7. Ultra Instinct

### Tauri Hybrid Native Client — BUILT AND WORKING
- Tauri v2 wrapping web viewer in native window
- NSIS installer (5 MB), auto-updater via GitHub Releases
- Signing keypair for update verification (password: "echo")

### Deploy Pipeline to SAM-PC — WORKING
- HTTP deploy agent on port 8080
- Build + push + auto-launch

### Auto-Start on Boot
- Scheduled task "EchoChamberStartup" runs at login
- Starts LiveKit SFU, control plane, TURN server (all native)

## Current Status

**100% Docker-free.** All services run as native Windows processes:
- LiveKit SFU: `core/sfu/livekit-server.exe`
- Control plane: `core/target/debug/echo-core-control.exe`
- TURN server: `core/turn/echo-turn.exe`

**Screen share is 60fps.** Confirmed via debug log. Manual `getDisplayMedia()` bypass of LiveKit SDK.

**External access is configured and working.** Friends download installer from GitHub Release and connect to Sam's public IP.

**TURN server running natively** on Windows (port 3478 UDP). Brad connecting via UDP (confirmed in LiveKit logs, 1.3s connect time).

### Next Steps
1. **Test Brad on TURN** — Have Brad reconnect, check if he gets UDP relay instead of TCP
2. **Dynamic DNS** — Public IP 99.111.153.69 may change; consider noip.com or similar
3. **Code signing certificate** — Prevents "Unknown publisher" Windows SmartScreen warning
4. **Add native features** — LiveKit native SDK, hardware encode/decode (NVENC on GTX 760)

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (native Windows exe) — handles media routing
- **Control**: Rust control plane — auth, rooms, admin (`core/control`)
- **Client**: Tauri hybrid native app — web UI + Rust backend (`core/client`)
- **Viewer**: Web viewer for UI optimization (`core/viewer`)
- **Deploy**: HTTP deploy agent for test PC (`core/deploy`)
- **TURN**: Native Go TURN server (`core/turn`)

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Stop script: `F:\Codex AI\The Echo Chamber\core\stop-core.ps1`
- Health check: `https://127.0.0.1:9443/health`
- Viewer: `https://127.0.0.1:9443/viewer`
- Native client: `core/target/debug/echo-core-client.exe`

### Key Timing Parameters
- Room status polling: every 2 seconds
- Heartbeat: every 10 seconds
- Stale participant cleanup: 20s timeout, 10s check interval

### Logs
- Control plane: `core/logs/core-control.out.log`, `core/logs/core-control.err.log`
- LiveKit SFU: `core/logs/livekit.err.log`, `core/logs/livekit.out.log`
- TURN server: `core/logs/turn.out.log`, `core/logs/turn.err.log`

## Files to Know
- `core/viewer/app.js` — Web viewer (video + chat UI) ~4700 lines
- `core/viewer/style.css` — Frosted glass CSS with 7 themes
- `core/viewer/index.html` — Viewer HTML structure
- `core/control/src/main.rs` — Rust control plane (with participant tracking)
- `core/client/src/main.rs` — Tauri native client (DEFAULT_SERVER = public IP)
- `core/client/tauri.conf.json` — Tauri app configuration
- `core/deploy/agent.ps1` — Deploy agent for test PC
- `core/deploy/push-build.ps1` — Dev-side deploy script
- `core/deploy/build-release.ps1` — Release build script
- `core/sfu/livekit.yaml` — LiveKit native config
- `core/sfu/start-livekit.ps1` — Start LiveKit natively
- `core/turn/main.go` — TURN server source
- `core/turn/start-turn.ps1` — Start TURN server
- `core/run-core.ps1` — Start all services
- `core/stop-core.ps1` — Stop all services
- `core/startup.ps1` — Auto-start on boot

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. Ask Sam about current status
4. Continue from where we left off
