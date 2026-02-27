# Echo Chamber - Current Session Notes

**Last Updated**: 2026-02-27
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

## What Changed Today (2026-02-27)

### v0.4.1 Bugfix Release (PR #80 — merged, tag pushed, CI complete)

**Fixes 3 GitHub issues + 1 live bug:**

1. **#79 — "Update available" banner stuck after updating**
   - Root cause: `core/client/Cargo.toml` was still at `0.3.1` while `tauri.conf.json` was `0.4.0`
   - Fix: Bumped both `core/client/Cargo.toml` and `core/control/Cargo.toml` to `0.4.1`

2. **#77 — Jam queue empties when searching for new songs**
   - Root cause: Server's auto-remove logic in `jam_state()` drained the ENTIRE queue whenever Spotify was playing a track not in the queue
   - Fix: Added guard — only remove queue entries if the currently playing track exists in the queue

3. **#75 — Chat image fullscreen (Spencer's enhancement request)**
   - JS infrastructure was already done; only CSS was missing
   - Fix: Added lightbox CSS to style.css

4. **Jeff's macOS camera glitch (live bug, no issue number)**
   - Fix: Added `readyState === "ended"` and `!publication?.isSubscribed` guards

### Post-Release Server-Side Fixes (committed to main, local only)

5. **#81 — Clipboard paste in feedback dialog**
   - Extracted upload logic into reusable `attachBugReportScreenshot(file)` function in admin.js
   - Added `paste` event listener on bug report modal for clipboard image paste
   - Added "or Ctrl+V to paste" hint in HTML + CSS

6. **Cache-busting stamper bug — `state.js` was never re-stamped**
   - Root cause: `stamped.find("state.js?v=")` was matching inside `room-switch-state.js?v=...` (substring match)
   - Fix: Include leading `"` in search pattern so only exact asset names match
   - Also changed stamps from static `CARGO_PKG_VERSION` to per-startup timestamp (`0.4.1.{unix_ts}`) so the admin dashboard correctly detects stale viewers after server restarts with file changes

7. **Update loop bug — app kept re-installing on every launch**
   - Root cause: Sam's taskbar/desktop shortcuts pointed to the old local release build (`core/target/release/`) instead of the NSIS-installed binary (`AppData\Local\Echo Chamber\`)
   - Fix: Updated both shortcuts via WScript.Shell COM object

---

## What's Working (v0.4.1)

### Core Features
- WebRTC video/screen sharing via LiveKit SFU (1080p@60fps target)
- Multi-room support with room switching
- Chat with file/image upload, emoji picker, link rendering, **image fullscreen lightbox**
- Soundboard with custom uploads, icons, per-clip volume
- Camera lobby for previewing webcams
- 7 themes (Frost, Cyberpunk, Aurora, Ember, Matrix, Ultra Instinct) with opacity slider
- Bug report system with screenshot attachment, auto-captured WebRTC stats, **clipboard paste**
- Admin dashboard with live stats, session history, metrics, bug reports
- Auto-update check + native Tauri auto-updater
- **macOS Apple Silicon support** (DMG + auto-updater)
- **Per-startup cache-busting stamps** — dashboard detects stale viewers

### Jam Session (Spotify Integration)
- Spotify OAuth PKCE flow with token persistence
- Song search, queue management, skip
- **Queue no longer drains when searching** (fixed in v0.4.1)
- WASAPI per-process audio capture (Spotify.exe)
- WebSocket audio streaming to opted-in listeners

---

## Known Bugs / Open Items

- Minor: stale `cameraTrackSid` in observer's participantState after remote camera unpublish (cosmetic only)

---

## Active Worktree
- None — on main, all branches cleaned up.

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
