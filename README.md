# Echo Chamber

Self-hosted, password-protected, real-time rooms for microphone and screen sharing.
Friends join from a browser; the host can run the server directly or install the Windows app.

## Echo Chamber Core (full-stack)
The full-stack, native build lives in `core/`. It is under active development and kept separate from the web version.
See `core/README.md` for the Core roadmap and architecture.

## Requirements
- Node.js 20+ (for local dev and server hosting)
- Windows 11 (for the installer)

If PowerShell blocks `npm` scripts, use `npm.cmd` instead (e.g., `npm.cmd install`).

## Quick start (server only)
1) Install dependencies:
   - npm install
2) Create a password hash:
   - npm run hash:password -w @echo/server "yourpassword"
   - Or generate a full .env in one step:
     - npm run setup:env -w @echo/server "yourpassword"
3) Create .env:
   - Copy apps/server/.env.example to .env (repo root) and fill it in
   - Optional: use .env.dev or .env.prod for separate configs
4) Run the server:
   - npm run dev
   - or tools\\run-dev.ps1 / tools\\run-prod.ps1
5) Open the app:
   - http://localhost:5050

Tip: share a room link like `http://HOST:PORT/?room=main` and your friends will auto-fill the room name.

## Docs
- docs/INDEX.md (start here)
- docs/ARCHITECTURE.md
- docs/OPERATIONS.md
- docs/TESTING.md
- docs/RELEASE-BOUNDARIES.md
- docs/TERMINOLOGY.md
- docs/BACKUPS.md
- docs/GITHUB.md
- docs/WORKFLOW.md

## HTTPS for screen sharing
Screen capture in browsers requires a secure context (HTTPS or localhost).
For friends connecting via LAN/WAN, configure TLS:
1) Generate or provide cert/key files (PEM format)
2) Set TLS_CERT_PATH and TLS_KEY_PATH in .env
3) Restart the server; use https://HOST:PORT

You can generate a local dev cert with:
- npm run tls:dev -w @echo/server
This writes to `%APPDATA%\\Echo Chamber\\certs` by default.

## Windows installer
1) Build everything:
   - npm run build
2) Create the Windows installer:
   - npm run pack:win
The installer output will be in apps/desktop/release.

Desktop config file locations:
- %APPDATA%\\@echo\\desktop\\echo-chamber.env
- %APPDATA%\\Echo Chamber\\echo-chamber.env (alternate location)
- (Optional) <install-dir>\\resources\\echo-chamber.env

## Configuration
See apps/server/.env.example for all options.
Example dev/prod env templates:
- .env.dev.example
- .env.prod.example
If you want to provide TURN/STUN servers, set ICE_SERVERS_JSON to a JSON array of RTCIceServer entries.
Use MAX_PEERS_PER_ROOM to cap room size, and SERVER_NAME to change the header title.
Admin controls (optional):
- Set ADMIN_PASSWORD_HASH to enable the admin panel (separate from room password).
- Set ADMIN_TOKEN_TTL_HOURS to control admin session length.
Soundboard (optional):
- SOUNDBOARD_DIR controls where uploaded sound clips are stored (defaults to logs/soundboard).
- SOUNDBOARD_MAX_MB limits per-upload size (default 8 MB).
- SOUNDBOARD_MAX_SOUNDS_PER_ROOM caps how many sounds each room can store (default 60).

## Self-hosted TURN (for WAN/cellular)
For reliable media outside your LAN (cellular, strict NATs), run the bundled TURN server:
1) Start TURN (requires Go installed):
   - powershell -ExecutionPolicy Bypass -File tools/turn/run-turn.ps1
2) Set ICE_SERVERS_JSON (example):
   - [{"urls":["stun:YOUR_PUBLIC_IP:3478","turn:YOUR_PUBLIC_IP:3478?transport=udp"],"username":"echo","credential":"<TURN_PASS>"}]
3) Port forward to the TURN host:
   - UDP 3478
   - UDP 49152-49200 (relay range)
4) Optional auto-start at login:
   - powershell -ExecutionPolicy Bypass -File tools/turn/install-turn-task.ps1
   - If you don't have admin rights, use:
     - powershell -ExecutionPolicy Bypass -File tools/turn/install-turn-startup.ps1

TURN logs go to `%APPDATA%\\@echo\\desktop\\logs\\echo-turn.log` by default.

## Logs
Server logs (JSON lines) default to:
- repo dev server: `logs/echo-chamber-server.log`
- desktop app server: `%APPDATA%\\@echo\\desktop\\logs\\echo-chamber-server.log`
The desktop app writes its own log to:
- `%APPDATA%\\@echo\\desktop\\logs\\echo-chamber-app.log`
You can override with `LOG_DIR` or `LOG_FILE`.

## Troubleshooting
- If the app launches and immediately closes or shows `ERR_PACKAGE_PATH_NOT_EXPORTED`, make sure `ELECTRON_RUN_AS_NODE` is not set in your environment (remove it and restart the app).
- If the tray starts but the server doesn't listen on the port, check `%APPDATA%\\@echo\\desktop\\logs\\echo-tray.log`.

## Notes
- For NAT traversal outside your LAN, you will likely need a TURN server.
- This project uses a simple peer-to-peer mesh; keep rooms small.
