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

## Spotify Jam source

Jam audio comes from one explicitly provisioned Echo desktop client, not from
the Windows service. The source client and `Spotify.exe` must stay open in the
same interactive Windows session. Echo's Spotify OAuth connection must use the
same Premium account signed into that Spotify desktop app.

Configure the control environment with a unique source ID, a long random source
token, and an exact unique Spotify Connect device name. The name is the stable
choice for long-lived configuration because Spotify device IDs can rotate. Use
an ID only if names are ambiguous, and expect to update it if Spotify replaces
that ID:

```dotenv
SPOTIFY_CLIENT_ID=YOUR-SPOTIFY-APP-CLIENT-ID
JAM_SOURCE_ID=spotify-host
JAM_SOURCE_TOKEN=GENERATE-A-LONG-RANDOM-SECRET
SPOTIFY_DEVICE_NAME=YOUR-EXACT-SPOTIFY-DESKTOP-NAME
```

Put the matching source ID/token in `config.json` beside the source machine's
Echo executable, as documented in `core/client/README.md`. Do not copy those
credentials to listener clients. Set its `server` URL to the normal Echo
hostname that matches a Windows-trusted TLS certificate; a raw IP or
`127.0.0.1` will not work with a certificate issued only for the public
hostname. After starting Spotify and Echo, `/api/jam/state`
should report protocol 2 and source status `ready` while the source is idle.
Once the Jam is active, source status should be `ready` while Spotify is paused
or warming up and `live` while audible playback is flowing.

Echo exposes one global shared Jam at a time. Any authenticated Echo user can
start it, join it, search, add songs, and skip from Echo's Jam panel. Those users
do not need Spotify accounts and should add their songs through Echo, not through
their own Spotify apps. Spotify playback is always targeted back to the one
configured desktop device and Premium host account. Echo does
not offer a fake queue-removal control because Spotify's API cannot remove an
individual queued item. When the source-host user starts or joins a Jam from
that same Echo desktop client, Echo automatically sets its local Jam relay to
0% so the PC does not play Spotify directly and then play the delayed relay on
top of it. The user can still change the Jam volume slider explicitly.

Listener audio uses `/api/jam/audio?jam_protocol_version=2&generation=...`.
Credentials are not placed in that URL: the listener's first WebSocket frame is
an auth message containing its bound LiveKit token, and the server replies
`{"type":"ready"}` only after validating its identity and current Jam membership.

The LAN `push-build.ps1` helper does not push `config.json` by default. Before
its first explicit `-PushConfig` use on a source host, rerun `setup-agent.ps1`
on that PC so the agent installs its merge helper and advertises
`preserve-jam-source-v1`. The push script refuses older agents; the current
agent preserves an installed `jam_source` block when a generic server config
omits it. Normal NSIS updates also leave the untracked install-directory
`config.json` in place.

## Atomic viewer runtime deployment

Production serves viewer files from `ECHO_CORE_VIEWER_DIR`, currently
`F:\EC-runtime\echo-viewer`, rather than directly from `core/viewer`. Never copy
an individual viewer file into that directory. A single-file hotfix can pair a
new Jam/UI contract with an old helper or control binary and still receive a
fresh cache stamp, which makes the mixed bundle look current.

Use the full-snapshot publisher during an approved control-service outage:

```powershell
# From a clean, up-to-date main checkout, verify code first.
npm run verify:quick
powershell -NoProfile -ExecutionPolicy Bypass -File .\core\deploy\test-viewer-runtime-lib.ps1

# Stop EchoCoreHost/control before the swap. Deploy the matching control binary
# in the same outage, then publish every viewer asset as one verified snapshot.
Stop-Service EchoCoreHost
powershell -NoProfile -ExecutionPolicy Bypass -File .\core\deploy\publish-viewer-runtime.ps1 `
  -RuntimeDirectory "F:\EC-runtime\echo-viewer"
Start-Service EchoCoreHost

# The verifier normalizes only control's expected index.html cache stamps.
powershell -NoProfile -ExecutionPolicy Bypass -File .\core\deploy\publish-viewer-runtime.ps1 `
  -RuntimeDirectory "F:\EC-runtime\echo-viewer" `
  -VerifyOnly
```

The publisher stages and hashes the complete directory before swapping it into
the configured path, refuses to run while `echo-core-control` is active, and
retains the prior directory as a timestamped rollback backup. Treat the viewer
snapshot and control executable as one release unit whenever their API contract
changes. Before it polls or pulls, the deploy watcher fails closed unless
`ECHO_CORE_VIEWER_DIR` is set to a dedicated runtime outside the git checkout,
with neither source nor runtime nested inside the other. Serving the checkout
directly cannot provide a transactional viewer/control rollback.

First-rollout trap: a deploy-watcher process loads its PowerShell functions into
memory when it starts. An older watcher that pulls this atomic-deployment change
will continue that one deployment with its old, non-atomic functions. Before the
first rollout containing this change, stop the old watcher, update the clean
checkout, and start a fresh watcher process so it loads the new functions; or use
the manual full-snapshot outage procedure above. Do not let the already-running
old watcher perform that first release. Subsequent watcher processes publish and
roll back the control binary and full viewer snapshot as one unit.

For Jam v2, an authenticated `/api/jam/state` response must report
`jam_protocol_version: 2`; verify `source_status` is `ready` before Start and
`live` while audible playback is expected before declaring the full Jam audio
path operational. `silent` is a short playback/capture warmup state; `stalled`
means Echo expected audible playback but did not receive it.

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
