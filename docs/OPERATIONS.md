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

### Production network reachability invariant

Production must run with `CORE_BIND=0.0.0.0` and `CORE_PORT=9443`. Treat both
values as release invariants, verify them in the active `control_env_file`, and
confirm the listener is on `0.0.0.0:9443` after every promotion or rollback.
The host config must be a top-level JSON object and `control_env_file` must be a
case-sensitive JSON string containing a fully qualified Windows drive-rooted
path; arrays, scalar roots, relative, drive-relative, root-relative, and UNC
paths fail closed.
`CORE_BIND=127.0.0.1` is valid only for an isolated candidate or local test. A
candidate loopback bind must never be copied into the production environment.
Do not promote a candidate environment wholesale; preserve and independently
verify the production network values.

The server's Windows `hosts` file overrides public DNS resolution. When it maps
the public Echo hostname to loopback, a public-hostname `curl` run on the server
is a local-only service check, not proof that LAN or internet clients can
connect. Hairpin NAT is also not external-path proof. A production network
change is complete only after all three independent checks pass:

1. **Loopback (server):** verify `/health` and `/api/version` through
   `https://127.0.0.1:9443` and confirm the port listener is bound to
   `0.0.0.0:9443`, not `127.0.0.1:9443`.
2. **LAN (another device):** connect to the server's LAN address on port 9443
   from a different machine on the local network. A request made by the server
   to its own LAN address does not satisfy this check.
3. **External (off-LAN):** connect to the public Echo hostname from a genuine
   internet path, such as a friend's connection or a phone with Wi-Fi disabled.
   The server itself and another device using the same LAN do not satisfy this
   check.

The committed `echo-core-host-network-guard.ps1` wrapper is mandatory for every
manual production service start or restart. It reads the canonical host JSON,
resolves and validates its `control_env_file` before the service mutation, then
uses bounded retries to require one running `EchoCoreHost`, exactly one direct
`echo-core-control.exe` child, that child's `0.0.0.0:9443` listener, and a TCP
probe through the server's default-route LAN address. Do not call
`Start-Service EchoCoreHost` or `Restart-Service EchoCoreHost` directly.
`Start` requires the service to be stopped first. `Restart` must replace the
service or direct-control PID. A hard post-mutation failure stops the
partial-live service; an ancillary LAN-route/probe failure leaves a healthy,
loopback-responsive, wildcard-bound service running but still fails the release
gate for explicit LAN/WAN verification. A no-op `Restart` also fails the release
gate, but preserves the old process only after health, wildcard ownership, and
LAN ingress have all passed. If the Windows service mutation itself throws, the
wrapper preserves only the exact unchanged service/control PIDs after rechecking
the canonical config, loopback health, and wildcard ownership; changed, partial,
or unsafe post-error state is stopped.

Run the read-only verification after a reboot and before a release or rollback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Verify
curl.exe -sk https://127.0.0.1:9443/health
curl.exe -sk https://127.0.0.1:9443/api/version
```

For a controlled promotion that requires an outage, run `Preflight` immediately
before the stop. After the reviewed artifact/config swap, use the wrapper to
start and verify production as one operation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Preflight
Stop-Service EchoCoreHost
# Perform the reviewed, backed-up release mutation while Echo is stopped.
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Start
```

For a routine restart, use `-Action Restart`; it validates before mutation and
verifies the new service/control PIDs and ingress afterward. These server-side
assertions prove the process is not localhost-only, but they do not replace the
separate-device LAN check or a genuine off-LAN check. Obtain both before the
release is declared live.

## Echo preflight

Run this before a release claim, after a reboot, or before live troubleshooting:

```powershell
cd F:\EC-worktrees\main
git status -sb
git branch --show-current
git rev-parse --short HEAD
git rev-parse --short origin/main
npm run verify:production-network:windows

$activeHost = Get-Content "C:\ProgramData\Echo Chamber\echo-core-host.json" -Raw |
  ConvertFrom-Json
curl.exe -sk https://127.0.0.1:9443/api/version
curl.exe -sk https://127.0.0.1:9443/health
Get-Service EchoCoreHost
Get-Content (Join-Path $activeHost.logs_dir "echo-core-host.log") -Tail 20
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Verify
```

Expected production state: `/api/version` reports the reviewed release version
and Git SHA, `/health` is OK, and the host log's control path exactly matches
the immutable `control_exe` path in the active host JSON. Do not use a stale
hard-coded version or checkout path as release evidence.

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
the Windows service. The source client and the Microsoft Store build of
`Spotify.exe` must stay open in the same interactive Windows session. Echo's
Spotify OAuth connection must use the same Premium account signed into that
Spotify desktop app. VB-CABLE must expose the exact playback endpoint
`CABLE Input (VB-Audio Virtual Cable)`.

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
should report protocol 3, `source_availability_known: true`,
`source_enabled: true`, and source status `ready` while the source is idle.
Once the Jam is active, source status should be `ready` while Spotify is paused
or warming up and `live` while audible playback is flowing.

Echo exposes one global shared Jam at a time. Any authenticated Echo user can
start it, join it, search, add songs, skip, and use **Stop Music** from Echo's Jam panel. Those users
do not need Spotify accounts and should add their songs through Echo, not through
their own Spotify apps. Spotify playback is always targeted back to the one
configured desktop device and Premium host account. Echo does
not offer a fake removal control for entries already handed to Spotify because
Spotify's API cannot delete an individual queued item. Echo keeps later entries
pending behind a bounded Spotify frontier; any current Jam participant may
remove one or many pending occurrences, while committed or ambiguous entries
remain locked and the current track may be skipped. The configured source PC
has local-only **Allow Echo Jam to use Spotify on this PC** and **Hear Jam on
this PC** switches before Echo login and in the Jam panel. Hear Jam uses the
independent Jam Volume without changing anyone else's level. Stop Music pauses
playback for everyone and prevents automatic frontier promotion, but preserves
the active Jam, pending queue, listeners, capture route, and audio sockets. An
explicit later queue add resumes playback as before. Skip while stopped may
advance Spotify's paused selection, but it does not resume audio or promote a
new pending frontier entry. A timeout or source-safety loss during a Spotify
mutation also marks that Jam generation stopped after Echo's best-effort device
pause, preventing a later state poll from silently resuming or replacing the
uncertain occurrence. Successful Skip retires the exactly observed Echo front
and refills the bounded Spotify frontier before another Skip can run. A
committed front observed stopped at its natural end (or followed by Spotify's
no-content state after enough elapsed play time) is retired, so a later explicit
add starts or resumes instead of being stranded behind a stale occurrence. That
add-time retirement requires either an exact stopped-at-duration observation or
a prior playing trajectory that corroborates the no-content transition; a
legitimately paused near-end track is preserved and an explicit add resumes it
before queueing the new track. Skip unlocks exactly the first queued-next
accepted successor occurrence. An ambiguous successor remains non-removable,
unmatched, and locked until the Jam ends. Playback URI/progress alone never
promotes `commit_unknown`, and new track/playlist adds return
`queue_commit_unknown` with instructions to end and restart the Jam; pending
tail removal remains available.

Skip performs a fresh bound-device preflight. If adjacent same-URI occurrences
are ambiguous, Echo also requires Spotify's current/next queue observation
before calling `/next`. A transport error, timeout, or Spotify 5xx after that
mutation is treated as an unknown Skip result: Echo best-effort pauses the
device, exposes `skip_reconciliation_pending`, and blocks another Skip, queue
add, or playback resume. A later bound-device player/queue observation resolves
accepted versus rejected exactly once. Spotify player `204 No Content` is not
acceptance proof and leaves the fence in place; ending the Jam clears it.
Skip also fails before `/next` whenever its authoritative current candidate is
`commit_unknown`, regardless of whether Spotify reports a different next item,
no next item, or Echo last observed a different predecessor. This prevents an
external same-URI occurrence from inheriting Echo queue or Play History
provenance.

The shared Echo Favorites layer and 30-day Play History are defined in
`docs/JAM-LIBRARY-HISTORY.md`. Playlists are always expanded server-side into
ordinary track queue entries; the queue and source protocol never contain a
playlist object. Favorite removal never removes queued Spotify items. History
records only Echo queue entries that Spotify is subsequently observed playing,
with consecutive repeats collapsed until a different track plays.

Restricted public playlists are cataloged only after a participant opens or
queues them, in fixed 50-position requests. The normalized, snapshot-keyed
cache is private at `session-logs/jam-library/playlist-items-cache-v2.json` and
uses the same atomic primary/backup recovery model as Echo Favorites. Do not
place that file under the viewer/admin/static roots. It contains track metadata,
not Spotify credentials; the anonymous public-catalog token remains memory-only.
Echo stops restricted public-catalog paging at 1,000 positions, disables bulk
queueing for a larger playlist, and keeps selection available for the cached
first 1,000. All public and supported Spotify requests share the same in-process
429 cooldown. The 50-position boundary is an operational guardrail, not a
policy-compliance guarantee.

Listener audio uses `/api/jam/audio?jam_protocol_version=3&generation=...`.
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
npm run verify:production-network:windows

# Stop EchoCoreHost/control before the swap. Deploy the matching control binary
# in the same outage, then publish every viewer asset as one verified snapshot.
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Preflight
Stop-Service EchoCoreHost
powershell -NoProfile -ExecutionPolicy Bypass -File .\core\deploy\publish-viewer-runtime.ps1 `
  -RuntimeDirectory "F:\EC-runtime\echo-viewer"
powershell -NoProfile -ExecutionPolicy Bypass -File `
  .\core\deploy\echo-core-host-network-guard.ps1 -Action Start

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

Jam v3 is a coordinated control-plane/viewer and Windows source-desktop release.
Do not deploy the server side while the configured source PC still runs a v2
desktop binary: the v3 server deliberately rejects that source. After both
sides are updated, an authenticated `/api/jam/state` response must report
`jam_protocol_version: 3`, `source_availability_known: true`, and
`source_enabled: true`; verify `source_status` is `ready` before Start and
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

## Durable Dashboard History

Dashboard session history is durable application data, not a release artifact.
Production `CORE_SESSION_LOG_DIR` must point at the stable data root
`C:\ProgramData\Echo Chamber\data\sessions`. The data root must disable inherited
permissions and grant access only to `SYSTEM`, local Administrators, and the
designated Echo operator; never place `spotify-token.json` or the Jam actor key
under a broadly readable runtime directory. A release candidate may use an isolated
session directory while it is being tested, but promoting that candidate must
not leave production pointed at the candidate directory. Doing so makes the
Dashboard appear to lose its history even though the earlier daily JSON files
still exist.

The session files are UTC-day arrays named exactly
`sessions-YYYY-MM-DD.json`. `stats-YYYY-MM-DD.json`, `jam-history/`, and
`jam-library/` share the parent directory but are separate stores. Never merge
those through the session-history tool.

Use the merge utility to preview and recover split session stores. Preview is
the default and does not write anything:

```powershell
& .\core\deploy\merge-session-history.ps1 `
  -SourceDirectory @(
    "F:\Codex AI\The Echo Chamber\core\logs\sessions",
    "C:\ProgramData\Echo Chamber\private-web-diagnostics\candidates\<candidate>\data\sessions"
  ) `
  -DestinationDirectory "C:\ProgramData\Echo Chamber\data\sessions"
```

Review the JSON summary, especially `unique_source_events_added`,
`exact_duplicates`, `filename_date_mismatches`, and every entry under
`changes`. Do not add worktree-local, `core\control\logs`, or discarded test
candidate directories merely because they contain session-shaped files; those
are developer/test records unless an incident audit proves otherwise.

For an approved recovery outage:

1. Run the Echo preflight and record the active `control_env_file` and its
   `CORE_SESSION_LOG_DIR`.
2. Run the service guard's `Preflight` action immediately before stopping
   `EchoCoreHost`; the utility deliberately never stops or starts the service
   and must not race the control plane's read-modify-write logger.
3. Rerun the reviewed command with `-Apply` and, preferably, an explicit new
   `-BackupDirectory`. The tool snapshots and hashes every existing destination
   session file before any destination write, deduplicates exact events, routes
   them by UTC date, and replaces each changed file atomically.
4. Set the production environment's `CORE_SESSION_LOG_DIR` to the restricted,
   stable data root as a separate, reviewed configuration change. The merge tool
   never mutates service configuration. Keep private web diagnostics at its own
   stable restricted root so its existing identity key is never replaced by a
   release candidate's key.
5. Start `EchoCoreHost` through the service guard's `Start` action, confirm the
   control log reports the stable session directory, then verify `/api/version`,
   `/health`, Dashboard History, another-device LAN access, and genuine off-LAN
   access.

Candidate promotion can fork more than Dashboard History. Audit every mutable
path in the candidate environment, including `CORE_SOUNDBOARD_DIR`,
`CORE_CHAT_DIR`, `CORE_CHAT_UPLOADS_DIR`, `CORE_SESSION_LOG_DIR`, and
`CORE_DIAGNOSTICS_DIR`, before switching production. Candidate-owned
`jam-history/`, `jam-library/`, playlist caches, and the newest Spotify token
also require their own feature-aware, backed-up migration during the controlled
stop. The session-history utility intentionally does not copy or merge any of
that state.

Rollback is mechanical, but restoring the original files alone is incomplete
when the merge created new UTC-day files. Stop the service and first verify that
`manifest.json`'s `destination` is the exact intended session directory. For
each entry in `created_paths`, require a plain leaf name matching exactly
`sessions-YYYY-MM-DD.json`, verify it resolves directly under that destination,
and remove only that exact file. Never use a glob or recursive deletion for this
step. Then hash-verify every backup named in `destination_files`, restore it to
the destination (prefer a same-directory staged atomic replacement), and verify
the restored SHA-256 values plus the absence of every `created_paths` entry.
Restore the prior environment file if it changed, then use the service guard's
`Start` action to start and verify the service. Source files are read-only and
remain untouched throughout recovery.

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
