# Control Plane API (Draft)

## Auth
POST /v1/auth/login
- body: { "password": "..." }
- returns: session token (httpOnly cookie or bearer token)

POST /v1/auth/token
- body: { "room": "main", "identity": "sam" }
- returns: LiveKit access token

## Rooms
GET /v1/rooms
POST /v1/rooms
GET /v1/rooms/{roomId}
DELETE /v1/rooms/{roomId}

## Health / Metrics
GET /health
GET /v1/metrics
