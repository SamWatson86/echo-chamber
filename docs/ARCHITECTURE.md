# Architecture

Echo Chamber is a self-hosted WebRTC app for mic + screen sharing.
It uses a simple peer-to-peer mesh: each participant connects to every other participant.

## Components
- apps/server
  - Express server for API + static web UI
  - WebSocket signaling server (rooms, peers, SDP/candidates)
- apps/server/public
  - Web UI (login, lobby, rooms, screen grid, camera lobby, soundboard)
- apps/desktop
  - Electron wrapper that starts the server locally and opens the UI
- tools/turn
  - Optional self-hosted TURN server (UDP) for WAN/cellular reliability

## Media flow
- Each peer publishes:
  - mic audio
  - optional screen video + screen audio
  - optional camera video
- Track roles are tagged via "track-meta" messages to keep camera/screen distinct.
- Each client renders:
  - Screens grid (screen video only)
  - Camera lobby (camera video only)
  - Active users bar (avatar or camera mini)
- Audio playback:
  - Mic + screen audio are mixed into a single output using WebAudio.
  - Per-peer volume and mute controls adjust gain nodes.

## Limits
- P2P mesh scales poorly. Keep rooms small (default MAX_PEERS_PER_ROOM=8).
- Browser WebRTC controls final quality. "Max" settings are only targets.

