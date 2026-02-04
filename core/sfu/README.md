# LiveKit SFU

This folder contains the configuration and scripts for running the LiveKit SFU locally.

## Quick start (Windows native)
1) Install LiveKit server (from the official LiveKit releases).
2) Copy config:
   - `livekit.yaml.example` -> `livekit.yaml`
3) Ensure Redis is running (local or Docker on port 6379).
3) Run:
   - `powershell -ExecutionPolicy Bypass -File .\run-livekit.ps1`

Tip: start Redis quickly with:
- `powershell -ExecutionPolicy Bypass -File .\run-redis.ps1`

The server will listen on:
- TCP 7880 (signal)
- TCP 7881 (RTC/TCP fallback)
- UDP 55000-55100 (media, local dev range)

## Docker (optional)
A docker-compose file is included, but Windows networking can be limiting for large UDP ranges.
If Docker works for you, use:
- `docker compose up` (from this folder)
The compose setup uses:
- `livekit.docker.yaml` (copy from `livekit.docker.yaml.example`)

## Notes
- For WAN access, you must port-forward the UDP range and TCP 7880/7881.
- Increase the UDP range for production (we will expand once validated).
- TURN can be enabled later once we stabilize the baseline.
