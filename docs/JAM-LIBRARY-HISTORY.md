# Jam Library and Play History

This document defines the production behavior for Echo's shared Spotify
library, playlist expansion, and Jam play history.

## Queue invariant

The Jam queue always contains individual Spotify tracks. A playlist is a
catalog and bulk-import source, never a nested queue item. Adding a playlist
resolves its playable tracks on the control server, preserves their order and
duplicate occurrences, and adds them as ordinary queue entries with optional
playlist provenance.

Spotify items that are null, malformed, local-only, non-track, restricted, or
unplayable are skipped and reported. Playlist discovery and contents are lazy;
opening a playlist fetches one page and **Add all** performs the server-side
expansion. The viewer must never loop the single-track endpoint.

Echo queues at most 50 playlist items in one batch and requires confirmation
when more than 25 playable tracks will be added. The control server serializes
queue batches, preserves duplicate occurrences, and revalidates the active Jam
generation and bound Spotify device while it applies the batch. Other Jam
recovery controls are not held behind the full multi-request Spotify operation.

Spotify Development Mode restricts playlist-item reads to playlists the
connected account owns or collaborates on. Search and Echo-favoriting still
work for other playlist metadata, but Echo cannot flatten a playlist when
Spotify withholds its items; the API and viewer report that restriction
explicitly. Spotify apps in Extended Quota Mode are not subject to that 2026
Development Mode change. See Spotify's
[migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
and [Get Playlist Items contract](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

Echo does not claim that queued tracks can be removed individually. Removing a
favorite changes the shared library only and never changes Spotify playback or
an existing Jam queue.

## Shared Echo favorites

Spotify supplies catalog metadata and an initial library import, while Echo is
the source of truth for shared favorite attribution. A favorite is keyed by
Spotify item kind and ID and can have more than one contributor.

Echo Favorites are deliberately distinct from Spotify's own Liked Songs and
followed-playlist state. Viewer labels and controls say **Echo Favorites** so a
local Echo action is never presented as a Spotify Like action.

- **All favorites** shows each item once.
- Contributor filters select items favorited by one Echo actor.
- Favoriting an existing item adds the current actor relation idempotently.
- Unfavoriting removes only the current actor relation.
- The item disappears after its final contributor relation is removed.
- Importing the connected Spotify library adds liked tracks and owned/followed
  playlists to the importing actor without loading playlist contents.

Imports and catalog pages follow Spotify pagination and share a server-wide
request/cooldown gate for 429 responses. Playlist artwork URLs are temporary,
so they are shown from fresh Spotify responses but are not persisted in the
durable Echo Favorites file.

Library import and private/collaborative playlist access add the
`user-library-read`, `playlist-read-private`, and
`playlist-read-collaborative` Spotify scopes. A Spotify connection created
before this feature must use **Refresh Spotify Access** once to grant those
scopes; Echo does not request Spotify library-write permission.

Actor IDs are opaque, installation-stable identifiers derived by the control
server from the existing participant installation credential. Raw installation
credentials are never persisted in favorite or history records. Display names
are presentation metadata and are not used as the durable identity key.

## Play history

History contains Echo-queued tracks that Spotify was subsequently observed
playing on the configured Jam device. Queue acceptance alone is not a play.
Each record includes the first observed play time, queue-add time, contributing
Echo actor/display name, track identity and metadata, and optional playlist
provenance.

History uses run-based deduplication by Spotify track identity:

- `A, A, A` records one play for A.
- `A, B, A` records A, B, and A.
- Pause/resume, looping, and adjacent duplicate queue entries do not create a
  new record until a different track is observed playing.

Records are retained for exactly 30 days in a dedicated, non-web-readable
store. Retention is enforced during startup, append, periodic maintenance, and
query cutoff. History begins when the feature is deployed; the existing
join/leave session logs cannot reconstruct earlier plays.

At startup, Echo validates the favorites, history, actor-key, and Spotify-token
paths against every web-served root. Existing private data in an overlapping or
unverifiable path stops startup; a new unsafe path leaves the affected
persistence feature disabled instead of creating web-readable secrets or Jam
records.

## Spotify links

Track titles link to the track and playlist provenance links to the playlist.
The viewer opens links on the local user's machine, never on the control host.
Canonical HTTPS Spotify URLs are the compatibility fallback. Updated Windows
clients may use strictly validated `spotify:track` and `spotify:playlist` deep
links to open the installed Spotify app directly.

Spotify metadata and unmodified artwork are accompanied by the official
Spotify attribution mark. Artwork uses contain sizing so Echo does not crop or
overlay Spotify-provided images. The checked-in full wordmark comes from
Spotify's official [design and branding assets](https://developer.spotify.com/documentation/design).

## Release boundary

The catalog, favorites, playlist expansion, history API, persistence, and
server-served viewer are server changes. Guaranteed native Spotify deep links
add a Windows desktop-binary change. Old clients remain compatible through the
HTTPS fallback. Jam source/audio protocol version 3 is unchanged.
