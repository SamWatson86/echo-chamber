# Spotify Jam host-source reliability

## What broke

Echo said a Spotify Jam was running, but listeners received silence unless a
separate interactive Spotify/Echo setup happened to be open on the server PC.
The viewer and deployed server could also be on different Jam contracts, which
made a broken combination look current.

## Why it broke

The control plane runs as a Windows service in session 0. Spotify runs in the
signed-in user's interactive session. Windows process-loopback capture in the
service session cannot capture that Spotify process tree. The old fallback also
let any viewer race to become the audio source and shared capture ownership with
screen sharing.

## What changed

One explicitly configured Echo desktop client on the Spotify PC is now the only
Jam source. It captures Spotify in the same interactive Windows session and
sends generation-tagged PCM over an authenticated protocol-v2 WebSocket. The
control plane rejects stale sources/actions, targets one exact Spotify Connect
device, reports real source health, and only records queue changes that Spotify
accepted. Viewer assets are published as one verified snapshot. The listener
audio URL contains only the protocol version and current generation; the first
WebSocket frame authenticates with the listener's bound LiveKit token. When the
source host starts or joins the Jam, its local relayed copy is muted
automatically to prevent double playback over Spotify's direct output.
If Windows capture stops delivering packets while Spotify is still playing,
the server asks that same source to replace only its Jam capture handle; current
listeners stay connected and resume when the replacement reports ready.

Echo has one global shared Jam at a time. Any authenticated Echo user can start
it, join it, search, add songs, and skip from Echo's Jam panel. Listeners do not
need Spotify accounts, and they add songs through Echo rather than their own
Spotify apps. The configured source PC's Premium account is the one Spotify
account and playback device behind the shared Jam.

The red **Stop Music** button is shared like Skip: any authenticated Echo
participant can stop the sound for everyone. Echo pauses playback on the exact
configured Spotify desktop device but keeps the Jam, listeners, queue, and
audio connections open. Adding a song starts playback again. This is separate
from Echo's host-only Jam teardown, so “Stop Music” never secretly removes
everyone from the Jam.

## How we know it works

- Control tests: 53 passed.
- Windows desktop tests: 80 passed.
- Viewer tests: 127 passed.
- Full Cargo workspace check passed.
- Atomic viewer publish/rollback tests passed.
- Desktop deploy-config preservation tests passed.
- The capture tests prove Spotify selection stays in Echo's Windows session,
  uses Spotify's root process tree, and reconnects if that process is replaced.

The remaining proof is a live end-to-end run with the Premium host account,
Spotify desktop, and the newly provisioned Echo source client on the same PC.

## Does this need a desktop update?

Yes, on the configured Spotify source PC. The server/control plane and complete
server-served viewer snapshot must also be deployed. Ordinary listener PCs do
not need Jam-source credentials; they receive the viewer update from the server.

## What could still go wrong?

- Spotify or Echo is closed, or they run in different Windows sessions.
- Echo OAuth and the Spotify desktop app use different Spotify accounts.
- The configured Spotify device name is missing or matches multiple devices.
- A rotating Spotify device ID was pinned instead of using an exact unique name.
- The source client uses a server URL that does not match a trusted TLS
  certificate.
- The source token differs between the control environment and source client's
  `config.json`.
- Spotify reports playback but Windows delivers no audible process-loopback
  frames; Echo now exposes this as `stalled` instead of pretending it works.
