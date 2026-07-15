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
