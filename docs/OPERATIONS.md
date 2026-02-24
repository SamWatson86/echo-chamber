# Operations Runbook

This runbook reflects the current Core stack reality (central host/server model).

## Start / stop

From repo root:

```powershell
# Start SFU + control plane + TURN (if binaries exist)
powershell -ExecutionPolicy Bypass -File .\core\run-core.ps1

# Stop all core services
powershell -ExecutionPolicy Bypass -File .\core\stop-core.ps1
```

## Default local URLs

(From `core/control/.env.example` defaults)

- Viewer: `https://127.0.0.1:9443/viewer`
- Admin dashboard: `https://127.0.0.1:9443/admin`
- Health: `https://127.0.0.1:9443/health`

## Process + PID management

The scripts manage PID files and will stop old processes before restart:

- Control plane PID: `core/control/core-control.pid`
- LiveKit PID: `core/sfu/livekit-server.pid`
- TURN PID: `core/turn/echo-turn.pid`

Manual check (PowerShell):

```powershell
Get-Process -Id (Get-Content .\core\control\core-control.pid)
Get-Process -Id (Get-Content .\core\sfu\livekit-server.pid)
Get-Process -Id (Get-Content .\core\turn\echo-turn.pid)
```

## Logs

Core runtime logs are written under `core/logs/`:

- `core/logs/run-core.log`
- `core/logs/core-control.out.log`
- `core/logs/core-control.err.log`
- `core/logs/livekit.out.log`
- `core/logs/livekit.err.log`
- `core/logs/turn.out.log`
- `core/logs/turn.err.log`

## Quick incident flow

1. Confirm health endpoint and viewer/admin reachability.
2. Check `core/logs/core-control.err.log` first.
3. Validate PID files are present and processes are alive.
4. If needed, run `stop-core.ps1` then `run-core.ps1` for clean restart.
5. Capture timestamps + action sequence + relevant logs in the issue.

## Change management

- PRs only (no direct `main`/`master` pushes).
- Keep release impact explicit (server-only vs desktop-binary).
- For behavior changes in state/race-prone paths, include verification evidence.
