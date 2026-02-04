# AGENTS

## Project summary
Echo Chamber is a self-hosted, password-protected, real-time room for mic + screen sharing.
The host runs the server on their Windows 11 machine; friends join in a browser.
A desktop app (Electron) is provided for installing and hosting on Windows.

## Repo structure
- apps/server: Express + WebSocket signaling server and static web client
- apps/server/public: UI (login, lobby, call controls)
- apps/desktop: Electron wrapper that starts the server and opens the local UI
- tools/turn: Self-hosted TURN server (Go) + startup scripts

## Common commands
- npm install
- npm run dev (server only)
- npm run start (server production)
- npm run build (server + desktop)
- npm run pack:win (Windows installer)
- npm run setup:env -w @echo/server "password"

## Environment setup
- Copy apps/server/.env.example to .env (repo root) or apps/server/.env
- Generate AUTH_PASSWORD_HASH with npm run hash:password -w @echo/server "yourpassword"
- Or generate a full .env: npm run setup:env -w @echo/server "yourpassword"
- Set AUTH_JWT_SECRET to a long random string
- For screen sharing over LAN/WAN, use HTTPS with TLS_CERT_PATH and TLS_KEY_PATH
- Optional: set ICE_SERVERS_JSON (TURN/STUN), MAX_PEERS_PER_ROOM, and SERVER_NAME
- Self-hosted TURN: tools/turn/run-turn.ps1 (ports UDP 3478, UDP 49152-49200)
- Logs: LOG_DIR or LOG_FILE (defaults to logs/echo-chamber-server.log or %APPDATA%\\@echo\\desktop\\logs)

## Development practices
- Keep network-facing behavior explicit and documented in README
- Prefer small, testable changes; avoid auto-generated diffs in review
- Do not commit secrets (.env is ignored)
- Validate WebRTC flows manually after changes (mic, screen share, join/leave)
