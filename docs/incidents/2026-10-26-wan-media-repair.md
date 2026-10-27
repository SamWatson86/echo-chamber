# October 26, 2026: stale WAN addresses prevented remote media

## ELI5

- What broke: remote Echo room joins failed after signaling connected.
- Why it broke: the ISP changed the public IPv4, while LiveKit and TURN still
  advertised the previous address. Corrected public DNS did not reload media.
- What changed: three active runtime address values were corrected, with
  verified backups and an announced, guarded service restart.
- How we know it works: production network tests, service ownership, wildcard
  listener, health/version endpoints, and fresh media startup logs passed.
  Separate-device LAN and off-LAN audio verification remain pending.
- Does this need a desktop update: no; server runtime configuration only.
- What could still go wrong: port forwarding or endpoint media problems could
  remain; another WAN change can cause the same drift.

## Applied repair

At 23:35 EDT on October 26, WAN discovery and public A-record queries through
1.1.1.1 agreed on `104.54.75.107` for both Echo and home hostnames. The active
files still contained `69.209.119.49` and matched the handover's SHA-256 values.
The canonical host JSON contained no occurrences of the old address.

The host JSON selected the immutable control release
`C:\ProgramData\Echo Chamber\runtime\releases\echo-0.6.39-a3ec9564de5e-jam`,
but selected LiveKit configuration from the older checkout. Only these values
were changed:

| Active file | Setting | New value |
| --- | --- | --- |
| `F:\Codex AI\The Echo Chamber\core\sfu\livekit.yaml` | `rtc.ips.includes` | `104.54.75.107/32` |
| Same YAML | `rtc.turn_servers[0].host` | `104.54.75.107` |
| `C:\ProgramData\Echo Chamber\private-web-diagnostics\control.env` | `TURN_PUBLIC_IP` | `104.54.75.107` |

Credentials, LAN node address, ports, control bind, executables, and viewer
snapshot were preserved. No viewer or Windows binary release was required.
The runtime files are ignored local configuration; the Git change records
the incident and adds the recovery procedure to the operations runbook.

Hash-verified backups:

- `F:\Codex AI\The Echo Chamber\core\sfu\livekit.yaml.pre-wan-repair-20261026-233523-157.bak`
- `C:\ProgramData\Echo Chamber\private-web-diagnostics\control.env.pre-wan-repair-20261026-233523-157.bak`

The reviewed elevated helper transcript is at
`F:\Codex AI\General Help\echo-network-repair\repair.log`.

## Verification evidence

- `test-production-network.ps1` passed before the mutation.
- Guard `Preflight -AnnounceRestart` passed before the controlled stop;
  guard `Start` and a subsequent read-only `Verify` passed afterward.
- Service PID changed from `57548` to `135572`; its direct control child
  changed from `56448` to `47768`, owning `0.0.0.0:9443`.
- `/health` returned `ok: true`; `/api/version` still reported version
  `0.6.39`, Git SHA `a3ec9564de5e`, latest client `0.6.39`.
- Fresh TURN startup at 23:35:38 reported public IP `104.54.75.107`.
- Fresh LiveKit STUN discovery at 23:35:39 reported `104.54.75.107` and
  startup at 23:35:41 used that node IP, TCP 7881 and UDP 40000-40099.
- The two active files now contain zero occurrences of the previous address
  and respectively two and one occurrences of the current address.

The guard's server-to-own-LAN probe is only local evidence. Another-device
LAN verification and a fresh cellular room join with audio are pending Sam's
confirmation. Startup STUN discovery alone does not prove a remote participant
completed ICE. No remote client was reloaded and SAM-PC was not accessed.

For rollback, use the operations runbook's tested, announced preflight/stop/
guarded-start procedure and these exact backups. Restoring the previous
addresses would restore the known media failure while the WAN remains at the
new address; investigate a new failure before reverting blindly.
