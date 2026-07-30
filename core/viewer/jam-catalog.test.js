const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const viewerDir = __dirname;
const jamSource = fs.readFileSync(path.join(viewerDir, "jam.js"), "utf8");
const indexSource = fs.readFileSync(path.join(viewerDir, "index.html"), "utf8");

function section(startMarker, endMarker) {
  const start = jamSource.indexOf(startMarker);
  const end = jamSource.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} is present`);
  assert.notEqual(end, -1, `${endMarker} follows ${startMarker}`);
  return jamSource.slice(start, end);
}

function normalize(raw, expectedKind) {
  const helpers = section("function jamSafeString(", "function jamNormalizeCatalogItems(");
  const context = {
    URL,
    window: { location: { href: "https://echo.test/" } },
    raw,
    expectedKind,
    result: null,
  };
  vm.runInNewContext(`${helpers}\nresult = normalizeSpotifyCatalogItem(raw, expectedKind);`, context);
  return context.result;
}

function normalizeHistory(raw) {
  const helpers = section("function jamSafeString(", "function jamNormalizeCatalogItems(");
  const history = section("function jamDateValue(", "function jamAppendHistoryTime(");
  const context = {
    URL,
    window: { location: { href: "https://echo.test/" } },
    raw,
    result: null,
  };
  vm.runInNewContext(`${helpers}\n${history}\nresult = jamHistoryEntry(raw);`, context);
  return context.result;
}

test("catalog normalization accepts only canonical 22-character Spotify identities", () => {
  const id = "0123456789ABCDEFGHIJKL";
  const item = normalize({
    kind: "playlist",
    spotify_id: id,
    name: "Road Trip",
    track_count: 37,
    favorited_by_me: true,
    favorite_contributor_count: 2,
  }, "playlist");

  assert.equal(item.spotify_id, id);
  assert.equal(item.uri, `spotify:playlist:${id}`);
  assert.equal(item.url, `https://open.spotify.com/playlist/${id}`);
  assert.equal(item.item_count, 37);
  assert.equal(item.favorite_contributor_count, 2);
  const occurrence = normalize({
    kind: "track",
    spotify_id: "1234567890ABCDEFGHIJKL",
    name: "Repeated Song",
    playlist_position: 0,
  }, "track");
  assert.equal(occurrence.playlist_position, 0, "position zero remains selectable");
  assert.equal(normalize({ kind: "track", spotify_id: "too-short" }, "track"), null);
  assert.equal(normalize({ kind: "track", spotify_url: `https://evil.test/track/${id}` }, "track"), null);
});

test("favorite views normalize exact attribution fields defensively", () => {
  const item = normalize({
    kind: "track",
    spotify_id: "1234567890ABCDEFGHIJKL",
    name: "Shared Song",
    attributions: [
      { actor_id: "sam", display_name: "Sam", added_at_ms: 123, source: "manual" },
      { actor_id: "alex", display_name: "Alex", added_at_ms: 456, source: "import" },
    ],
    contributor_count: 2,
    favorited_by_me: true,
  }, "track");

  assert.equal(item.attributions.length, 2);
  assert.equal(item.attributions[0].display_name, "Sam");
  assert.equal(item.contributor_count, 2);
  assert.equal(item.favorited_by_me, true);
  assert.match(jamSource, /Add to Echo Favorites/);
  assert.match(jamSource, /Remove from Echo Favorites/);
  assert.doesNotMatch(jamSource, /\\u2665|\\u2661/);
});

test("history rows normalize every field required by the idempotent track queue path", () => {
  const item = normalizeHistory({
    track: {
      spotify_id: "1234567890ABCDEFGHIJKL",
      name: "Play It Again",
    },
    artist: "Fixture Artist",
    album_art_url: "https://i.scdn.co/image/history-fixture",
    duration_ms: 222000,
    added_by_name: "Sam",
  });

  assert.equal(item.track.spotify_uri, "spotify:track:1234567890ABCDEFGHIJKL");
  assert.equal(item.track.name, "Play It Again");
  assert.equal(item.track.artist, "Fixture Artist");
  assert.equal(item.track.artwork_url, "https://i.scdn.co/image/history-fixture");
  assert.equal(item.track.duration_ms, 222000);
});

test("search uses typed paging with abort and a monotonic stale-response gate", () => {
  const search = section("function onSearchInput(", "function jamFavoriteSummary(");
  assert.match(search, /setTimeout\(function\(\) \{ searchSpotify\(value, 0\); \}, 300\)/);
  assert.match(search, /_jamSearchController\.abort\(\)/);
  assert.match(search, /requestId = \+\+_jamSearchRequestSeq/);
  assert.match(search, /requestId !== _jamSearchRequestSeq/);
  assert.match(search, /\/api\/jam\/catalog\/search/);
  assert.match(search, /kind: _jamSearchKind/);
  assert.match(search, /offset: requestedOffset/);
  assert.match(search, /limit: JAM_CATALOG_PAGE_SIZE/);
  assert.match(jamSource, /function setJamSearchKind[\s\S]*clearTimeout\(_searchTimer\)[\s\S]*_searchTimer = null/);
});

test("library omits a blank actor filter and supports import upgrade guidance", () => {
  const library = section("async function loadJamLibrary(", "function renderJamLibrary(");
  assert.match(library, /contributor && contributor\.value \? "&actor_id="/);
  assert.doesNotMatch(library, /"&actor_id=" \+ encodeURIComponent\(contributor \? contributor\.value : ""\)/);
  assert.match(jamSource, /tracks_seen/);
  assert.match(jamSource, /playlists_seen/);
  assert.match(jamSource, /Refresh Spotify Access/);
  assert.match(jamSource, /spotify_library_authorized/);
  assert.match(jamSource, /playlistSelectionSupported/);
  assert.match(jamSource, /No Echo Favorites yet\. Copy your Spotify saves above/);
  assert.match(indexSource, /id="jam-library-refresh-spotify"/);
  assert.match(indexSource, /id="jam-import-spotify"[^>]*>Copy Spotify saves</);
  assert.match(indexSource, /not the songs inside playlists/);
  assert.match(indexSource, /Spotify is unchanged, and nothing is added to the Jam queue/);
  assert.match(jamSource, /payload\.retry_after/);
});

test("Jam markup separates playback controls from the music browser workspace", () => {
  const overviewStart = indexSource.indexOf('class="jam-session-overview"');
  const overviewEnd = indexSource.indexOf("</div>", indexSource.indexOf('id="jam-status"', overviewStart));
  const browserStart = indexSource.indexOf('id="jam-browser"');
  assert.notEqual(overviewStart, -1);
  assert.notEqual(browserStart, -1);
  assert.ok(overviewEnd < browserStart, "overview and browser are sibling workspace columns");
});

test("entire and selected playlist enqueue share one provenance-preserving batch operation", () => {
  const enqueue = section("function jamPlaylistQueueActionContext(", "function jamDateValue(");
  assert.match(enqueue, /"\/api\/jam\/queue\/playlist\/selection"/);
  assert.match(enqueue, /"\/api\/jam\/queue\/playlist"/);
  assert.match(enqueue, /trackCount > 25/);
  assert.match(enqueue, /jamBeginPlaylistQueueOperation/);
  assert.match(enqueue, /jamFinishPlaylistQueueOperation/);
  assert.match(enqueue, /request_id: requestId/);
  assert.match(enqueue, /snapshot_id: context\.snapshot_id/);
  assert.match(enqueue, /payload\.selected_positions = context\.selected_positions\.slice\(\)/);
  assert.match(enqueue, /rejection\.error === "confirmation_required"/);
  assert.match(enqueue, /rejection\.playable_count/);
  assert.match(enqueue, /jamRememberAmbiguousPlaylistRequest/);
  assert.match(enqueue, /remaining_positions/);
  assert.doesNotMatch(enqueue, /forEach[\s\S]*addToQueue/);
  assert.doesNotMatch(enqueue, /trackCount > 50/);
  assert.match(indexSource, /id="jam-playlist-add-all"[^>]*>Add entire playlist</);
  assert.match(indexSource, /id="jam-playlist-selection-count"[^>]*aria-live="polite"/);
  assert.match(indexSource, /id="jam-playlist-clear-selection"/);
  assert.match(indexSource, /id="jam-playlist-add-selected"/);
});

test("Jam browser markup exposes keyboard tabs and inactive-accessible history", () => {
  assert.match(indexSource, /class="jam-browser-tabs" role="tablist"/);
  assert.match(indexSource, /id="jam-view-library-tab"[^>]*role="tab"/);
  assert.match(indexSource, /id="jam-view-history-tab"[^>]*role="tab"/);
  assert.match(indexSource, /id="jam-history-section"[^>]*role="tabpanel"/);
  assert.match(indexSource, /id="jam-search-input" type="search"/);
  assert.match(jamSource, /jamTabKeydown\(event, "\.jam-browser-tab"/);
});

test("Spotify links try the native URI command and fall back without Echo navigation", () => {
  const opener = section("async function openSpotifyItem(", "function jamTabKeydown(");
  assert.match(opener, /tauriInvoke\("open_spotify_uri", \{ uri: item\.uri, url: item\.url \}\)/);
  assert.match(opener, /tauriInvoke\("open_external_url", \{ url: item\.url \}\)/);
  assert.match(opener, /window\.open\(item\.url, "_blank", "noopener,noreferrer"\)/);
  assert.match(opener, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(opener, /location\s*=/);
  const nowPlaying = section("function renderNowPlaying(", "function renderQueue(");
  const banner = section("function updateNowPlayingBanner(", "async function fetchBannerState(");
  assert.match(nowPlaying, /normalizeSpotifyCatalogItem\(Object\.assign\(\{\}, np, \{ kind: "track" \}\), "track"\)/);
  assert.match(nowPlaying, /jamCreateSpotifyLink\(track/);
  assert.match(nowPlaying, /_jamState\.active && !track/);
  assert.doesNotMatch(nowPlaying, /escapeHtml\(np\./);
  assert.match(banner, /jamCreateSpotifyLink\(track/);
});
