# Open Issues Batch — Design

**Date:** 2026-02-28
**Issues:** #84, #85, #86, #87, #88, #90, #93 (defer #83)

## Group 1: Feedback Dialog (#85, #86, #87, #88)

### #85 — Screenshot upload "failed"
Investigate `attachBugReportScreenshot()` in `admin.js`. The function POSTs to `/api/chat/upload` with Bearer token. Consistently fails for both file picker and Ctrl+V paste. Debug the upload flow, fix root cause.

### #86 — Dialog overflow on small windows
Add `max-height: 90vh; overflow-y: auto` to `.bug-report-content` so it scrolls instead of clipping off-screen.

### #87 — Increase max characters
Bump `maxlength` from 1000 to 5000 on textarea. Check Rust endpoint for server-side limits.

### #88 — Split into Title + Description
Add `<input type="text" id="bug-report-title">` above textarea. Send as `title` field in API payload. Rust side: use explicit title for GitHub issue title instead of truncating description.

## Group 2: Screen Share Volume (#90)

Add volume slider directly on screen tiles, next to the existing fullscreen button. Shows when tile has audio. Syncs bidirectionally with the existing participant card slider (both update `state.screenVolume`).

## Group 3: Soundboard UX (#93)

Replace emoji-only square grid with wider pill buttons showing `[emoji] Name`. Change from 4-column to 2-column layout. Add search/filter input at top of compact panel.

## Group 4: Login Page Cleanup (#84)

1. Hide URL fields behind an "Advanced" toggle
2. Auto-fill admin password from saved storage; only show field if none saved or login fails
3. Move online users above Connect button for prominence
4. Hide device selectors pre-connect (available in post-connect Settings panel)

## Deferred: #83 (Signal Notifications)

Requires external infrastructure (signal-cli, Google Voice number). Keep issue open for separate effort.
