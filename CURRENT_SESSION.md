# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-24
**Current Version**: v0.3.1 (control plane + client)
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

## ROLLBACK POINT

**Tag `pre-issue-fixes` = commit `a8a6e8d`** — Last known-good state before GitHub issue fixes.
- All code committed, clean working tree
- Server running, Power Manager v2 running (Active mode)
- Viewer, admin dashboard, jam session all functional
- To restore: `git reset --hard pre-issue-fixes`

---

## What Changed Today (2026-02-24)

### Power Manager v2
- Rewrote `watcher.ps1` — uses `GetLastInputInfo` Win32 API instead of GPU polling
- Detects mouse/keyboard activity every 10 seconds, not GPU utilization
- 60-minute idle timeout before switching to Server mode (was 3 minutes)
- Wakes to full power in <10 seconds when you touch mouse/keyboard
- Fixed Session 0 bug: scheduled task runs as user (Interactive) not SYSTEM
- Game process detection kept as safety override
- Files: `power-manager/watcher.ps1`, `power-manager/setup.ps1`, `power-manager/switch-mode.ps1`, `power-manager/config.json`

### Bug Report Fix
- Server endpoint now scans ALL `bugs-*.json` files (was only loading today + yesterday)
- Spencer's reports from Feb 14 now visible in admin dashboard
- File: `core/control/src/main.rs`

### GitHub Issues Triage
- Triaged all 35 of Spencer's issues against current code
- **15 already fixed** — closing with comments
- **14 still exist** — prioritized plan created
- **3 enhancements** — kept open for future
- **3 non-issues** — closing with explanation
- Plan: `docs/plans/2026-02-24-power-manager-v2-design.md`, `docs/plans/2026-02-24-power-manager-v2-plan.md`

---

## What Changed (2026-02-23)

### Admin Dashboard v2 — Major Enhancement
All changes deployed and running. Design doc: `docs/plans/2026-02-23-admin-dashboard-v2-design.md`

1. **30-Color Palette** — Expanded from 8 to 30 curated colors. djb2 hash on display name ensures consistent unique colors across sessions. Applied to leaderboard bars, heatmap highlights, bug charts, quality bars.

2. **Resizable Panel** — Drag handle on left edge, min 400px, max 80vw. Width persisted in `localStorage("admin-panel-width")`. CSS custom property `--admin-panel-width` drives the width.

3. **Interactive Leaderboard → Heatmap** — Click a user bar on leaderboard to filter the heatmap to only that user's activity. Filtered cells show the user's color. "Show All" button to clear. Module-level state: `_admSelectedUser`.

4. **Clickable Heatmap Cells** — Click a cell to see a popup listing which users were active in that hour with color dots + join counts.

5. **Rust Changes** — `HeatmapJoin` struct (timestamp + name) replaces plain `Vec<u64>`. `StatsSnapshot` expanded with `encoder`, `ice_local_type`, `ice_remote_type`. `UserMetrics` expanded with same fields + aggregation in `admin_metrics` handler.

6. **Bug Reports Fixed** — `r.reporter` changed to `r.name` (field name mismatch with Rust struct).

7. **Bug Summary Charts** (Metrics tab) — "Bugs by User" horizontal bar chart + "Bugs by Day" vertical bar chart.

8. **Quality Dashboard** (Metrics tab) — Summary cards (avg FPS, bitrate, BW-limited%, CPU-limited%), Quality Score Ranking (composite 0-100 with colored badges), Per-User FPS/Bitrate bars, Quality Limitation Breakdown (stacked bars: green=clean, yellow=CPU, red=BW), Encoder & ICE Connection table.

9. **Admin Panel Auto-Show Bug Fixed** — The `admin-only` reveal code was removing `hidden` from the panel on login, showing it without calling `toggleAdminDash()` (so no fetches fired → permanent "Loading..."). Fixed by skipping `admin-dash-panel` in the reveal loop.

### Timezone Fix (from previous session)
- Heatmap and timeline now show local timezone instead of UTC
- Dead code cleanup: removed unused `UserTimeline`/`TimeSpan` structs from Rust

---

## What's Working (v0.3.1 MVP)

### Core Features
- WebRTC video/screen sharing via LiveKit SFU (1080p@60fps target)
- Multi-room support with room switching
- Chat with file/image upload, emoji picker, link rendering
- Chat message deletion (users can delete their own messages)
- Soundboard with custom uploads, icons, per-clip volume
- Camera lobby for previewing webcams
- 7 themes (Frost, Cyberpunk, Aurora, Ember, Matrix, Ultra Instinct) with opacity slider
- Bug report system with screenshot attachment and auto-captured WebRTC stats
- Admin dashboard (in-app panel) with live stats, session history, metrics, bug reports
- Auto-update check (queries server, not GitHub)
- Name impersonation prevention (server rejects duplicate names)
- Cache-busting: server stamps `?v={version}` on all JS/CSS URLs at startup

### Jam Session (Spotify Integration)
- Spotify OAuth PKCE flow with token persistence
- Song search, queue management, skip
- WASAPI per-process audio capture (Spotify.exe)
- WebSocket audio streaming to opted-in listeners
- Now Playing banner, join/leave toggles
- WASAPI conflict guard (screen share falls back to getDisplayMedia audio during jam)
- **Dedicated Spotify account**: thefellowshipoftheboatrace@gmail.com (Sam's family plan), Client ID `ef0d20da592a429b9bdf1c4893bddb92`

### AIMD Adaptive Publisher Bitrate Control (Added 2026-02-16)
- Receiver detects packet loss on incoming screen share → sends `bitrate-cap` via data channel to publisher
- Publisher caps `maxBitrate` on its screen share encoding (Multiplicative Decrease: ×0.7 on loss)
- Probe-up phase: +500kbps every 6s until cap reaches 6Mbps (Additive Increase)
- Resolution stays 1080p@60fps — only compression quality changes (no 360p jumps)
- 10s fallback: if publisher doesn't ack (old client), falls back to v3 layer switching

### Mic/Screen Volume Boost (Added 2026-02-16)
- Per-participant volume sliders now go 0–300% (was 0–100%)
- Audio routed through WebAudio GainNode for amplification beyond 1.0
- Single shared AudioContext for all participant audio (avoids browser limits)
- Speaker device selection works correctly — AudioContext.setSinkId() synced with device picker
- Percentage label next to each slider, turns accent-colored when boosted above 100%
- Gain nodes cleaned up on track removal
- Both mic and screen share audio support boosting

### Admin Dashboard v2 (Added 2026-02-23)
- 30-color palette with djb2 hash for unique, consistent user colors
- Resizable panel with drag handle (400px–80vw), localStorage persistence
- Interactive leaderboard: click user → filter heatmap to that user
- Clickable heatmap cells: popup showing active users per hour
- Bug summary charts: bugs by user + bugs by day on Metrics tab
- Quality dashboard: summary cards, quality score ranking (0-100), per-user FPS/bitrate bars, quality limitation breakdown, encoder & ICE connection table
- Fixed bug reports display (field name mismatch)
- Fixed auto-show bug (panel no longer appears on admin login without fetching data)

### Infrastructure
- Let's Encrypt TLS with custom domain
- TURN server for NAT traversal
- Port forwards: 9443 TCP, 3478 UDP, 40000-40099 UDP, 7881 TCP
- Public IP: 99.111.153.69

---

## Known Bugs / Open Items

### Needs Monitoring
1. **Brad's streaming stability** — AIMD bitrate control keeps 1080p@60fps, adjusts compression only. Brad getting AT&T fiber on Tuesday 2026-02-18 — should eliminate bursty packet loss at source.
2. **David's reconnection resilience** — Fixed false exit chimes, audio loss after reconnection, and slow FPS recovery. David needs to test during his next session.
3. **Admin Dashboard v2 verification** — Just deployed. Sam needs to verify all new features work: colors, resize, leaderboard click→heatmap filter, heatmap cell click→popup, bug charts, quality dashboard.

### Needs Investigation
4. **35fps cap in Phase 1** — David's stream stuck at ~35fps for first 2-3 minutes even on HIGH layer, then jumps to 60fps. Correlates with ICE pair switch in SFU log.

### Minor / Cosmetic
5. **Old worktrees** — `awesome-newton` and `lucid-joliot` worktrees are orphaned in `.claude/worktrees/`. Can be cleaned up with `git worktree remove`.
6. **Schema file noise** — `core/client/gen/schemas/desktop-schema.json` and `windows-schema.json` show as modified but are auto-generated. Not committed.

---

## Active Worktree
- **vigilant-wilson**: `.claude/worktrees/vigilant-wilson/` — Used for Admin Dashboard v2 work. All changes have been copied to main repo and deployed.

## Files Modified (Admin Dashboard v2)
- `core/viewer/app.js` — 30-color palette, resize IIFE, interactive leaderboard/heatmap, bug charts, quality dashboard, admin-only reveal fix
- `core/viewer/style.css` — Resize handle, popup, bug chart, quality dashboard styles
- `core/control/src/main.rs` — HeatmapJoin struct, StatsSnapshot expansion, UserMetrics expansion, encoder/ICE aggregation, timezone fix
- `docs/plans/2026-02-23-admin-dashboard-v2-design.md` — Design document
- `docs/plans/2026-02-23-admin-dashboard-v2-plan.md` — Implementation plan

---

## Version History (Recent)

### v0.3.1 (2026-02-14/16/23) — Current
- Admin Dashboard v2: 30 colors, resizable, interactive leaderboard/heatmap, bug charts, quality dashboard
- Timezone fix: heatmap/timeline show local time
- AIMD adaptive publisher bitrate control (replaces v3 layer switching)
- Mic/screen volume boost up to 300% via WebAudio GainNode
- Admin kick/mute fixed (3-layer bug: wrong JS var, missing JWT grants, empty room field)
- `cdf87e7` Fix streaming stability, add chat message deletion, add cache-busting
- `8c5ae4a` Move version check to server, remove GitHub dependency
- `54cf186` Bump version to v0.3.1

### v0.3.0 (2026-02-12/13)
- `a22f07d` Fix 12 bugs from user reports + critical link security hole
- `c805002` Improve app responsiveness: batch debug DOM updates, reduce polling
- `9b50cfa` Fix theme persistence, identity stability, jam UX, update check
- `c9f0da5` Fix viewer URL trailing slash
- `ee033be` Switch Tauri clients to load viewer from server instead of embedded files
- `77c5a95` Fix 4 bugs: jam display, screen share UX, banner
- Jam Session v2 with WebSocket audio streaming
- Admin client, Let's Encrypt TLS, custom domain

---

## Architecture Reference

### Core Components
| Component | Path | Language | Purpose |
|-----------|------|----------|---------|
| SFU | `core/sfu/` | Go (binary) | LiveKit media routing |
| Control | `core/control/` | Rust (axum) | API server, auth, rooms, file serving |
| Viewer | `core/viewer/` | HTML/JS/CSS | Browser UI (served by control plane) |
| Client | `core/client/` | Rust (Tauri) | Native Windows app |
| Admin | `core/admin/` | HTML/JS/CSS | Admin dashboard (browser-only) |
| TURN | `core/turn/` | Go (binary) | NAT traversal |
| Deploy | `core/deploy/` | PowerShell | Build/sign/push pipeline |

### How Core Starts
- Run: `powershell -ExecutionPolicy Bypass -File .\run-core.ps1`
- Stop: `powershell -ExecutionPolicy Bypass -File .\stop-core.ps1`
- Health: `https://127.0.0.1:9443/health`
- Viewer: `https://127.0.0.1:9443/viewer/`
- Admin: `https://127.0.0.1:9443/admin`

### Network
- ATT BGW320-500 in IP passthrough → Eero router (DHCP, NAT, port forwarding)
- Public IP: 99.111.153.69
- Ports: 9443 TCP, 3478 UDP, 40000-40099 UDP, 7881 TCP

---

## Deployment Workflow

### Server-side changes (viewer JS/CSS, Rust backend)
1. Edit files in worktree
2. If Rust changed: `cargo build -p echo-core-control` in `core/` dir
3. Kill old process (elevated): `Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe"' -Verb RunAs`
4. Copy binary from worktree to main repo `core/target/debug/`
5. Copy viewer files from worktree to main repo `core/viewer/`
6. Start services: `powershell -ExecutionPolicy Bypass -File run-core.ps1`
7. Friends just refresh their Tauri client (F5) to get new viewer code

### Client-side changes (Tauri app itself)
1. Bump version in `core/client/tauri.conf.json` and `core/control/Cargo.toml`
2. Build: `cargo tauri build --bundles nsis` in `core/client/`
3. Tag: `git tag v0.X.Y`
4. Push tag: `git push --tags` (triggers GitHub Release CI)
5. Friends get auto-update notification

---

**When resuming:**
1. Read this file first
2. Read CLAUDE.md for architecture and rules
3. Check git log for any commits after this document's date
4. Check "Known Bugs / Open Items" for what needs work
