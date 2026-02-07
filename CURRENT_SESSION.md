# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-06
**Working On**: Core version only (`/core` folder)
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- We are building a **full-stack SFU pipeline** using the web interface for UI optimization BEFORE moving to the native Rust client
- Core stack: LiveKit SFU (Docker) + Rust control plane + web viewer (temporary UI)

## Project Vision
- **Goal**: 1080p at 60fps for all guests
- **Adaptive quality**: Guests with bad internet need on-the-fly adjustment so they can still participate
- **Pipeline**: Web viewer (current) -> Native Rust client (future)
- The web viewer is for rapid UI/UX iteration. Once optimized, features move to the native client.

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

### Styled Hover Tooltips for Room Buttons
**File**: `core/viewer/style.css`

- Replaced browser `title` attribute with custom CSS tooltips
- Frosted glass style matching the overall UI aesthetic
- Arrow pseudo-element pointing to the room button
- Shows list of participant names in each room

### Green Highlight for Active Rooms
**File**: `core/viewer/style.css`

- `.has-users` class adds green glow border to rooms with people
- Uses `rgba(16, 185, 129, ...)` green tones for consistency

### Join/Leave/Switch Chime Sounds
**File**: `core/viewer/app.js`

- **Join chime**: Ascending two-note chime (C5→E5) using sine wave — plays when someone enters your room
- **Leave chime**: Descending "womp womp" triangle wave — plays when someone disconnects entirely from your room
- **Switch chime**: Sci-fi sawtooth swoosh + landing ping — plays when someone leaves your room to switch to another
- All sounds synthesized via Web Audio API (no audio files needed)
- Perspective-based: chimes only trigger for events in YOUR current room
- `detectRoomChanges()` compares previous vs current participants per room

### Room Dropdown Removal
**Files**: `core/viewer/index.html`, `core/viewer/app.js`, `core/viewer/style.css`

- Removed the `<select id="room-selector">` dropdown from HTML (room list buttons handle switching)
- Cleaned up all `roomSelector` JS references
- Removed `.room-selector` CSS rules

### Phantom Participant Count Fix
**Files**: `core/control/src/main.rs`

**Problem**: Room showed 4 people but only 3 existed. Mobile browser reconnects created new identities (e.g. `sam-phone-2757` → `sam-phone-5299`) and old entries lingered.

**Fix**:
- Name-based deduplication on token issue: strips `-XXXX` suffix and removes old entries with same base name
- Reduced stale timeout from 60s to 20s
- Reduced cleanup interval from 15s to 10s
- Reduced heartbeat from 15s to 10s

### Rapid Room Switching Race Condition Fix
**Files**: `core/viewer/app.js`

**Problem**: Bradford clicked through Main→B1→B2→B3→Main rapidly and lost mic functionality. Multiple concurrent `connectToRoom` calls raced, creating stale room objects.

**Fix**:
- Added `switchingRoom` lock preventing concurrent room switches
- Added `connectSequence` counter — older connections bail at async checkpoints
- Optimized switch speed: disconnect old room BEFORE fetching new token
- Skip `ensureRoomExists` for room switches (fixed rooms already exist)
- Deferred `refreshRoomList` to after connection (non-blocking)
- Made `refreshDevices` non-blocking

### Screen Share "Sharing Another Window" Popup Fix
**File**: `core/viewer/app.js`

- Added `surfaceSwitching: "exclude"` to `getScreenShareOptions()` — suppresses Chrome's "You are sharing another application's window" popup when tabbing back to the viewer
- Added `selfBrowserSurface: "exclude"` — removes current browser tab from the share picker
- Added `preferCurrentTab: false` — prevents Chrome defaulting to sharing the viewer tab

### Camera Toggle Tile Update Fix
**File**: `core/viewer/app.js`

**Problem**: Brad toggled camera on/off/on and his active user tile didn't update (stuck on initials instead of showing video).

**Fix**:
- `TrackMuted`/`TrackUnmuted` handlers now handle video camera tracks (previously only handled audio) — clears/restores avatar when camera is muted/unmuted
- `toggleCam()` now explicitly finds and attaches the camera track to the avatar when re-enabling (instead of relying solely on `LocalTrackPublished` event timing)

### Auto-Enable Mic on Join
**File**: `core/viewer/app.js`

- Mic is now automatically enabled when users connect to a room (`toggleMicOn()` called after connection)
- Users no longer need to manually click "Enable Mic" after joining

### Theme System (7 Interactive Themes)
**Files**: `core/viewer/style.css`, `core/viewer/index.html`, `core/viewer/app.js`

Full theme system with 7 unique visual themes — each overrides CSS variables, panel backgrounds, button states, focus rings, chat colors, room buttons, and includes animated background effects:

1. **Frost** (default) — Current blue/dark look enhanced with drifting shimmer animation
2. **Cyberpunk** — Hot pink (#ff2d78) + cyan (#00f0ff) neon, scan-line overlay, sweeping light animation
3. **Aurora** — Northern lights shifting gradient background, emerald green accent, indigo secondary, glowing orbs
4. **Ember** — Volcanic deep red/orange, warm pulsing glow, amber active room highlights
5. **Matrix** — Pure black + real falling code rain (canvas-based, Japanese/hex characters), all-green UI
6. **Midnight** — Deep indigo starfield background (CSS dot stars), purple/pink nebula gradients
7. **Ultra Instinct** — Animated GIF background (Goku UI aura) + sparkle particle overlay, silver/gray UI

**UI**: "Theme" button in sidebar → centered panel with 7 preview swatches (shimmer on hover). Click to apply instantly.
**Persistence**: Theme + transparency saved to localStorage, restored on page load.
**Matrix canvas**: Created/destroyed dynamically via JS (only runs when Matrix theme is active).
**Ultra Instinct**: `ultrainstinct.gif` as full-screen CSS background (45% opacity), 80 sparkle particles (sparks, orbs, wisps) overlaid via canvas. Silver/gray accent palette for all UI elements.
**UI Transparency Slider**: In theme panel, range 20%-100%. Controls `--ui-bg-alpha` CSS variable which multiplies alpha values in all panel background `rgba()` declarations via `calc()`. Only backgrounds become transparent — text, buttons, user cards, and video elements stay fully solid.

### Audio Not Playing for Late-Joining Participants
**File**: `core/viewer/app.js`

**Problem**: Sam couldn't hear Jeff's mic after Jeff joined. Chrome's autoplay policy blocked audio `play()`, but unlike video (which has a retry-on-user-interaction mechanism), audio failures were silently swallowed with no recovery path. Also, `_lkTrack` was never set on audio elements, causing the dedup display check to always report them as "not displayed".

**Fixes**:
- Set `_lkTrack = track` on audio elements (fixes dedup display check)
- Log audio `play()` failures instead of silently catching them
- Queue failed audio elements in `_pausedVideos` set for user interaction retry
- Made interaction listeners persistent (removed `once: true`) so late-joining participants' audio gets enabled on any subsequent click
- Call `room.startAudio()` on every user interaction to keep AudioContext alive
- Renamed `enableAllVideos` → `enableAllMedia` (handles both audio + video)

### UI Transparency Slider Fix (Background-Only)
**File**: `core/viewer/style.css`, `core/viewer/app.js`

**Problem**: Transparency slider was using `opacity` on entire panel containers, making text/buttons/video transparent too.

**Fix**: Changed to `calc()`-based alpha multiplier (`--ui-bg-alpha`) on background `rgba()` values only. All panel backgrounds across all 7 themes use the variable. Interactive elements stay solid.

### Power Manager (Auto Server/Gaming Mode)
**Files**: `power-manager/setup.ps1`, `power-manager/watcher.ps1`, `power-manager/switch-mode.ps1`, `power-manager/games.txt`

**Purpose**: PC acts as always-on server for Echo Chamber, auto-switching between low-power server mode and full-power gaming mode.

**How it works**:
- `setup.ps1` (run once as Admin): Creates two Windows power plans + installs background watcher as scheduled task
- **Echo Server** plan: CPU 30%, GPU throttled to 25% of max, display off after 1 min, never sleep
- **Echo Gaming** plan: CPU 100%, GPU full power, display off after 15 min, never sleep
- Background watcher checks GPU utilization via `nvidia-smi` every 45 seconds
- GPU usage > 25% or known game process detected → switches to Gaming
- 3 minutes of low GPU → switches back to Server
- NVIDIA GPU power limit adjusted per mode via `nvidia-smi -pl`
- `switch-mode.ps1` for manual override
- `games.txt` for explicit game process names (backup to GPU detection)

**Status**: Setup complete and running. Echo Server plan active (CPU 30%, GPU 112W/450W). Watcher task installed at startup.

### MCP Plugins Installed
**File**: `.mcp.json`

Two MCP plugins configured for the project:
1. **GitHub MCP** (HTTP) — Direct GitHub API access for managing PRs, issues, reviews. Uses OAuth (will prompt for GitHub login on first use).
2. **Chrome DevTools MCP** (stdio/npx) — Connects to Chrome browser for real-time debugging of the web viewer (console, network, DOM inspection).
3. **Context7** — Already installed via VS Code plugin. Up-to-date library documentation.

### LiveKit Adaptive Quality + Simulcast
**File**: `core/viewer/app.js`

**Problem**: Room was created with `adaptiveStream: false, dynacast: false` — all viewers received identical full-quality streams regardless of connection or viewport size. No simulcast encoding.

**Fix** — Enabled three core LiveKit performance features in the Room constructor:
1. **`adaptiveStream: true`** — Auto-adjusts received video quality based on element size/visibility. Small tiles get lower quality, saving bandwidth.
2. **`dynacast: true`** — Only sends video layers that someone is actively watching. If nobody views a stream, encoding stops entirely.
3. **`simulcast: true`** (via `publishDefaults`) — Encodes video at multiple quality layers so the SFU sends each viewer the appropriate quality for their connection.
4. **`videoCaptureDefaults`** — Set to 1080p capture resolution.
5. **`publishDefaults.videoEncoding`** — 3 Mbps max bitrate at 60fps.

These are LiveKit's primary adaptive quality features and directly support the 1080p/60fps goal with adaptive fallback for bad connections.

## Current Status

**All core work is committed and pushed to GitHub.** Repo is clean.

Only remaining uncommitted files:
- `apps/server/public/app.js` & `style.css` — legacy, we don't touch these
- `.claude/` — Claude Code config (local only)
- `.mcp.json` — MCP plugin configuration (should be committed)

Ready for next task.

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (Docker) - handles media routing
- **Control**: Rust control plane - auth, rooms, admin (`core/control`)
- **Client**: Native desktop app - Rust (`core/client`) - future target
- **Viewer**: Web viewer for UI optimization (`core/viewer`) - current focus

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Stop script: `F:\Codex AI\The Echo Chamber\core\stop-core.ps1`
- Health check: `http://127.0.0.1:9090/health`
- Viewer: `http://127.0.0.1:9090/viewer`

### Key Timing Parameters
- Room status polling: every 2 seconds
- Heartbeat: every 10 seconds
- Stale participant cleanup: 20s timeout, 10s check interval

### Logs
- Control plane: `core/logs/core-control.out.log`, `core/logs/core-control.err.log`
- SFU: `docker compose logs --tail 200` (from `core/sfu` directory)

## Files to Know
- `core/viewer/app.js` - Web viewer (video + chat UI) ~4560+ lines
- `core/viewer/style.css` - Frosted glass CSS theme
- `core/viewer/index.html` - Viewer HTML structure
- `core/control/src/main.rs` - Rust control plane (with participant tracking)
- `core/client/src/main.rs` - Native Rust client
- `core/sfu/docker-compose.yml` - LiveKit SFU config

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. Ask Sam about current status
4. Continue from where we left off
