# Echo Chamber - Current Session Notes

**Last Updated**: 2026-03-15
**Current Version**: v0.4.1 (released — CI complete, server running locally)
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

## What Changed Today (2026-03-15)

### PG-13 Sync Query Mechanism (#104) — FIX
- Previous fix (ParticipantConnected re-broadcast) had timing issues — new joiner's data channel often not ready yet
- Added "pg13-query" mechanism: new joiner sends query 2s after connecting, existing participants with PG-13 active respond directly
- ParticipantConnected broadcast now targeted to specific new joiner via `destinationIdentities` (no longer spams everyone)
- New `pg13-query` handler in DataReceived responds with targeted `pg13-mode` sync message
- Files: `connect.js`, `changelog.js`

### Bug #110: Feedback screenshots not appearing in GitHub Issues — FIX
- Screenshots uploaded via feedback form were stored locally as `/api/chat/uploads/upload-{ts}` — a relative URL unreachable by GitHub
- `create_github_issue()` now reads the screenshot file from disk, base64-encodes it, and embeds it as an HTML `<img>` inside a `<details>` block in the issue body
- Images over 48KB (too large for GitHub issue body) get a local file reference instead
- Added `base64` crate dependency to `core/control/Cargo.toml`
- Files: `core/control/src/main.rs`, `core/control/Cargo.toml`
- **Requires rebuild + restart of control plane**

---

## What Changed (2026-03-06)

### Security Hardening Batch — DEPLOYED
Three security fixes implemented and verified:

1. **Login rate limiting** (`main.rs`) — IP-based, 5 failed attempts per 15 min window → HTTP 429. Uses `ConnectInfo<SocketAddr>` extraction + `HashMap<IpAddr, (u32, Instant)>` in AppState. Successful login clears counter.
2. **Path traversal prevention** (`main.rs`) — `is_safe_path_component()` validates room names and file names in `create_room`, `chat_history_path`, `soundboard_room_dir`, `soundboard_file_path`. Rejects `/`, `\`, `..`, empty strings.
3. **Chat fileUrl token leak** (`chat.js`) — Rejects `fileUrl` not starting with `/` at top of `renderChatMessage()`. Prevents `fetchImageAsBlob()` from sending Bearer token to attacker-controlled external URLs.

### CSS Screen Share Overflow Fix
- `.screens-grid` changed to `grid-auto-rows: 1fr` + `overflow: hidden`
- `.screens-grid .tile` gets `max-height: 100%` to prevent tiles exceeding viewport when maximized

### Screen Share Stop Banner Fix (`screen-share.js`)
- `stopScreenShareManual()` now stops original getDisplayMedia tracks (not just canvas tracks)
- Fixes browser "sharing your screen" indicator persisting after clicking the stop share button

---

## What Changed (2026-03-03)

### PG-13 Sync for Late Joiners (#104) — FIX
- Late joiners now receive PG-13 state from existing participants
- Re-broadcast via `ParticipantConnected` handler (same pattern as avatar/device sync)
- `sync: true` flag distinguishes from manual toggle — subtle toast, no speech, deduped
- Files: `connect.js`

### Mic/Cam Switching Fix (#105) — FIX
- `switchMic()` and `switchCam()` now use `restartTrack()` for seamless device switching
- LiveKit SDK's `setMicrophoneEnabled(true)` was short-circuiting when mic already on
- Fallback to disable/re-enable if `restartTrack` unavailable
- Added try/catch + debug logging for both paths
- Files: `media-controls.js`

---

## What Changed (2026-02-28)

### PG-13 Mode (#98) — NEW
- **Toggle button** in Active Users sidebar (row 1: Chat, Mute All, PG-13)
- **Animated gradient banner** appears at top of room when active (yellow/orange shimmer)
- **Glowing amber border** around room layout via `.pg13-active` box-shadow
- **Speech synthesis** announces "PG-13 Mode Enabled/Disabled"
- **Data channel broadcast** — all participants see/hear the toggle + toast with who toggled it
- **Ephemeral** — resets on disconnect (per-session state)
- **Debug button relocated** from Active Users sidebar to top `.room-actions` bar (next to Settings/Feedback)
- Files: `index.html`, `style.css`, `state.js`, `media-controls.js`, `connect.js`

### Mobile Browser Support (3 fixes)
1. **Camera flip button** — "Flip" button on mobile toggles front/back camera via `facingMode`. Hidden on desktop. Camera dropdown hidden on mobile (cryptic labels).
2. **Screen tile cleanup on disconnect** — ParticipantDisconnected handler now cleans up screen tiles from `screenTileByIdentity`, `screenTileBySid`, `screenTrackMeta`, `screenRecoveryAttempts`, `screenResubscribeIntent`. Fixes stale tiles after abrupt mobile disconnects.
3. **16:9 aspect ratio on screen tiles** — Added `aspect-ratio: 16 / 9` to `.screens-grid .tile`. Portrait video gets side letterboxing. Added `.portrait` CSS class detection in `tagAspect()`.

### Chat Visual Improvement
- Per-user color coding: 15-color deterministic palette, left border stripe `border-left: 3px solid var(--chat-user-color)`, self-messages get green tint. Author name shows in user's color.

### GitHub Issues Batch (7 issues closed)
- **#84** — Login page cleanup: password hidden by default (auto-fills), URLs/devices behind "Advanced" toggle, password shows on auth failure
- **#85** — Screenshot upload fix: FormData → ArrayBuffer to match server expectation
- **#86** — Dialog overflow fix: `max-height` + `overflow-y: auto` on bug report content
- **#87** — Max characters increased: 1000 → 5000 on feedback textarea
- **#88** — Title + Description split: separate title input (120 chars), flows to GitHub issue title, Rust structs updated
- **#90** — Screen share volume slider on tile: shows on hover, syncs with participant card slider, only appears with audio track
- **#93** — Soundboard compact UX: pill buttons with emoji + name, search filter input, panel widened to 320px

### Issues Also Closed (confirmed fixed earlier)
- **#89** — Stale screen tiles (fixed by disconnect cleanup above)
- **#91** — Duplicate of #89
- **#92** — Zane's audio lag (GPU overload from Resident Evil, not a code bug)

---

## What's Working (v0.4.1)

### Core Features
- WebRTC video/screen sharing via LiveKit SFU (1080p@60fps target)
- Multi-room support with room switching
- Chat with file/image upload, emoji picker, link rendering, image fullscreen lightbox, **per-user color coding**
- Soundboard with custom uploads, icons, per-clip volume, **compact search + pill buttons**
- Camera lobby for previewing webcams
- 7 themes (Frost, Cyberpunk, Aurora, Ember, Matrix, Ultra Instinct) with opacity slider
- Bug report system with screenshot attachment, auto-captured WebRTC stats, clipboard paste, **title + description fields**
- Admin dashboard with live stats, session history, metrics, bug reports
- Auto-update check + native Tauri auto-updater
- macOS Apple Silicon support (DMG + auto-updater)
- Per-startup cache-busting stamps — dashboard detects stale viewers
- **PG-13 Mode** — room-wide content warning toggle with banner, glow, speech, data channel sync
- **Mobile browser support** — camera flip, clean disconnect, proper aspect ratio
- **Screen share volume slider on tile** — hover to adjust
- **Streamlined login page** — clean layout, Advanced toggle for power users

### Jam Session (Spotify Integration)
- Spotify OAuth PKCE flow with token persistence
- Song search, queue management, skip
- Queue no longer drains when searching (fixed in v0.4.1)
- WASAPI per-process audio capture (Spotify.exe)
- WebSocket audio streaming to opted-in listeners

---

## Known Bugs / Open Items

- Minor: stale `cameraTrackSid` in observer's participantState after remote camera unpublish (cosmetic only)
- **#83** — Signal notifications (deferred — requires external infrastructure setup)

### Security Hardening (audited 2026-03-03)

Full security sweep completed. No credentials in git, no eval/injection, TLS enforced.

**FIXED (2026-03-06):**
- ~~Admin dashboard XSS~~ — Already fixed, all fields use `esc()` / `escAdm()`
- ~~Chat fileUrl token leak~~ — Rejects external URLs in `renderChatMessage()` (`chat.js`)
- ~~Login brute-force~~ — IP-based rate limit 5/15min with 429 response (`main.rs`)
- ~~Path traversal~~ — `is_safe_path_component()` on room names + file names (`main.rs`)

**Remaining (lower priority):**
- `/api/online` unauthenticated — leaks room membership
- CORS fully open (`Any`) — should scope to `tauri://localhost` + server origin
- No security headers (CSP, HSTS, X-Frame-Options, nosniff)
- Avatar URL spoofing via data channel (no sender identity validation)
- Admin password uses plaintext path in .env (Argon2 path exists but unused)

---

## Active Worktree
- None — on main, all changes committed directly.

---

## Files Modified This Session

### Viewer JS
- `core/viewer/state.js` — Added `flipCamBtn`, `_camFacingMode`, `pg13ModeActive`, `togglePg13Button`
- `core/viewer/media-controls.js` — Added `flipCam()`, mobile facingMode in `switchCam()`/`toggleCam()`, PG-13 toggle/apply/announce functions, **restartTrack for mic/cam switching**
- `core/viewer/connect.js` — Screen tile cleanup in disconnect handler, password field show on auth failure, local screen tile identity, PG-13 data handler + button enable/disable, **PG-13 sync re-broadcast + dedup**
- `core/viewer/participants.js` — `.portrait` class in `tagAspect()`, volume slider in `addScreenTile()`
- `core/viewer/audio-routing.js` — `tile.dataset.identity`, volume slider reveal on screen audio attach
- `core/viewer/app.js` — Flip button handler, mobile cam dropdown hide, password auto-fill, Advanced toggle
- `core/viewer/chat.js` — Per-user color system, `--chat-user-color` CSS var, `.self` class
- `core/viewer/soundboard.js` — Pill buttons with names, search filter
- `core/viewer/admin.js` — Screenshot upload fix (ArrayBuffer), bug report title field

### Viewer HTML/CSS
- `core/viewer/index.html` — Flip button, login page restructure, title input, soundboard search, maxlength 5000, PG-13 banner + button, Debug moved to top bar
- `core/viewer/style.css` — All new styles (flip button, login page, chat colors, dialog overflow, title input, volume slider, soundboard pills, screen tile aspect ratio, PG-13 banner/glow/button)

### Rust
- `core/control/src/main.rs` — `title` field in BugReport/BugReportRequest structs, `create_github_issue()` title logic

---

## Version History (Recent)

### v0.4.1 (2026-02-27) — Released
- Fix "Update available" banner (#79) — Cargo.toml versions synced
- Fix jam queue drain on search (#77) — server auto-remove guard
- Chat image fullscreen lightbox (#75) — CSS for existing JS
- Fix macOS camera card glitch — dead track re-attach guard
- Post-release: clipboard paste in feedback (#81), cache-bust stamper fix

### v0.4.0 (2026-02-27)
- macOS Apple Silicon DMG in releases
- macOS auto-updater support via unified latest.json
- Viewer modularized into 19 JS files
- Camera desync fix, LK TDZ fix

### v0.3.1 (2026-02-14/16/23/24)
- Admin Dashboard v2, AIMD bitrate control, volume boost, security fixes, 33 issues resolved

---

**When resuming:**
1. Read this file first
2. Read CLAUDE.md for architecture and rules
3. Check git log for any commits after this document's date
4. Check "Known Bugs / Open Items" for what needs work
