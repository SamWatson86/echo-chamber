# Core Decisions

## 2026-02-04
- SFU: LiveKit server (proven, supports simulcast and adaptive downlink).
- Control plane: Rust service for auth, room metadata, admin.
- Client: Native desktop app in Rust (Windows + macOS).
- Host: SFU runs on the host PC (gigabit uplink available).
- Rooms: Default room = "main". Additional rooms supported via control plane.

Notes:
- We will keep Echo Chamber Web unchanged while Core is built.
- TURN is required for NAT traversal; final approach will be documented in core/docs/ARCHITECTURE.md.
