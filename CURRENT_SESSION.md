# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-07
**Working On**: Core version only (`/core` folder)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- We are building a **full-stack SFU pipeline** using the web interface for UI optimization BEFORE moving to the native Rust client
- Core stack: LiveKit SFU (Docker) + Rust control plane + web viewer + Tauri native client

## Project Vision
- **Goal**: 1080p at 60fps for all guests
- **Adaptive quality**: Guests with bad internet need on-the-fly adjustment so they can still participate
- **Pipeline**: Web viewer (current) -> Tauri hybrid native client (in progress)
- The web viewer is for rapid UI/UX iteration. The Tauri app wraps the same web UI in a native window.

## Completed Work

### Track Subscription Race Condition Fix
**File**: `core/viewer/app.js`

**Problem**: Existing users couldn't see new users joining the room. Race condition in deduplication logic.

**Fixes Applied**:
1. Reduced deduplication window from 1200ms to 200ms
2. Added debug logging for dropped track events
3. Added 200ms delay before attaching tracks to new participants

### Chat Feature
**What was built**:
- Full chat system integrated into the viewer
- Image and file upload support
- Chat notification badge with pulse animation

**Bug fixes applied**:
- Chat image/file loading with authentication
- Chat upload endpoint authentication
- Chat image aspect ratio (prevent stretching)
- Chat images visible for all users (not just admins)

### Mic Fix for Spencer
- Fixed microphone issues for specific user

### Full UI Redesign
**File**: `core/viewer/style.css`

Complete CSS overhaul with unified frosted glass aesthetic:
- CSS custom properties for consistent design tokens (borders, glass, radii, transitions)
- All panels use backdrop-filter blur with translucent gradient backgrounds
- Unified button styling with glass backgrounds, subtle borders, hover glow
- Uppercase headers with letter-spacing across all panel titles
- Sidebar buttons split into two rows (Debug/Chat/Mute All top, Soundboard/Camera Lobby bottom)
- Soundboard, Camera Lobby, Chat, Settings, Debug panels all match
- Thin scrollbars, accent-colored range sliders, refined focus rings
- Pure CSS changes only — no HTML/JS modifications (zero functionality risk)

### Room Switching Fix
**File**: `core/viewer/app.js`

- Fixed room switching snapping back to Main (duplicate `switchRoom()` + hardcoded "main" in `connect()`)
- Consolidated into single `switchRoom()` that uses `currentRoomName`

### Cross-Room Participant Visibility (Room List)
**Files**: `core/control/src/main.rs`, `core/viewer/app.js`, `core/viewer/style.css`

**Problem**: Users in different rooms couldn't see who was in other rooms or click to join them.

**Control plane changes**:
- Added `ParticipantEntry` tracking (identity, name, room_id, last_seen timestamp)
- `participants` HashMap added to `AppState` - tracks all connected users
- Participants auto-registered when tokens are issued (`issue_token`)
- New `GET /v1/room-status` endpoint - returns all rooms with participant lists
- New `POST /v1/participants/heartbeat` - keeps participant entries alive
- New `POST /v1/participants/leave` - removes participant on disconnect
- Background cleanup task removes stale entries (20s timeout, runs every 10s)

**Viewer changes**:
- Room list shows all 4 fixed rooms (Main, Breakout 1-3) with participant counts
- Participant count badges appear as accent-colored pills (green default, blue for current room)
- Styled frosted glass hover tooltip shows participant names (with arrow pseudo-element)
- Rooms with active users get green glow highlight
- Current room is accent-highlighted (blue)
- Click any room to switch
- Polls room status every 2 seconds for live cross-room updates
- Sends heartbeat every 10 seconds
- Sends leave notification on disconnect and page close (`beforeunload`)

### Join/Leave/Switch Chime Sounds
**File**: `core/viewer/app.js`

- **Join chime**: Ascending two-note chime (C5->E5) using sine wave
- **Leave chime**: Descending "womp womp" triangle wave
- **Switch chime**: Sci-fi sawtooth swoosh + landing ping
- All sounds synthesized via Web Audio API (no audio files needed)
- Perspective-based: chimes only trigger for events in YOUR current room

### Theme System (7 Interactive Themes)
**Files**: `core/viewer/style.css`, `core/viewer/index.html`, `core/viewer/app.js`

Full theme system with 7 unique visual themes:
1. **Frost** (default) — Blue/dark with drifting shimmer
2. **Cyberpunk** — Hot pink + cyan neon, scan-line overlay
3. **Aurora** — Northern lights gradient, emerald green accent
4. **Ember** — Volcanic deep red/orange, warm pulsing glow
5. **Matrix** — Pure black + falling code rain (canvas-based)
6. **Midnight** — Deep indigo starfield, purple/pink nebula
7. **Ultra Instinct** — Animated GIF background + sparkle particles

### Audio Not Playing for Late-Joining Participants
**File**: `core/viewer/app.js`

- Set `_lkTrack` on audio elements, queued failed audio for user interaction retry
- Made interaction listeners persistent, call `room.startAudio()` on every interaction

### LiveKit Adaptive Quality + Simulcast
**File**: `core/viewer/app.js`

- `adaptiveStream: true` — Auto-adjusts received video quality based on viewport
- `dynacast: true` — Only sends video layers someone is watching
- `simulcast: true` — Multiple quality layers per stream
- 1080p capture resolution, 3 Mbps max bitrate at 60fps

### Power Manager (Auto Server/Gaming Mode)
**Files**: `power-manager/`

- Auto-switches between low-power server mode and full-power gaming mode
- Background watcher checks GPU via nvidia-smi every 45 seconds

### MCP Plugins Installed
**File**: `.mcp.json`

1. GitHub MCP (HTTP) — PR/issue management
2. Chrome DevTools MCP (stdio/npx) — Web viewer debugging (configured for Edge, not Chrome)
3. Context7 — Up-to-date library documentation

### Tauri Hybrid Native Client — BUILT AND WORKING
**Files**: `core/client/` (complete rewrite from egui to Tauri v2)

**What was built**:
- Complete Tauri v2 project replacing the old egui scaffold
- Native window wrapping the web viewer at `https://127.0.0.1:9443/viewer`
- WebView2 configured to accept self-signed TLS cert (`--ignore-certificate-errors`)
- Rust backend exposes Tauri commands: `get_app_info`, `get_control_url`, `toggle_fullscreen`, `set_always_on_top`
- App icons generated (32x32, 128x128, 256x256 PNGs + ICO)
- Capabilities/permissions configured for the main window

**Key files**:
- `core/client/Cargo.toml` — Tauri v2 + serde + reqwest + tokio
- `core/client/build.rs` — Tauri build script
- `core/client/src/main.rs` — Tauri Builder with external URL window
- `core/client/tauri.conf.json` — App config (name, version, icons, CSP disabled for dev)
- `core/client/capabilities/default.json` — Window permissions

**How it works**:
1. Control plane must be running first (`run-core.ps1`)
2. Client opens a native window pointing to the viewer URL
3. All existing web UI (themes, chat, video, rooms) works unchanged
4. Rust commands available for native-only features (fullscreen, always-on-top)

**Build**: `cargo build -p echo-core-client` (from `core/`)
**Run**: `core/target/debug/echo-core-client.exe`

### HTTP Deploy Agent for SAM-PC
**Files**: `core/deploy/`

**Purpose**: Automated build push/log pull between dev PC and test PC (SAM-PC).

**Components**:
- `core/deploy/agent.ps1` — HTTP listener for SAM-PC (port 8080)
  - `GET /health` — Agent status + client running state
  - `POST /deploy` — Receives .exe binary, replaces client, auto-starts
  - `GET /logs` — Returns stdout/stderr/agent logs
  - `POST /restart` — Restarts the client
  - `POST /stop` — Stops the client
- `core/deploy/setup-agent.ps1` — One-time setup script (run as Admin on SAM-PC)
  - Creates install directory, copies agent, adds firewall rule
  - Installs as scheduled task (runs at startup as SYSTEM)
- `core/deploy/push-build.ps1` — Dev-side deploy script
  - `-Health` — Check agent status
  - `-LogsOnly` — Fetch remote logs
  - `-Restart` / `-Stop` — Remote control
  - Default: builds release + pushes .exe to SAM-PC

### Deploy Agent Deployed to SAM-PC — WORKING
**Date**: 2026-02-07

**What happened**:
1. SMB connection established via File Explorer network discovery (SAM-PC\Sam / echo123)
2. Mapped `\\SAM-PC\EchoChamber` share (points to `C:\EchoChamber` on SAM-PC)
3. Copied agent.ps1, setup-agent.ps1, config.json to SAM-PC via SMB
4. Firewall rule added on SAM-PC: `netsh advfirewall firewall add rule name="Echo Chamber Deploy Agent" dir=in action=allow protocol=tcp localport=8080`
5. Agent started manually on SAM-PC (not yet installed as scheduled task)
6. Release build pushed from dev PC: 10.5 MB binary deployed via HTTP POST
7. Config pushed: `{"server": "https://192.168.5.70:9443"}`
8. Client launched automatically on SAM-PC!

**Bug fixed during deploy**: `$pid` is read-only in PowerShell — renamed to `$cpid` in agent.ps1

**Deploy workflow** (from dev PC):
```
powershell -ExecutionPolicy Bypass -File core\deploy\push-build.ps1
```
This builds release, pushes exe + config to SAM-PC, and the agent auto-starts the client.

### NSIS Installer + Auto-Updater — BUILT AND WORKING
**Files**: `core/client/tauri.conf.json`, `core/client/Cargo.toml`, `core/client/src/main.rs`, `core/deploy/build-release.ps1`

**What was built**:
- NSIS installer that friends can download and double-click to install (no admin required)
- WebView2 auto-downloads if missing (downloadBootstrapper, silent)
- Start Menu shortcut in "Echo Chamber" folder
- Auto-updater plugin (`tauri-plugin-updater`) checks GitHub Releases on startup
- Signing keypair for update verification (password: "echo")
- Release build script generates installer + signature + `latest.json` manifest

**Build output** (in `core/target/release/bundle/nsis/`):
- `Echo Chamber_0.1.0_x64-setup.exe` (5 MB) — installer for friends
- `Echo Chamber_0.1.0_x64-setup.exe.sig` — signature for auto-updates
- `latest.json` — update manifest for GitHub Releases

**How to build a release**:
```
powershell -ExecutionPolicy Bypass -File core\deploy\build-release.ps1
```

**How to publish**:
1. Bump version in `core/client/tauri.conf.json`
2. Run build-release.ps1
3. Create GitHub Release tagged `v<version>`
4. Upload the .exe, .exe.sig, and latest.json files

**Key details**:
- Signing keys at `core/client/.tauri-keys` (private, gitignored) and `.tauri-keys.pub`
- Password for signing key: "echo"
- Public key in tauri.conf.json (base64-wrapped minisign format)
- Auto-updater checks `https://github.com/SamWatson86/echo-chamber/releases/latest/download/latest.json`

## Current Status

**Installer is built and ready for distribution.** The NSIS installer produces a 5 MB setup.exe that friends can download and install with one double-click. Auto-updates are configured to check GitHub Releases.

**Deploy pipeline to SAM-PC is operational:**
- Dev PC builds release binary
- HTTP push to SAM-PC deploy agent (port 8080)
- Agent receives, writes exe, starts client

### Recent Commits
- `95046c1` — Fix $pid read-only variable bug in deploy agent
- `e433f07` — Prepare for SAM-PC deployment and clean up warnings
- `cfaff80` — Harden control plane mutex locks against thread panics
- `945e01e` — Add Tauri hybrid native client and HTTP deploy agent

### Next Steps
1. **Set up external access** — Port forward router 9443 -> dev PC, get public IP or dynamic DNS
2. **Publish first GitHub Release** — Upload installer so friends can download
3. **Install deploy agent as scheduled task** — So it starts on SAM-PC boot
4. **Test video streaming** — SAM-PC joins a room, verify 1080p/60fps
5. **Code signing certificate** — Prevents "Unknown publisher" Windows SmartScreen warning (costs money, can add later)
6. **Add native features** — LiveKit native SDK, hardware encode/decode (NVENC on GTX 760)

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (Docker) — handles media routing
- **Control**: Rust control plane — auth, rooms, admin (`core/control`)
- **Client**: Tauri hybrid native app — web UI + Rust backend (`core/client`) — **WORKING**
- **Viewer**: Web viewer for UI optimization (`core/viewer`) — serves both browser and Tauri
- **Deploy**: HTTP deploy agent for test PC (`core/deploy`)

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
- SFU: `docker compose logs --tail 200` (from `core/sfu` directory)

## Files to Know
- `core/viewer/app.js` — Web viewer (video + chat UI) ~4700 lines
- `core/viewer/style.css` — Frosted glass CSS with 7 themes
- `core/viewer/index.html` — Viewer HTML structure
- `core/control/src/main.rs` — Rust control plane (with participant tracking)
- `core/client/src/main.rs` — Tauri native client (wraps web viewer)
- `core/client/tauri.conf.json` — Tauri app configuration
- `core/deploy/agent.ps1` — Deploy agent for test PC
- `core/deploy/push-build.ps1` — Dev-side deploy script
- `core/sfu/docker-compose.yml` — LiveKit SFU config

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. Ask Sam about current status
4. Continue from where we left off
