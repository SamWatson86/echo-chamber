# AGENTS

## Scope
User-facing web client behavior: room switching, media controls, jam flows, and UI state truthfulness.

## Priorities
- Prevent state desync (UI state must reflect actual connection/publication reality).
- Be explicit about optimistic updates and guaranteed rollback paths.
- Treat race-prone transitions (switch/connect/disconnect/reconnect) as first-class concerns.

## Change rules
- For transition logic changes, include deterministic regression coverage when feasible.
- Keep behavior predictable under failure (network errors, transient closes, stale events).
- Prefer small state helpers/modules over scattered implicit state mutations.
