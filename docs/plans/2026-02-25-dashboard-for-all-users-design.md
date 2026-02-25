# Dashboard for All Users — Design

**Date**: 2026-02-25
**Status**: Approved

## Goal

Make the admin dashboard visible to all connected users (Sam's friends) in the regular Tauri client, without requiring admin credentials. Admin-only actions (kick/mute) stay restricted.

## Current State

- Admin dashboard exists in two forms:
  1. Standalone browser page at `/admin` (password login)
  2. In-app panel in the Tauri client, gated behind `__ECHO_ADMIN__` flag (admin-client build only)
- All `/admin/api/*` endpoints require admin JWT via `ensure_admin()`
- Regular Tauri client hides all `admin-only` CSS class elements
- Friends currently have zero visibility into dashboard data

## Design

### New Viewer-Level API Endpoints (Rust)

Create `/v1/dashboard/*` endpoints that mirror `/admin/api/*` but use participant auth:

| New Endpoint | Mirrors | Auth |
|---|---|---|
| `GET /v1/dashboard/live` | `/admin/api/dashboard` | Participant JWT |
| `GET /v1/dashboard/sessions` | `/admin/api/sessions` | Participant JWT |
| `GET /v1/dashboard/metrics` | `/admin/api/metrics` | Participant JWT |
| `GET /v1/dashboard/bugs` | `/admin/api/bugs` | Participant JWT |
| `GET /v1/dashboard/deploys` | `/admin/api/deploys` | Participant JWT |
| `POST /v1/dashboard/stats` | `/admin/api/stats` | Participant JWT |

Implementation: Each new handler calls the same internal logic as the admin handler, but uses `ensure_participant()` for auth instead of `ensure_admin()`.

### Participant Auth (Rust)

Add `ensure_participant()` function — validates that the request has a valid LiveKit-compatible JWT token (the same token every connected user already has from the `/v1/token` endpoint). This proves the caller is a connected user without requiring admin credentials.

### Client-Side Changes (app.js)

1. Remove `isAdminMode()` gate on the dashboard panel — show to all users
2. Dashboard API calls use `/v1/dashboard/*` endpoints (participant JWT, no admin token needed)
3. Kick/mute buttons remain gated behind `isAdminMode()` (admin-client only)
4. Dashboard button visible in the main toolbar for all users

### What Does NOT Change

- Admin kick/mute requires admin JWT (no change)
- Standalone `/admin` browser page (no change)
- `/admin/api/*` endpoints (no change)
- Tauri client binary (no rebuild — viewer loads from server)

## Security

- Read-only data exposure to authenticated participants only
- No admin actions exposed
- Server is private (friends-only) — no public access concern
- Participant JWT already validated by LiveKit token format
