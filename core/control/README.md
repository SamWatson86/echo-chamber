# Control Plane

The control plane is a Rust service responsible for:
- Authentication (admin + room access)
- Room list / room creation
- Issuing LiveKit access tokens
- Basic health + metrics

## Quick start
1) Set env vars:
   - CORE_ADMIN_PASSWORD (or CORE_ADMIN_PASSWORD_HASH)
   - CORE_ADMIN_JWT_SECRET
   - LK_API_KEY / LK_API_SECRET
2) Run:
   - cargo run -p echo-core-control

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
