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
- Durable diagnostics are disabled by default. Enabling them requires a unique
  `CORE_DIAGNOSTICS_OWNER_SECRET` of at least 32 random bytes. That owner
  boundary never falls back to the ordinary room/admin token; only a current,
  heartbeating participant can submit an incident, and only the separately
  authenticated owner can browse or delete stored incidents.

## Private diagnostics endpoints

- `POST /v1/auth/diagnostics/login` - exchange the configured owner secret for
  a one-hour diagnostics-only bearer token.
- `POST /api/diagnostics/v1/envelopes` - submit a strict, redacted incident
  envelope with a current heartbeating participant token (256 KiB maximum).
- `GET /admin/api/diagnostics` - list bounded incident summaries with the
  diagnostics owner token; pagination cursors pair `before_received_at_ms` with
  `before_incident_id`.
- `GET /admin/api/diagnostics/{incidentId}` - read one redacted incident.
- `GET /admin/api/diagnostics/{incidentId}/download` - download stable redacted
  JSON; raw JSONL storage is never served.
- `DELETE /admin/api/diagnostics/{incidentId}` - atomically remove one incident.

Detailed records rotate daily, default to 14-day retention, and are constrained
by `CORE_DIAGNOSTICS_MAX_MB`. Owner responses are marked `Cache-Control:
no-store`. The diagnostics directory must be disjoint from every web-readable
root, and served roots cannot contain filesystem links/junctions while private
diagnostics are enabled. Removing the owner secret closes collection and owner
access while an existing store continues to be pruned. Free-form messages and
client fingerprints are discarded before persistence.
