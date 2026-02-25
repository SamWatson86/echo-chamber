# Echo Chamber Core

Echo Chamber Core is the full-stack, native version of Echo Chamber. It is designed for reliable 1080p/60 screen sharing and high-quality audio with an on-prem SFU (Selective Forwarding Unit).

This is separate from the existing web build (Echo Chamber Web). Do not mix files between the two.

## Components
- sfu: Media routing (LiveKit server). Runs on the host PC.
- control: Rust control plane (auth, rooms, admin).
- viewer: Current production web viewer (vanilla JS).
- viewer-next: In-progress React + TypeScript refactor foundation.
- client: Native desktop app (Windows + macOS).

## Target
- Up to 10 participants per room.
- 1080p60 for screen share where bandwidth allows.

## Quick start (local dev)
1) Run Core stack:
   - `powershell -ExecutionPolicy Bypass -File .\run-core.ps1`
2) Health check:
   - `http://127.0.0.1:9090/health`
3) Viewer (web):
   - `http://127.0.0.1:9090/viewer`

## Logs
- Control plane:
  - `core/logs/core-control.out.log`
  - `core/logs/core-control.err.log`
- SFU (Docker):
  - `docker compose logs --tail 200` (run in `core/sfu`)

## Status
Scaffolding + SFU + control plane are in place. Native client publishes test audio/video
to validate the full media pipeline (synthetic frames + tone). A web viewer is included
to subscribe to test streams.

## Notes
- The web app remains the primary working product while Core is built.
- All Core decisions are documented in core/docs.
