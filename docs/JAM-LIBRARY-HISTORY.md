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
opening a playlist fetches one page of up to 50 positions and **Add entire
playlist** performs the server-side expansion. The viewer must never loop the
single-track endpoint.

Echo exposes playlist pages in chunks of 50 and can queue up to 1,000 playlist
positions in one operation. Spotify's supported Web API and the bounded
public-catalog fallback described below both use pages of at most 50. The
1,000-position ceiling bounds memory,
idempotency receipts, local cache size, and bulk queue mutations. A larger
restricted public playlist remains browsable and individually selectable
through its first 1,000 positions, but **Add entire playlist** is disabled and
no public-catalog request is made past position 999. Echo
requires confirmation when more than 25 playable tracks will be added. The
control server serializes queue mutations, preserves duplicate occurrences,
and revalidates the active Jam generation and bound Spotify device before it
accepts a batch.

Echo, rather than Spotify, owns the removable tail of the Jam queue. It hands a
maximum frontier of two entries to Spotify and promotes more pending entries as
playback advances. A queue row reports `delivery_state` and `can_remove`:

- `pending` entries have not been handed to Spotify and can be removed.
- `spotify_committed` entries are already current or queued in Spotify and
  cannot be removed; the current entry can still be skipped.
- `commit_unknown` means Spotify may have accepted a request whose result was
  ambiguous. Echo fails closed and does not remove or resend that occurrence.
  Playback URI, progress, and play/pause state are not acceptance proof, so the
  entry remains locked and unattributed until the Jam ends.

Once a `commit_unknown` entry exists, Echo rejects new single-song and playlist
adds with `queue_commit_unknown`; otherwise those entries would be permanently
stranded behind an unresolved Spotify frontier. Idempotent retries of the
original accepted Echo request still replay their receipt, and pending-tail
removal remains available. End and restart the Jam to establish a clean queue.

Any current Jam participant can remove one or many pending occurrences by their
unique queue-entry IDs. Removal is atomic, generation-fenced, revision-fenced,
and idempotent by request ID. A stale queue revision or a selection that now
contains a committed/unknown entry returns a conflict without removing any
rows. The API accepts at most 1,000 entry IDs per removal. Entry IDs, not Spotify
track IDs, keep duplicate occurrences independently selectable.

Single-track queue requests may also carry an idempotency request ID. The Jam
state advertises support with `track_queue_request_id_supported`; retries with
the same actor, generation, and Spotify track replay the original queue entry,
while reuse for different inputs is rejected. The field remains optional so a
cached older viewer continues to use the legacy one-shot request path during a
coordinated rollout.

Adjacent duplicate tracks require occurrence-level confirmation before Echo
advances the frontier. A near-end-to-near-start progress wrap is accepted only
when Spotify repeat-one is off and Spotify's queue observation confirms the
next item is no longer the same track. A repeat-one loop, a backward seek that
leaves the duplicate next item intact, or an unavailable queue observation
fails closed and leaves the frontier locked rather than silently consuming an
Echo occurrence.

Echo also retains whether Spotify started an occurrence immediately or queued
it behind the current item. A queued-next occurrence cannot match Play History
or become Echo's current queue row until a different current track, a preceding
Echo occurrence, or a confirmed same-track restart proves that boundary. This
prevents an externally playing copy of the same Spotify track from stealing the
queued occurrence's contributor and playlist provenance.

A successful Spotify Skip proves exactly one occurrence boundary. Echo retires
only the eligible front and unlocks only the first queued-next successor, even
when both occurrences use the same Spotify track URI. An ambiguous successor
remains `commit_unknown`, non-removable, locked, and excluded from Play History
for the rest of that Jam generation.

Skip's authoritative preflight is also a Play History observation. This keeps a
short-lived queued song in history when Spotify advances between normal Jam
state polls and someone immediately skips it. The normal consecutive-same-song
run dedupe still applies. If the preflight's selected current candidate is
`commit_unknown`—including a same-song candidate after a stale different
predecessor—Echo rejects Skip before calling Spotify `/next`; it never promotes,
attributes, or removes the ambiguous occurrence.

Selected-song queueing uses a distinct capability-gated endpoint and requires
the exact Spotify playlist snapshot shown in the viewer. A page whose snapshot
changes is discarded and reloaded before any positions can be submitted. If a
large operation is accepted, all playable positions enter Echo's queue as one
batch while only the bounded Spotify frontier becomes non-removable.
Unavailable/local skips are reported and never enter the queue.

Spotify Development Mode restricts the supported playlist-item endpoint to
playlists the connected account owns or collaborates on. Search and Echo
favoriting still work for other public playlist metadata. When Spotify rejects
playlist access with 403 or 404, Echo makes a user-triggered, read-only public-catalog
request for exactly 50 ordered positions and stores the normalized result in
the private `jam-library/playlist-items-cache-v2.json` file. There is no
background crawl, no export endpoint, and no account/browser cookie is read.
The cache is keyed by Spotify playlist snapshot, preserves duplicate
occurrences and unavailable positions, and is replaced automatically when the
snapshot changes. HARDWAVE-sized playlists therefore load as five 50-position
pages plus the remainder; the viewer reports both visible and locally cached
counts. The 50-position request size is a bounded implementation and rate-safety
guardrail; it is not, by itself, a statement or guarantee of Spotify policy or
legal compliance.

Bulk and selected-song queueing continue through the normal server-side
`PlaylistExpansion` path, so snapshot checks, provenance, idempotency, and Jam
race fences are unchanged. A durable Stop-admission fence also rejects any
track or playlist request that began before **Stop Music** or **Clear All**, even if a later
request resumes the preserved queue before the older playlist finishes
loading. If Spotify changes the public response contract,
Echo fails closed with a **Retry 50-song chunk** action and keeps **Open in
Spotify** available; it never substitutes guessed titles or IDs. Spotify apps
in Extended Quota Mode are not subject to the supported-endpoint 2026
Development Mode restriction. See Spotify's
[migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
and [Get Playlist Items contract](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items).

Echo never claims it can delete an item already handed to Spotify. Removing a
pending Echo queue entry prevents that occurrence from being handed to Spotify;
removing a favorite changes the shared library only and never changes playback
or an existing Jam queue.

### Clear All

The Queue tab's **Clear All** removes every pending, removable Echo occurrence
in one atomic operation, including duplicate songs. It preserves current
playback and truthfully retains entries already committed to Spotify or whose
delivery is uncertain. Spotify exposes no queue-delete operation; the viewer
reports the retained count and keeps those locked rows visible. Clear All does
not call Spotify, skip tracks, or claim Spotify's queue is empty.

`POST /api/jam/queue/clear` accepts `generation`, `request_id`, and
`expected_queue_revision`. It uses the same participant authorization and
generation/revision checks as individual removal, returns an idempotent receipt,
and fences catalog requests admitted before the clear so they cannot refill
the queue afterward. A stale revision returns HTTP 409 without removing songs;
the viewer refreshes and requires a new explicit action.

The receipt contains `ok`, `generation`, `queue_revision`, `removed_entry_ids`,
`removed_count`, `retained_entry_ids`, `retained_count`, and `complete`. When
entries remain, `retained_reason` is `spotify_controlled` and `complete` is
false. Malformed request IDs return 400; stale generations and conflicting
request-ID reuse return 409. Retrying the same request replays its receipt
without clearing songs added afterward.

## Song Radio

Clicking a song title in Search, Echo Favorites, a playlist, Play History, the
Queue, Now Playing, or the Jam banner opens a song menu with **Song Radio** and
**Open in Spotify**. Song Radio resolves Spotify's generated playlist for that
seed and opens it in the existing playlist browser. Echo preserves Spotify's
order and offers at most the first 250 positions, with unavailable songs skipped
and reported. A shorter radio stays shorter; Echo never fabricates filler or
substitutes a search result for a radio playlist.

`GET /api/jam/tracks/:id/radio` requires a current Echo participant token and a
22-character Spotify track ID. It returns `{schema_version: 1, seed_track_id,
max_tracks: 250, playlist}`, where `playlist` has the same normalized metadata
and snapshot as other catalog playlists. Discovery uses the read-only seed-to-
playlist resolver used by Spotify's web player, with a short-lived anonymous
token in process memory. It does not read account cookies or change playback.
Radio may differ from a listener's personally tailored radio in Spotify.

Generated radio metadata uses Spotify's public `fetchPlaylist` response,
including its real `revisionId` as the playlist snapshot. Ordinary playlist
metadata also falls back to that reader on an official 403/404. Playlist-item
403/404 responses use the existing public chunk reader; authentication, rate
limit, and transient server failures do not trigger fallback or duplicate
requests. Snapshot comparisons remain exact throughout browsing and queueing.

The resolver shares Echo's Spotify request/cooldown gate. Invalid IDs return
400, unavailable radio returns 404, rate limits return 429 with `Retry-After`
when supplied, and changed/malformed upstream contracts return 502. The viewer
keeps **Open in Spotify** available on failure. Spotify can change this public
web-player contract independently of Echo, just as with public playlist loading.

Radio browsing loads 50 positions at a time. Adding the radio uses the existing
playlist-selection endpoint for positions below 250, preserving server-side
snapshot validation, duplicate occurrences, skipped-item reporting, batch
provenance, confirmation over 25 playable songs, and idempotency. Navigating
away or opening another radio invalidates earlier lookup responses.

## Shared Echo favorites

Spotify supplies catalog metadata and an initial library import, while Echo is
the source of truth for shared favorite attribution. A favorite is keyed by
Spotify item kind and ID and can have more than one contributor.

Echo Favorites are deliberately distinct from Spotify's own Liked Songs and
followed-playlist state. Viewer labels and controls say **Echo Favorites** so a
local Echo action is never presented as a Spotify Like action.

Library track cards expose distinct **Open in Spotify** and **Add to queue**
actions. Library and Search playlist cards expose **Open in Spotify** and
**Choose songs**; choosing songs opens Echo's playlist detail, where an allowed
playlist can be selected song-by-song or added in full.

When Echo Favorites is empty, **Copy Spotify saves** copies the connected
account's Liked Songs and saved playlists into the shared library. It does not
copy the songs inside those playlists, change Spotify, or add anything to the
Jam queue. After first use, the compact **Check for new Spotify saves** action
adds newly saved items; the operation is safe to rerun and never removes an Echo
Favorite. Echo only shows **Connect Spotify** or **Grant Spotify Library Access**
when that action is actually required. A playlist found through Search can
instead be saved individually with the star or **Save to Echo**. **Add entire
playlist** only expands the playlist into queued tracks; it does not favorite
that playlist or backfill playlists queued before this feature existed.

- **All favorites** shows each item once.
- Contributor filters select items favorited by one Echo actor.
- Favoriting an existing item adds the current actor relation idempotently.
- Unfavoriting removes only the current actor relation.
- The item disappears after its final contributor relation is removed.
- Importing the connected Spotify library adds liked tracks and owned/followed
  playlists to the importing actor without loading playlist contents.

Imports and catalog pages follow Spotify pagination and share a server-wide
request/cooldown gate for 429 responses. Playlist artwork URLs are temporary,
so they are never persisted in the durable Echo Favorites file and image bytes
are never downloaded by the control server. Echo keeps validated Spotify-CDN
URLs in a bounded, one-hour process-memory cache seeded by import, Search, and
playlist detail responses. After a restart, only playlist covers on the
returned Favorites page are refreshed through Spotify's metadata-only images
endpoint, with at most 50 cache misses and a five-second total deadline. Cover
authorization, rate-limit, timeout, and image-load failures degrade to the
standard placeholder without failing the Library. A successful new Spotify
authorization clears the transient cache so private artwork cannot cross an
account boundary.

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
- An external Spotify occurrence is not recorded. If an Echo-queued occurrence
  of that same track follows it, Echo records the queued occurrence once the
  occurrence boundary is confirmed; later consecutive Echo repeats remain
  deduplicated.

Records are retained for exactly 30 days in a dedicated, non-web-readable
store. Retention is enforced during startup, append, periodic maintenance, and
query cutoff. History begins when the feature is deployed; the existing
join/leave session logs cannot reconstruct earlier plays.

While the History tab is visible, the viewer reloads its current page only when
the Jam state reports that a durable history append advanced the history
revision. Unchanged state polls preserve the existing History DOM and focus.
Each playable History row also exposes an explicit **Add to queue** action. It
reuses the single-track idempotency contract, keeps the current History page and
sort in place, and explains that a Jam must be started when queueing is disabled.

At startup, Echo validates the favorites, history, actor-key, and Spotify-token
paths against every web-served root. Existing private data in an overlapping or
unverifiable path stops startup; a new unsafe path leaves the affected
persistence feature disabled instead of creating web-readable secrets or Jam
records.

## Spotify links

Track titles open the song menu, which includes the track's **Open in Spotify**
link; playlist provenance links directly to the playlist.
The viewer opens links on the local user's machine, never on the control host.
Canonical HTTPS Spotify URLs are the compatibility fallback. Updated Windows
clients may use strictly validated `spotify:track` and `spotify:playlist` deep
links to open the installed Spotify app directly.

Spotify metadata and unmodified artwork are accompanied by the official
Spotify attribution mark. Artwork uses contain sizing so Echo does not crop or
overlay Spotify-provided images. The checked-in full wordmark comes from
Spotify's official [design and branding assets](https://developer.spotify.com/documentation/design).

## Echo Pulse

The Jam workspace includes a compact audio-reactive spectrum beneath Now
Playing. Echo Pulse analyzes the authenticated 48 kHz PCM that the joined Echo
viewer already receives; it does not sample Spotify artwork, scrape Spotify
audio, upload audio, or persist any audio-derived data.

Analysis is an optional muted branch beside the existing playback graph. A
missing or failing Web Audio analyser leaves Jam playback and output routing
unchanged and shows a static fallback. The source PC can therefore visualize
the communal feed even when its local relay gain is intentionally muted to
prevent doubled Spotify audio.

Full motion is capped at 24 frames per second, Ambient motion at 12 frames per
second, and Still/system reduced-motion renders one non-animated spectrum.
Animation pauses while the Jam panel or document is hidden and stops when no
track is playing. Users who have not joined see a truthful static
**Join Jam to activate** state; Echo never substitutes fake reactive motion.

## Release boundary

The catalog, favorites, playlist expansion, history API, persistence, and
server-served viewer are server changes. Guaranteed native Spotify deep links
add a Windows desktop-binary change. Old clients remain compatible through the
HTTPS fallback. Echo Pulse is server-served viewer code and does not require a
desktop update. Jam source/audio protocol version 3 is unchanged.
Song Radio and Clear All require a control-server and viewer deploy only;
neither requires a Windows desktop update.
