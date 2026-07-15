# Spotify Jam host-source reliability

## The simple version

Echo has one shared Jam and one Spotify source PC. That PC runs Spotify Desktop
and Echo Desktop in the same signed-in Windows session. Echo's server controls
the same Premium account and exact Spotify Connect device. Everyone else joins
through Echo; listeners do not need Spotify accounts.

The server cannot capture the user's Spotify audio itself because it runs as a
Windows service in a different session. The configured Echo Desktop client is
therefore the only source. It sends authenticated, generation-tagged audio to
the server using Jam protocol v3.

## What the source-PC user does

The source PC shows **Spotify Jam on this PC** before the user even logs into
Echo, and shows the same controls again in the Jam panel:

- **Allow Echo Jam to use Spotify on this PC** permits temporary takeover.
- **Hear Jam on this PC** chooses whether this PC also plays Echo's synchronized
  relay. Its loudness is the separate Jam Volume setting.

Turning Allow on while idle does not reroute anything. When a Jam starts, Echo
temporarily routes only Spotify Desktop to the exact
`CABLE Input (VB-Audio Virtual Cable)` endpoint, captures the cable signal, and
relays it to every listener. The Windows default output and other apps are not
changed. If Hear Jam is off, only Echo's local relay is muted; the saved Jam
Volume is not changed.

Any authenticated Echo participant can start or join the one global Jam,
search, add songs, skip, and use **Stop Music**. Stop Music pauses the exact
Spotify device already bound to the Jam without transferring playback. The Jam,
listeners, queue, capture route, and audio connections stay open, so adding a
song can start playback again.

Turning Allow off, reaching the last-listener empty timeout, or ending the Jam
is different: Echo pauses the bound Spotify device first, then releases its
temporary Spotify-only route and capture.

## Required pieces

The source PC needs:

- the matching Echo Desktop Windows binary;
- Spotify Desktop signed into the Premium account authorized by Echo OAuth;
- VB-CABLE with `CABLE Input (VB-Audio Virtual Cable)` present;
- the exact configured Spotify device name or ID; and
- source credentials and a trusted HTTPS connection matching the server.

Protocol v3 crosses a release boundary: deploy the control plane and its whole
viewer bundle, then update the configured source PC's Echo Desktop binary.
Ordinary listener PCs get the viewer from the server and never receive source
credentials.

## What could still go wrong?

- Spotify or Echo Desktop is closed, or they run in different Windows sessions.
- Echo OAuth and Spotify Desktop use different Spotify accounts.
- The configured Spotify device is missing, ambiguous, or has a stale pinned ID.
- VB-CABLE is missing or its playback endpoint does not have the exact name.
- The source token or ID differs between the server and source `config.json`.
- The source URL does not match a certificate trusted by Windows.
- Spotify reports playback but no cable frames arrive; Echo reports the source
  as stalled instead of claiming that audio is healthy.
