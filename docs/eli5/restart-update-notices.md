# Restart and update notices

The restart announcement disappeared when session-renewal fixes removed a
misleading message: authentication failures could claim the server was
restarting. Recent viewer-only releases also left the latest release-note entry
at v0.6.37, so users who had read it got no new popup.

The guarded restart path now publishes an explicit, short-lived restart marker
before stopping the server. Viewers poll it without caching, show “The server is
restarting,” and attempt one spoken announcement. Failed requests, expired
tokens, malformed markers, and old markers cannot invent a restart. A marker
survives the brief outage, clears when the server reports ready, and expires
after two minutes if the deployment never finishes. The authenticated viewer
update countdown remains separate and reloads only after the server is available.

The Updates popup now includes the stream layout, tile ordering, game titles,
audio recovery, volume controls, and notification changes. Release-note content
has its own identity; new notes work without a new desktop installer. Displaying
a popup does not mark it read. Dismissing it or opening Updates history does.

The public `/viewer/restart-notice.json` contract is either `{"state":"ready"}` or
`{"state":"restarting","id":"<UUID>","started_at":<epoch milliseconds>,
"expires_at":<epoch milliseconds>}`. Only the local deployment tooling writes
this file, atomically, into the active configured viewer directory. The viewer
accepts at most a three-minute lifetime and the publisher uses two minutes. It
never renders free-form text from this file, nor reloads because of it.

Verification covers heartbeat/authentication failures, notice expiry, late
server replies, single-flight polling, speech deduplication across reloads,
update acknowledgement across reloads, and Windows notice-file writes. Browser
tests exercise the actual startup poll and both visible notices.

Release impact is server-served viewer and local deployment tooling only. No
Windows installer or control-binary rebuild is needed. Viewers must load this
update before they can recognize the new marker. Speech depends on browser
permission, and an unexpected crash or power outage cannot be announced ahead
of time. Real remote playback and off-LAN connectivity need a second device.
