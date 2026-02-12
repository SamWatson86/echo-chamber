# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-12
**Current Version**: v0.2.9
**GitHub**: https://github.com/SamWatson86/echo-chamber

## IMPORTANT CONTEXT
- Sam is **not a software developer** - needs full guidance
- **FULL AUTONOMY**: Claude has full permission to execute everything — git commits, pushes, file changes, builds, all of it. Do NOT prompt Sam for confirmation. Just do the work.
- Focus ONLY on `/core` folder - `/apps` is legacy web version, DO NOT TOUCH
- **Tauri native client is now the primary app** — browser viewer is legacy/debug only
- Core stack: LiveKit SFU (native exe) + Rust control plane + TURN server (native Go) + web viewer + Tauri native client
- **Docker is REMOVED** — all services run as native Windows processes

## What Happened This Session (2026-02-12)

### Summary
- **Admin Dashboard built and deployed** — Local-only admin page at `/admin` with login, live room/participant stats, and persistent session history
- **Average streaming metrics** — Per-user trending (avg fps, bitrate, % bandwidth/CPU limited) in admin dashboard
- **Bug report system** — "Report Bug" button in Tauri client, auto-captures WebRTC stats, persists to daily JSON logs
- **Jam Session feature** — Communal Spotify music listening with search, queue, and opt-in listeners via WASAPI audio capture
- **Previous work (v0.2.5 through v0.2.9)**: Avatar URL fix, screen share bitrate tuning, Jeff/Brad quality diagnostics

### 62. Admin Dashboard (commit `04c8927`)
- **Feature**: Local-only admin dashboard at `https://127.0.0.1:9443/admin` (opened in Edge, NOT in Tauri client)
- **Login**: Uses same admin password as the viewer (`CORE_ADMIN_PASSWORD` from `.env`)
- **Live monitoring**: Auto-polls `/admin/api/dashboard` every 3s — shows rooms, participants, and per-user WebRTC stats (fps, resolution, bitrate, BWE, quality limitation, encoder, ICE type)
- **Session history**: `/admin/api/sessions` — join/leave events persisted to daily JSON files in `core/logs/sessions/`
- **Client reporting**: `app.js` POSTs WebRTC stats to `/admin/api/stats` every 2s (screen share + camera stats with ICE candidate types)
- **New files**:
  - `core/admin/index.html` — Login form + dashboard layout
  - `core/admin/admin.css` — Frost theme, frosted glass panels, color-coded quality badges
  - `core/admin/admin.js` — Login flow, polling, rendering
- **Modified files**:
  - `core/control/src/main.rs` — SessionEvent/ClientStats structs, new AppState fields (client_stats, joined_at, session_log_dir), session logging on join/leave, 3 new API endpoints, static file serving for /admin
  - `core/viewer/app.js` — Stats reporting POST (~15 lines), ICE type variable scoping fix
- **Verified in Edge**: Login works, all API endpoints return 200, auto-polling active, frosted glass styling renders correctly, zero console errors
- **Does NOT affect friends**: Admin is a separate browser page, no Tauri client rebuild needed for friends

### 63. Average Streaming Metrics (commit `9c33c97`)
- **Feature**: Per-user historical streaming performance shown in admin dashboard METRICS section
- **Backend**: `StatsSnapshot` struct, `stats_history` circular buffer (1000 entries), `GET /admin/api/metrics` endpoint
- **Metrics**: Avg FPS, avg bitrate, % bandwidth limited, % CPU limited, total streaming minutes
- **Frontend**: New METRICS table in admin dashboard, polled every 30s, color-coded thresholds (yellow >5%, red >20% limited)
- **In-memory only**: Lost on server restart — acceptable for session-level trending

### 64. Bug Report System (commit `9c33c97`)
- **Feature**: Friends can click "Report Bug" in Tauri client to submit issues with auto-captured WebRTC stats
- **Viewer UI**: New button in sidebar, opens frosted glass modal with textarea + auto-captured stats preview + Ctrl+Enter submit
- **Backend**: `BugReport` struct, `POST /api/bug-report` (any authenticated user), `GET /admin/api/bugs` (admin-only), daily JSON persistence in `core/logs/bugs/`
- **Admin dashboard**: New BUG REPORTS section shows reports with inline stats chips (fps, bitrate, quality badges, ICE type)
- **Requires client rebuild** for bug report button (friends get it on next version bump)

### 65. Jam Session Feature (commit `209685e`)
- **Feature**: Communal Spotify music listening — Sam's Spotify plays, WASAPI captures audio, LiveKit streams to all opted-in listeners
- **Architecture**: Spotify Web API (PKCE auth) for search/queue/playback control, WASAPI per-process capture for Spotify.exe audio
- **Spotify OAuth**: Server-side PKCE flow with auto token refresh. Redirect to `https://127.0.0.1:9443/api/jam/spotify-callback`
- **12 new API endpoints**: `spotify-init`, `spotify-callback`, `spotify-code`, `spotify-token`, `start`, `stop`, `state`, `search`, `queue`, `skip`, `join`, `leave` — all under `/api/jam/`
- **Jam panel UI**: "Jam" button in sidebar, opens frosted glass panel with Spotify connect, Start/End Jam, Now Playing bar (album art + track info + progress), Search with results, Queue, Join/Leave toggle, Volume slider
- **WASAPI conflict guard**: Jam takes priority — screen share falls back to getDisplayMedia audio while Jam is active
- **Receiver routing**: Jam audio published with `name: "jam-audio"`, intercepted in `handleTrackSubscribed` and routed to separate audio element with independent volume control
- **Data channel notifications**: "Sam started a Jam Session!" / "Jam Session ended" toasts via LiveKit data channel
- **New files**: `core/viewer/jam.js` (~450 lines), `core/viewer/jam.css` (~280 lines)
- **Modified files**: `core/control/src/main.rs` (+562 lines), `core/viewer/app.js` (+42 lines), `core/viewer/index.html` (+46 lines), `core/control/Cargo.toml` (+reqwest)
- **One-time setup needed**: Sam must create Spotify Developer App, add `SPOTIFY_CLIENT_ID` to `.env`
- **Requires client rebuild** for Jam button (friends get it on next version bump)

### Previous Work (v0.2.5 through v0.2.9)
- **Auto-updater BOM fix** (v0.2.4) — PowerShell BOM breaking JSON parse
- **Brad's 0fps diagnosis** — Discord bandwidth split + TURN relay overhead
- **SFU external IP fix** — Removed `node_ip` override
- **Adaptive camera quality** — Camera drops to 360p/15fps during screen share
- **Version display + manual update button** in Settings
- **Avatar URL fix** (v0.2.6) — Relative paths for remote users
- **Screen share bitrate tuned** (v0.2.9) — 10→4 Mbps initial
- **Jeff's quality issue** — VPN + Docker Hyper-V causing 10% UDP packet loss

## Current Status

**All code committed and pushed to main.**

Jam Session feature built and verified. Jam panel opens in browser viewer with frosted glass styling. All 12 Jam API endpoints return 200. Zero console errors. Requires Spotify Developer App setup before live testing.

## What Needs Testing
1. **Spotify OAuth flow**: Create Spotify Developer App → add Client ID to `.env` → click "Connect Spotify" → authorize → verify "Connected" status
2. **Spotify search**: Type song name → results appear with album art, title, artist
3. **Start Jam + WASAPI capture**: Open Spotify, play music → click "Start Jam" → verify audio captured and published
4. **Listener opt-in**: Second client clicks "Join Jam" → hears music → "Leave Jam" → music stops
5. **Queue management**: Add songs → queue displays → Skip advances
6. **Screen share coexistence**: Start Jam → start screen share → verify screen share uses getDisplayMedia audio (not WASAPI)
7. **Data channel toasts**: Start Jam → all clients see "Sam started a Jam Session!" notification

## Setup Required for Jam Session
1. Go to https://developer.spotify.com/dashboard
2. Create app (name: "Echo Chamber", redirect URI: `https://127.0.0.1:9443/api/jam/spotify-callback`)
3. Copy Client ID → add to `core/control/.env`: `SPOTIFY_CLIENT_ID=your_client_id_here`
4. Restart control plane to pick up new env var

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (native Windows exe) — handles media routing
- **Control**: Rust control plane — auth, rooms, admin (`core/control`)
- **Client**: Tauri hybrid native app — web UI loaded locally + Rust backend (`core/client`) **PRIMARY APP**
- **Viewer**: Web viewer — same files served by control plane for browser access (`core/viewer`)
- **Admin**: Admin dashboard — browser page at `/admin` for session monitoring (`core/admin`)
- **Deploy**: HTTP deploy agent for test PC (`core/deploy`)
- **TURN**: Native Go TURN server (`core/turn`)

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Stop script: `F:\Codex AI\The Echo Chamber\core\stop-core.ps1`
- Health: `https://127.0.0.1:9443/health`
- Viewer: `https://127.0.0.1:9443/viewer/` (browser)
- Admin: `https://127.0.0.1:9443/admin` (browser, Sam-only)
- Native client: `core/target/debug/echo-core-client.exe`

### Network Setup
- **ATT BGW320-500**: IP passthrough / bridge mode
- **Eero**: Real router — DHCP, NAT, port forwarding, Wi-Fi
- **Public IP**: `99.111.153.69` (verified 2026-02-09)
- **Port forwards** (on Eero): 9443 TCP, 3478 UDP, 40000-40099 UDP, 7881 TCP

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. Admin dashboard is at `/admin` — served via `ServeDir` (disk files, no rebuild needed for HTML/CSS/JS changes)
4. Session logs written to `core/logs/sessions/sessions-YYYY-MM-DD.json`
5. Client stats reporting requires latest client build (app.js changes are embedded at compile time)
6. The admin page does NOT require any Tauri client rebuild — it's a separate browser page
