# Operations Runbook

This runbook reflects the current Core stack reality (central host/server model).

## Production startup reality

Production boot is owned by the Windows service:

```powershell
Get-Service EchoCoreHost
Get-CimInstance Win32_Service -Filter "Name='EchoCoreHost'" |
  Select-Object Name,State,StartMode,PathName
Get-Content "C:\ProgramData\Echo Chamber\echo-core-host.json" |
  ConvertFrom-Json |
  Select-Object core_root,control_exe,control_env_file,sfu_exe,turn_exe,logs_dir
```

Important gotcha from the v0.6.12 screen-share release: the service executable path can still point at a legacy host binary while the host config controls which control/SFU/TURN children actually run. Do not infer the live control version from the service `PathName` alone. Verify the host config and the service log.

The deploy watcher is separate. It watches/builds/deploys from the clean repo path, but it is not the boot owner for the core stack.

## Echo preflight

Run this before a release claim, after a reboot, or before live troubleshooting:

```powershell
cd F:\EC-worktrees\main
git status -sb
git branch --show-current
git rev-parse --short HEAD
git rev-parse --short origin/main

curl.exe -sk https://echo.fellowshipoftheboatrace.party:9443/api/version
curl.exe -sk https://echo.fellowshipoftheboatrace.party:9443/health

Get-Service EchoCoreHost
Get-Content "C:\ProgramData\Echo Chamber\logs\echo-core-host.log" -Tail 20
```

Expected production state after v0.6.12: `/api/version` reports `0.6.12`, `/health` is OK, and the host log shows `control started ... F:\EC-worktrees\main\core\target\release\echo-core-control.exe`.

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

Script-started development logs are written under `core/logs/`:

- `core/logs/run-core.log`
- `core/logs/core-control.out.log`
- `core/logs/core-control.err.log`
- `core/logs/livekit.out.log`
- `core/logs/livekit.err.log`
- `core/logs/turn.out.log`
- `core/logs/turn.err.log`

Service-started production logs are written under `C:\ProgramData\Echo Chamber\logs\`:

- `echo-core-host.log`
- `core-control.out.log`
- `core-control.err.log`
- `livekit.out.log`
- `livekit.err.log`
- `turn.out.log`
- `turn.err.log`

## Quick incident flow

1. Confirm health endpoint and viewer/admin reachability.
2. Confirm `/api/version`; health alone is not enough.
3. Check `C:\ProgramData\Echo Chamber\logs\echo-core-host.log` first for production service launches.
4. Validate the host config path and child process paths before rebuilding/restarting.
5. If needed, batch restarts; a control-plane restart kicks connected clients.
6. Capture timestamps + action sequence + relevant logs in the issue.

## Live testing discipline

- Tell Sam before closing/reopening his local Echo client.
- For desktop-client validation, close and reopen the client so the tested binary/version is unambiguous.
- Do not reload SAM-PC, restart its client, or change its stream unless Sam explicitly asks.
- Before monitoring, confirm which machine is publishing, which machine is watching, and which version/path is under test.
- Clear duplicate/old sessions before interpreting active-user or stream results.

## Change management

- PRs only (no direct `main`/`master` pushes).
- Keep release impact explicit (server-only vs desktop-binary).
- For behavior changes in state/race-prone paths, include verification evidence.
