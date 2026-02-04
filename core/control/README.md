# Control Plane

The control plane is a Rust service responsible for:
- Authentication (admin + room access)
- Room list / room creation
- Issuing LiveKit access tokens
- Basic health + metrics

## Quick start
1) Copy env example:
   - `.env.example` -> `.env`
2) Set:
   - CORE_ADMIN_PASSWORD (or CORE_ADMIN_PASSWORD_HASH)
   - CORE_ADMIN_JWT_SECRET
   - LK_API_KEY / LK_API_SECRET (must match LiveKit config)
3) Run:
   - `powershell -ExecutionPolicy Bypass -File .\run-control.ps1`

## Planned endpoints (v1)
- GET /health
- POST /v1/auth/login
- POST /v1/auth/token (returns LiveKit JWT)
- GET /v1/rooms
- POST /v1/rooms
- GET /v1/rooms/{roomId}
- DELETE /v1/rooms/{roomId}
- GET /v1/metrics

Notes:
- LiveKit API key/secret are used to sign access tokens.
- Admin auth is separate from room password.
