# Echo Chamber - Project Context

## What Is This?
A full-stack video conferencing app using LiveKit SFU, similar to Discord screen sharing but self-hosted. Built for 1080p@60fps with adaptive quality.

## Architecture
- **LiveKit SFU** (`core/sfu/`) — Native binary, WebRTC media routing
- **Rust Control Plane** (`core/control/`) — HTTPS server, room management, serves web viewer
- **Web Viewer** (`core/viewer/`) — Browser-based UI with video, chat, themes
- **Tauri Client** (`core/client/`) — Native Windows app wrapping the web viewer
- **TURN Server** (`core/turn/`) — NAT traversal for external users
- **Deploy Pipeline** (`core/deploy/`) — Build, sign, push to test PC

## Key Constraints
- Focus ONLY on `core/` — `apps/` is legacy
- Windows-only (PowerShell 5.1, not UTF-8)
- Sam uses Edge, not Chrome
- Screen share uses canvas pipeline to bypass Chrome's 30fps cap (see memory/webrtc-debugging.md)

## Running
```powershell
powershell -ExecutionPolicy Bypass -File .\run-core.ps1
```
- Viewer: https://127.0.0.1:9443/viewer
- Health: https://127.0.0.1:9443/health
- Client: core/target/debug/echo-core-client.exe

## After Changes
- **app.js**: Restart control plane + refresh client
- **style.css**: Just refresh client (F5)
- **Rust code**: Rebuild (`cargo build`) + restart
