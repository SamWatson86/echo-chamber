# Control Plane

The control plane is a Rust service responsible for:
- Authentication (admin + room access)
- Room list / room creation
- Issuing LiveKit access tokens
- Basic health + metrics

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
- LiveKit API key/secret will be stored in env and used to sign access tokens.
- Admin auth is separate from room password.
