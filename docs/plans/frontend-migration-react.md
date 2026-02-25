# Frontend migration plan: Vanilla JS -> React + TypeScript

## Decision

Adopt React + TypeScript + Tailwind for the viewer/admin frontend migration.

## Supporting libraries

- **XState** for critical workflow state machines (connect/reconnect, room switch, jam lifecycle)
- **Zustand** for local/persisted UI state
- **TanStack Query** for API-backed server state (health, rooms, admin actions)

## Phase breakdown

### Phase 0 (this PR)
- Scaffold `core/viewer-next` with Vite + React + TS + Tailwind
- Add test tooling (Vitest + Playwright)
- Implement initial connection/auth machine + health/rooms queries

### Phase 1
- Port connection/session UI from legacy viewer
- Integrate LiveKit room lifecycle into XState actors
- Add parity smoke checks against legacy behavior

### Phase 2
- Port participant grid + media controls
- Port publish/reconcile logic from existing deterministic modules

### Phase 3
- Port jam subsystem with explicit machine + tests
- Port chat, soundboard, and remaining operator/admin controls

### Phase 4
- Feature-flag rollout
- Flip `/viewer` default to React build after parity + soak validation

## Guardrails

- No big-bang replacement.
- Keep deterministic tests for race-sensitive workflows.
- Maintain current reliability checks while migrating.
