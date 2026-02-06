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

## Current Status

**All core work is committed and pushed to GitHub.** Repo is clean.

Only remaining uncommitted files:
- `apps/server/public/app.js` & `style.css` — legacy, we don't touch these
- `.claude/` — Claude Code config (local only)

Ready for next task.

## Architecture Reference

### Core Components
- **SFU**: LiveKit server (Docker) - handles media routing
- **Control**: Rust control plane - auth, rooms, admin (`core/control`)
- **Client**: Native desktop app - Rust (`core/client`) - future target
- **Viewer**: Web viewer for UI optimization (`core/viewer`) - current focus

### How Core Starts
- Run script: `F:\Codex AI\The Echo Chamber\core\run-core.ps1`
- Health check: `http://127.0.0.1:9090/health`
- Viewer: `http://127.0.0.1:9090/viewer`

### Logs
- Control plane: `core/logs/core-control.out.log`, `core/logs/core-control.err.log`
- SFU: `docker compose logs --tail 200` (from `core/sfu` directory)

## Files to Know
- `core/viewer/app.js` - Web viewer (video + chat UI) ~4100 lines
- `core/control/src/main.rs` - Rust control plane
- `core/client/src/main.rs` - Native Rust client
- `core/sfu/docker-compose.yml` - LiveKit SFU config

---

**When resuming this chat:**
1. Read this file first
2. Check git log for any commits after this document was last updated
3. Ask Sam about current status
4. Continue from where we left off
