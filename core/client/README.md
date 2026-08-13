# Echo Chamber Core Client

This is the native Windows client. See `core/docs/CLIENT.md` for the media and
capture architecture.

## Provisioning the Spotify Jam source

Exactly one client should be provisioned as the Spotify Jam source. It must be
the Echo client on the host PC where the Spotify desktop app runs. Echo and
Spotify must remain open in the same signed-in, interactive Windows session.
Echo's Spotify OAuth connection must authorize the same Premium account that is
signed into that desktop app; a different controlling account cannot see or
target the host app's Spotify Connect device.

The source PC also needs:

- the current Echo Desktop Windows binary;
- the Microsoft Store build of Spotify Desktop, signed in and visible as the
  server's exact bound Spotify Connect device;
- VB-CABLE installed with the playback endpoint named exactly
  `CABLE Input (VB-Audio Virtual Cable)`; and
- a trusted HTTPS connection to the current Echo control-plane server.

Create `config.json` beside the Echo client executable:

```json
{
  "server": "https://your-echo-server.example:9443",
  "jam_source": {
    "id": "spotify-host",
    "token": "GENERATE-A-LONG-RANDOM-SECRET"
  }
}
```

The values must exactly match `JAM_SOURCE_ID` and `JAM_SOURCE_TOKEN` on the
control-plane server. Do not put `jam_source` credentials on ordinary listener
clients, commit the token, or reuse the admin password. Restart the client after
changing `config.json`.

The `server` URL is also the Jam source's secure WebSocket destination. Use the
normal Echo hostname whose TLS certificate matches that hostname and is trusted
by Windows. Do not substitute a raw IP address or `127.0.0.1` unless the
certificate is valid and trusted for that exact address.

## Source-PC controls and routing

On the configured source PC, Echo shows a **Spotify Jam on this PC** card on the
login portal before Echo Connect and again inside the Jam panel. The two copies
control the same native settings:

- **Allow Echo Jam to use Spotify on this PC** enables local takeover. Merely
  turning it on does not change any audio route while no Jam is active.
- **Hear Jam on this PC** enables Echo's synchronized local Jam relay. Its level
  uses the independent Jam Volume setting and still obeys Mute All.

When an allowed Jam becomes active, Echo temporarily routes only the Spotify
desktop app to the exact `CABLE Input (VB-Audio Virtual Cable)` endpoint. Echo
does not change the Windows system-default output or reroute other apps. It
captures Spotify's process tree through Windows process loopback and uploads
protocol-v3, generation-fenced audio for
the server to relay. With local monitoring off, Echo mutes only its local relay;
with monitoring on, the relay plays through Echo's selected output at the saved
Jam Volume.

**Stop Music** pauses the exact Spotify device already bound by the server. It
does not transfer playback and does not end the Jam: listeners, queue, capture,
route, and audio sockets remain ready. Disabling local takeover, the last-
listener empty timeout, and full Jam teardown are different lifecycle events.
Those paths pause the bound Spotify device first, then release the temporary
Spotify-only cable route.

Echo records the exact prior Spotify route before takeover. Echo also serializes
the complete journal-and-policy transaction across local Echo processes so an
older recovery cannot undo a newer takeover. An exact-generation source
teardown command restores it immediately. Turning local Allow off advertises the
source unavailable first and uses a three-second local restore fallback if the
server never sends that command. An unexpected socket or capture failure keeps
Spotify on the silent route for 36 seconds before restoring, covering
heartbeat, watchdog, and server pause timeouts. App exit waits up to 16 seconds
for that exact teardown command; on timeout it leaves the route journaled and
silent. A forced kill does the same implicitly. Startup recovery retains that
silent route until the exact journal owner has been continuously observed dead
for 36 seconds, then restores
the recorded route (or Windows Default if the old endpoint no longer exists).
After a reboot, logoff, or Fast User Switch, the old journal session ID is
diagnostic only: recovery accepts the current Spotify process only when it is
in Echo's current Windows session and its Store package family and app ID still
match the journal.

## Spotify Connect self-recovery

Start Jam performs one bounded preflight; there is no background watchdog. If
the configured Spotify Connect device is missing while the Echo Jam source is
armed and healthy, the control plane asks the provisioned Windows source client
to re-activate the already-running Microsoft Store Spotify identity and polls
Spotify for registration. If that exact Store app remains unregistered, Echo
may restart it once and poll again. The complete recovery shares the existing
15-second Jam-start deadline; there is no second independent timeout.

Echo never restarts its desktop client, the control service, or unrelated
processes during this repair. It refuses to interrupt an active Spotify media
session, validates the exact Store package family/app ID/current Windows
session, fences cancellation and connection replacement, and allows only one
restart attempt per minute. A closed or unarmed Spotify app still requires the
normal user action to open Spotify and enable Jam sharing. Errors explicitly
distinguish a missing **Spotify Connect device** from an offline **Echo Jam
source**.

## Release boundary

The `spotify_connect_repair_v1` capability is an optional protocol-v3
capability. Install the source desktop binary first; the old server ignores the
extra Availability field. Then deploy the control plane and its complete
server-served viewer snapshot. If the server lands first, an older source stays
protocol-compatible but a Start that needs repair fails closed with an update
message. Ordinary listener PCs do not receive Jam-source credentials and do not
need the source binary; they receive the updated viewer from the server. Always
publish the viewer as one
complete snapshot.
