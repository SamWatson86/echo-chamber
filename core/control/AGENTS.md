# AGENTS

## Scope
Rust control plane (`axum`) for auth, room/session APIs, viewer serving, and update endpoints.

## Priorities
- Preserve API contract stability.
- Fail safely (no panics on malformed user input).
- Treat path/file handling and auth boundaries as high-risk surfaces.

## Change rules
- If endpoint behavior changes, document expected request/response and error semantics.
- Keep compatibility with viewer/client expectations unless intentionally versioning behavior.
- Add targeted tests for parser/validation/security-sensitive logic where possible.
