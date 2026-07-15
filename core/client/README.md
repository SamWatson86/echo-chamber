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
- the Spotify desktop app, signed in and visible as the server's exact bound
  Spotify Connect device;
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
captures the cable signal and uploads protocol-v3, generation-fenced audio for
the server to relay. With local monitoring off, Echo mutes only its local relay;
with monitoring on, the relay plays through Echo's selected output at the saved
Jam Volume.

**Stop Music** pauses the exact Spotify device already bound by the server. It
does not transfer playback and does not end the Jam: listeners, queue, capture,
route, and audio sockets remain ready. Disabling local takeover, the last-
listener empty timeout, and full Jam teardown are different lifecycle events.
Those paths pause the bound Spotify device first, then release the temporary
Spotify-only cable route.

## Release boundary

Protocol v3 is a coordinated desktop-and-server change. Deploy the control
plane and its complete server-served viewer snapshot, and install the matching
Echo Desktop binary on the configured Spotify source PC. Ordinary listener PCs
do not receive Jam-source credentials and do not need the source binary; they
receive the updated viewer from the server. Do not run a protocol-v3 server
against an older source client or publish only part of the viewer bundle.
