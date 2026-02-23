# Echo Chamber - Project Context

## What Is This?
A self-hosted video conferencing app for Sam and friends ("The Fellowship of the Boatrace"). Uses LiveKit SFU for WebRTC media, Rust control plane, Tauri native Windows client, and web viewer. Built for 1080p@60fps with adaptive quality.

## Sam Is NOT A Developer
- Do NOT ask Sam to run commands, edit files, or debug
- Do NOT ask for confirmation before local operations — FULL AUTONOMY for local work
- Use `Start-Process -Verb RunAs` when elevated permissions needed (Sam clicks UAC prompt)
- Guide and explain, don't instruct

## NEVER Push to GitHub for Server Changes
- The server runs on Sam's local PC. Server changes deploy by rebuild + restart locally.
- GitHub pushes are ONLY for client releases (Tauri installer distributed to friends)
- Client releases use version tags: `git tag v0.X.Y && git push --tags` (triggers CI)
- CI is `workflow_dispatch` (manual) for builds, tag-triggered for releases
- **Ask Sam before ANY `git push` operation**

## Architecture
- **LiveKit SFU** (`core/sfu/`) — Native Windows binary, WebRTC media routing
- **Rust Control Plane** (`core/control/`) — HTTPS server (axum), room management, auth, API endpoints, serves viewer + admin files
- **Web Viewer** (`core/viewer/`) — Browser-based UI with video, chat, themes, soundboard, jam session. Files served by control plane.
- **Tauri Client** (`core/client/`) — Native Windows app, loads viewer from server URL (not embedded). Distributed to friends via GitHub Releases.
- **TURN Server** (`core/turn/`) — Native Go binary, NAT traversal for external users
- **Admin Dashboard** (`core/admin/`) — Browser-only admin page at `/admin` for monitoring
- **Deploy Pipeline** (`core/deploy/`) — Build, sign, push to test PC

## Key Paths
- Main repo: `F:\Codex AI\The Echo Chamber\`
- Control plane source: `core/control/src/main.rs`
- Viewer JS: `core/viewer/app.js` (~9200 lines)
- Viewer CSS: `core/viewer/style.css`
- Viewer HTML: `core/viewer/index.html`
- Jam Session: `core/viewer/jam.js`, `core/viewer/jam.css`
- Binary (debug): `core/target/debug/echo-core-control.exe`
- Logs: `core/logs/core-control.out.log`
- Session logs: `core/logs/sessions/`
- Bug reports: `core/logs/bugs/`

## Key Constraints
- Focus ONLY on `core/` — `apps/` is legacy, DO NOT TOUCH
- Windows-only target (PowerShell 5.1, not UTF-8)
- Sam uses Edge, not Chrome
- Tauri client loads viewer from server URL — viewer file changes are live on refresh (no client rebuild needed)
- Rust changes require: `cargo build -p echo-core-control` in `core/` directory, then copy binary + restart
- The build workspace is at `core/Cargo.toml`, NOT root

## Running
```powershell
powershell -ExecutionPolicy Bypass -File .\run-core.ps1
```
- Viewer: https://127.0.0.1:9443/viewer/
- Health: https://127.0.0.1:9443/health
- Admin: https://127.0.0.1:9443/admin (Sam-only, browser)
- Client: core/target/debug/echo-core-client.exe

## After Changes
- **app.js / style.css / jam.js**: Just refresh client — server serves these live. Cache-busting (`?v=version`) is automatic.
- **index.html**: Restart control plane (server stamps version strings at startup)
- **Rust code**: Rebuild in `core/` dir → kill old process (elevated) → copy binary → restart
- **Tauri client code**: `cargo tauri build` for installer, only needed for client-specific changes

## Worktree Workflow
- Claude Code creates worktrees in `.claude/worktrees/` for code isolation
- Build from worktree: `cd core/ && cargo build -p echo-core-control`
- Copy built binary to main repo: `core/target/debug/echo-core-control.exe` → main repo same path
- Copy viewer files to main repo: `core/viewer/app.js`, `style.css`, etc.
- The SERVED files are always from the main repo `core/viewer/` directory

## Process Management
- Processes started as admin can't be killed from non-admin shell
- Kill elevated process: `Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe"' -Verb RunAs`
- Sam clicks the UAC prompt, Claude handles the rest

## Session Continuity
- **Before ending a conversation**: Update `CURRENT_SESSION.md` with what changed and what's next
- **When Sam says "handover"**: Update all docs (CURRENT_SESSION.md, MEMORY.md, CLAUDE.md)
- See CURRENT_SESSION.md for latest state, bugs, and pending work
