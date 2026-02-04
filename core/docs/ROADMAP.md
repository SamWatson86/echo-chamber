# Core Roadmap

Phase 0 - Scaffolding
- Create core workspace and docs (this step).

Phase 1 - SFU bring-up
- Stand up LiveKit locally with config + basic health checks.
- Verify basic room creation and connection.

Phase 2 - Control Plane (Rust)
- Auth endpoints (admin + room access).
- Room list + room create API.
- Metrics endpoint (room count, peers).

Phase 3 - Native Client (Rust)
- Window shell + login flow.
- Connect to SFU with test camera stream.

Phase 4 - Screen Share + Audio
- Native capture pipeline for screen + audio.
- Quality selection and encoder control.

Phase 5 - UX + Admin
- Room list, active room switching, diagnostics.
