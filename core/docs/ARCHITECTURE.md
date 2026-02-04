# Core Architecture (Draft)

+-----------------------+        +------------------+
|  Native Client (Rust) | <----> |  Control Plane   |
|  Windows / macOS      |  REST  |  Rust (auth/room) |
|  Capture + Encode     |  WS    +------------------+
|  UI + Admin           |
+-----------+-----------+
            |
            | WebRTC
            v
+-----------------------+
|   SFU (LiveKit)       |
|   Media Router        |
+-----------------------+

Notes:
- The Control Plane handles auth, admin, room list, and policies.
- The SFU routes media between peers and applies simulcast/adaptive rules.
- TURN will be provided by the SFU stack or a dedicated TURN service if needed.
