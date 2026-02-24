# Architecture

Echo Chamber currently has two practical runtime surfaces:

1. **Control plane + viewer (core stack)**
2. **Desktop client wrapper (Tauri/native packaging + updater hooks)**

The key operational reality: some changes are **server/runtime** only, while others are **packaged desktop** changes. That boundary drives release decisions.

---

## High-level component map

- `core/control` (Rust)
  - Auth, room/session endpoints, state, and service APIs
  - Serves/coordinates viewer-facing behavior
- `core/viewer` (JS/HTML)
  - Client UX (rooms, media controls, jam/audio interactions)
  - Connects to control/media surfaces and renders participant state
- `core/client` (Tauri)
  - Native shell/runtime integration
  - App lifecycle, platform integration, updater IPC
- `tools/*`
  - Operational scripts (deployment, TURN/runtime helpers, utilities)

---

## Runtime boundaries

### Server-side/runtime boundary
Changes here are applied when the server/runtime is deployed/restarted.

Typical examples:
- API behavior
- room/session rules
- server-side bug handling
- runtime config defaults

### Client/UI boundary
Changes in viewer logic affect user behavior and can be regression-prone in transitions/races.

Typical examples:
- room-switch state handling
- jam join/leave/reconnect UX
- publish-state indicator truthfulness

### Desktop binary boundary
Changes in Tauri/native shell or packaged assets generally require publishing new desktop artifacts (EXE/DMG) for installed desktop users.

---

## Design principles for this project

- Prefer conventional, boring patterns over cleverness.
- Treat user-facing state transitions as first-class correctness concerns.
- Keep boundaries explicit so release decisions are predictable.
- Make regressions hard by anchoring behavior in deterministic tests.
