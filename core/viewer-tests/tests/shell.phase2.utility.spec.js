import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const runtimeErrors = new WeakMap();
const apiModels = new WeakMap();
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const transparentDataUrl = `data:image/png;base64,${transparentPng.toString("base64")}`;
const trackId = "0123456789ABCDEFGHIJKL";
const playlistId = "ABCDEFGHIJKL0123456789";

function longText(label) {
  return `${label} ${"Private Clubhouse Fellowship Anthem ".repeat(4).trim()}`;
}

function createJamState() {
  return {
    jam_protocol_version: 3,
    active: true,
    generation: 7,
    spotify_connected: true,
    spotify_is_playing: true,
    playback_stop_supported: true,
    playlist_selection_supported: true,
    skip_reconciliation_pending: false,
    last_error: null,
    source_enabled: true,
    source_availability_known: true,
    source_status: "live",
    source_ready: true,
    source_last_frame_ms: 24,
    source_peak: 0.42,
    host_identity: "layout-fixture-1",
    listener_count: 2,
    listeners: ["layout-fixture-2", "layout-fixture-3"],
    now_playing: {
      spotify_id: trackId,
      spotify_uri: `spotify:track:${trackId}`,
      spotify_url: `https://open.spotify.com/track/${trackId}`,
      name: longText("Now Playing"),
      artist: longText("The Extremely Long Artist Name"),
      album_art_url: transparentDataUrl,
      duration_ms: 240_000,
      progress_ms: 91_000,
      is_playing: true,
    },
    spotify_library_authorized: true,
    queue_revision: 11,
    history_revision: 0,
    queue: Array.from({ length: 8 }, (_, index) => ({
      queue_entry_id: `queue-entry-${index + 1}`,
      delivery_state: index === 0 ? "spotify_committed" : index === 1 ? "commit_unknown" : "pending",
      can_remove: index >= 2,
      spotify_uri: `spotify:track:queue-${index + 1}`,
      name: longText(`Queued Song ${index + 1}`),
      artist: longText(`Queued Artist ${index + 1}`),
      album_art_url: transparentDataUrl,
      duration_ms: 180_000 + index * 1_000,
      added_by: `Friend ${index + 2}`,
    })),
  };
}

function createSearchTracks() {
  return Array.from({ length: 6 }, (_, index) => ({
    kind: "track",
    spotify_id: `0${String(index + 1).padStart(21, "0")}`,
    spotify_uri: `spotify:track:0${String(index + 1).padStart(21, "0")}`,
    name: longText(`Search Result ${index + 1}`),
    artist: longText(`Search Artist ${index + 1}`),
    album_art_url: transparentDataUrl,
    duration_ms: 201_000 + index * 1_000,
  }));
}

function increment(model, key) {
  model.counts[key] = (model.counts[key] || 0) + 1;
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  const model = {
    counts: Object.create(null),
    ambiguousPlaylistQueue: false,
    ambiguousResponseSent: false,
    committedPlaylistRequestIds: new Set(),
    committedTrackRequestIds: new Set(),
    duplicatePlaylistTracks: false,
    entirePlaylistPartial: false,
    entirePlaylistPartialSent: false,
    errors,
    expectedConfirmationConflict: false,
    expectedArtworkFailure: false,
    expectedPlaylistForbidden: false,
    expectedQueueRemovalConflict: false,
    expectedQueueRemovalNetworkError: false,
    expectedTrackQueueNetworkError: false,
    favoriteItems: null,
    favoriteQueries: [],
    forceConfirmation: false,
    forbidPlaylistItems: false,
    importError: null,
    importTracksOnly: false,
    importRuns: 0,
    historyItems: null,
    queueTrackBodies: [],
    queueTrackAbortAfterCommitOnce: false,
    queueTrackDelayOnceMs: 0,
    queueTrackMutations: 0,
    queueRemovalBodies: [],
    queueRemovalAbortAfterCommitOnce: false,
    queueRemovalConflictOnce: false,
    queuePlaylistBodies: [],
    queuePlaylistMutations: 0,
    selectedPlaylistPartial: false,
    playlistItemOffsets: [],
    playlistItemsSource: "spotify",
    playlistSnapshot: "snapshot-fixture-1",
    playlistSnapshotChangesOnAppend: false,
    playlistQueueDelayOnceMs: 0,
    playlistQueueDelays: [],
    playlistQueueResponses: 0,
    playlistTotal: 30,
    searchTracks: createSearchTracks(),
    state: createJamState(),
    playlist: {
      kind: "playlist",
      spotify_id: playlistId,
      spotify_uri: `spotify:playlist:${playlistId}`,
      spotify_url: `https://open.spotify.com/playlist/${playlistId}`,
      name: "Fixture Road Trip",
      owner: "Fixture Owner",
      description: "A playlist used to verify the real Jam browser.",
      artwork_url: "https://i.scdn.co/image/playlist-fixture",
      snapshot_id: "snapshot-fixture-1",
      track_count: 30,
      favorited_by_me: false,
      favorite_contributor_count: 1,
    },
  };
  runtimeErrors.set(page, errors);
  apiModels.set(page, model);

  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (model.expectedConfirmationConflict && message.text().includes("409 (Conflict)")) return;
      if (model.expectedQueueRemovalConflict && message.text().includes("409 (Conflict)")) return;
      if (model.expectedQueueRemovalNetworkError && message.text().includes("Failed to load resource")) return;
      if (model.expectedTrackQueueNetworkError && message.text().includes("Failed to load resource")) return;
      if (model.expectedArtworkFailure && message.text().includes("Failed to load resource")) return;
      if (model.expectedPlaylistForbidden &&
          (message.text().includes("403 (Forbidden)") || message.text().includes("502 (Bad Gateway)"))) return;
      if (model.importError && message.text().includes(`${model.importError.status || 403} (Forbidden)`)) return;
      if (model.ambiguousPlaylistQueue && message.text().includes("Failed to load resource")) return;
      errors.push(`console.error: ${message.text()}`);
    }
  });

  await page.route("https://i.scdn.co/image/history-fixture", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
  });
  await page.route("https://i.scdn.co/image/playlist-fixture", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

    if (url.pathname === "/api/online") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname.startsWith("/api/avatar/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
      return;
    }
    if (url.pathname === "/api/version") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ latest_client: "" }),
      });
      return;
    }
    if (url.pathname === "/api/client-stats-report" && request.method() === "POST") {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (url.pathname === "/api/soundboard/list" && request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sounds: [] }),
      });
      return;
    }
    if (url.pathname === "/api/jam/state" && request.method() === "GET") {
      increment(model, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(model.state),
      });
      return;
    }
    if (url.pathname === "/api/jam/catalog/search" && request.method() === "POST") {
      increment(model, key);
      const requestBody = request.postDataJSON();
      const isPlaylist = requestBody.kind === "playlist";
      const query = requestBody.query;
      if (query === "slow original") await new Promise((resolve) => setTimeout(resolve, 500));
      const searchItems = isPlaylist
        ? [model.playlist]
        : query === "slow original"
          ? [{ ...model.searchTracks[0], name: "Stale Result" }]
          : query === "fresh replacement"
            ? [{ ...model.searchTracks[1], name: "Fresh Result" }]
            : model.searchTracks;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          kind: requestBody.kind,
          items: searchItems,
          offset: requestBody.offset,
          limit: requestBody.limit,
          total: searchItems.length,
          next_offset: null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/favorites" && request.method() === "GET") {
      increment(model, key);
      model.favoriteQueries.push(Object.fromEntries(url.searchParams));
      if (model.favoriteItems) {
        const kind = url.searchParams.get("kind") || "all";
        const actorId = url.searchParams.get("actor_id") || "";
        const facetItems = model.favoriteItems.filter((item) => kind === "all" || item.kind === kind);
        const contributors = new Map();
        for (const attribution of facetItems.flatMap((item) => item.attributions || [])) {
          const current = contributors.get(attribution.actor_id) || {
            actor_id: attribution.actor_id,
            display_name: attribution.display_name,
            count: 0,
          };
          current.count += 1;
          contributors.set(attribution.actor_id, current);
        }
        const filteredItems = facetItems.filter((item) => !actorId || (item.attributions || []).some((entry) => entry.actor_id === actorId));
        const offset = Number(url.searchParams.get("offset") || 0);
        const limit = Number(url.searchParams.get("limit") || 20);
        const items = filteredItems.slice(offset, offset + limit);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schema_version: 1,
            items,
            contributors: Array.from(contributors.values()),
            counts: {
              tracks: filteredItems.filter((item) => item.kind === "track").length,
              playlists: filteredItems.filter((item) => item.kind === "playlist").length,
              contributors: contributors.size,
            },
            offset,
            limit,
            total: filteredItems.length,
            next_offset: offset + items.length < filteredItems.length ? offset + items.length : null,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          items: [{
            kind: "track",
            spotify_id: trackId,
            spotify_uri: `spotify:track:${trackId}`,
            spotify_url: `https://open.spotify.com/track/${trackId}`,
            name: "Shared Favorite",
            artist: "Fixture Artist",
            attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 100, source: "manual" }],
            contributor_count: 1,
            favorited_by_me: true,
          }, model.playlist],
          contributors: [{ actor_id: "sam", display_name: "Sam", count: 1 }],
          counts: { track: 1, playlist: 1 },
          offset: Number(url.searchParams.get("offset") || 0),
          limit: 20,
          total: 2,
          next_offset: null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/favorites/import-spotify" && request.method() === "POST") {
      increment(model, key);
      if (model.importError) {
        await route.fulfill({
          status: model.importError.status || 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: model.importError.error,
            message: model.importError.message,
          }),
        });
        return;
      }
      if (model.state.spotify_library_authorized === false) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "spotify_library_scope_required",
            message: "Spotify Library access is missing. Use Refresh Spotify Access, then try again.",
          }),
        });
        return;
      }
      model.importRuns += 1;
      if (!model.favoriteItems || model.favoriteItems.length === 0) {
        model.favoriteItems = [{
          kind: "track",
          spotify_id: trackId,
          spotify_uri: `spotify:track:${trackId}`,
          spotify_url: `https://open.spotify.com/track/${trackId}`,
          name: "Imported Liked Song",
          artist: "Fixture Artist",
          attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 300, source: "spotify_saved_tracks" }],
          contributor_count: 1,
          favorited_by_me: true,
        }];
        if (!model.importTracksOnly) {
          model.favoriteItems.push({
            ...model.playlist,
            name: "Imported Saved Playlist",
            attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 300, source: "spotify_playlists" }],
            contributor_count: 1,
            favorited_by_me: true,
          });
        }
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          tracks_seen: 1,
          playlists_seen: 1,
          items_created: model.importRuns === 1 ? 2 : 0,
          attributions_added: model.importRuns === 1 ? 2 : 0,
          skipped: 0,
        }),
      });
      return;
    }
    if (url.pathname === `/api/jam/playlists/${playlistId}/items` && request.method() === "GET") {
      increment(model, key);
      if (model.forbidPlaylistItems) {
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            error: "playlist_catalog_unavailable",
            message: "Spotify changed its public playlist response; Echo needs an update before retrying",
          }),
        });
        return;
      }
      const offset = Number(url.searchParams.get("offset") || 0);
      const limit = Number(url.searchParams.get("limit") || 50);
      model.playlistItemOffsets.push(offset);
      if (model.playlistSnapshotChangesOnAppend && offset > 0) {
        model.playlistSnapshot = "snapshot-fixture-2";
      }
      const total = model.playlistTotal;
      const accessibleTotal = model.playlistItemsSource === "local_cache"
        ? Math.min(total, 1000)
        : total;
      const returned = Math.max(0, Math.min(limit, accessibleTotal - offset));
      const items = Array.from({ length: returned }, (_, index) => {
        const position = offset + index;
        return {
          ...model.searchTracks[position % model.searchTracks.length],
          spotify_id: `1${String(position + 1).padStart(21, "0")}`,
          spotify_uri: `spotify:track:1${String(position + 1).padStart(21, "0")}`,
          name: model.duplicatePlaylistTracks && position < 2 ? "Duplicate Song" : `Playlist Song ${position + 1}`,
          artist: model.duplicatePlaylistTracks && position < 2 ? "Same Artist" : model.searchTracks[position % model.searchTracks.length].artist,
          playlist_position: position,
        };
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          playlist: {
            ...model.playlist,
            snapshot_id: model.playlistSnapshot,
            track_count: total,
          },
          items,
          skipped: [],
          offset,
          limit,
          total,
          next_offset: offset + returned < accessibleTotal ? offset + returned : null,
          items_source: model.playlistItemsSource,
          local_cache: model.playlistItemsSource === "local_cache" ? {
            chunk_size: 50,
            cached_count: Math.min(total, offset + returned),
            cached_chunk_offsets: Array.from({ length: Math.ceil((offset + returned) / 50) }, (_, index) => index * 50),
            next_missing_chunk_offset: offset + returned < accessibleTotal ? offset + returned : null,
            total,
            complete: total <= 1000 && offset + returned >= total,
            position_limit: 1000,
            truncated: total > 1000,
            updated_at_ms: 123456,
          } : undefined,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/queue" && request.method() === "POST") {
      increment(model, key);
      const requestBody = request.postDataJSON();
      model.queueTrackBodies.push(requestBody);
      if (!model.committedTrackRequestIds.has(requestBody.request_id)) {
        model.committedTrackRequestIds.add(requestBody.request_id);
        model.queueTrackMutations += 1;
      }
      const responseDelay = Number(model.queueTrackDelayOnceMs || 0);
      model.queueTrackDelayOnceMs = 0;
      if (responseDelay > 0) await new Promise((resolve) => setTimeout(resolve, responseDelay));
      if (model.queueTrackAbortAfterCommitOnce) {
        model.queueTrackAbortAfterCommitOnce = false;
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
      return;
    }
    if (url.pathname === "/api/jam/queue/remove" && request.method() === "POST") {
      increment(model, key);
      const requestBody = request.postDataJSON();
      model.queueRemovalBodies.push(requestBody);
      if (model.queueRemovalConflictOnce) {
        model.queueRemovalConflictOnce = false;
        const lockedEntry = model.state.queue.find((track) => track.queue_entry_id === requestBody.queue_entry_ids[0]);
        if (lockedEntry) {
          lockedEntry.delivery_state = "spotify_committed";
          lockedEntry.can_remove = false;
        }
        model.state.queue_revision += 1;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "queue_changed",
            message: "The Jam queue changed; refresh it before removing songs",
            queue_revision: model.state.queue_revision,
          }),
        });
        return;
      }
      const requestedIds = new Set(requestBody.queue_entry_ids || []);
      const removableIds = model.state.queue
        .filter((track) => requestedIds.has(track.queue_entry_id) && track.delivery_state === "pending" && track.can_remove)
        .map((track) => track.queue_entry_id);
      if (requestBody.expected_queue_revision !== model.state.queue_revision || removableIds.length !== requestedIds.size) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "queue_changed", message: "The Jam queue changed", queue_revision: model.state.queue_revision }),
        });
        return;
      }
      const removedIds = new Set(removableIds);
      model.state.queue = model.state.queue.filter((track) => !removedIds.has(track.queue_entry_id));
      model.state.queue_revision += 1;
      if (model.queueRemovalAbortAfterCommitOnce) {
        model.queueRemovalAbortAfterCommitOnce = false;
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          generation: model.state.generation,
          queue_revision: model.state.queue_revision,
          removed_entry_ids: removableIds,
          removed_count: removableIds.length,
        }),
      });
      return;
    }
    if (["/api/jam/queue/playlist", "/api/jam/queue/playlist/selection"].includes(url.pathname) && request.method() === "POST") {
      increment(model, key);
      const requestBody = request.postDataJSON();
      model.queuePlaylistBodies.push(requestBody);
      if (model.trackPlaylistQueueMutations && !model.committedPlaylistRequestIds.has(requestBody.request_id)) {
        model.committedPlaylistRequestIds.add(requestBody.request_id);
        model.queuePlaylistMutations += 1;
      }
      const responseDelay = model.playlistQueueDelays.length
        ? Number(model.playlistQueueDelays.shift() || 0)
        : Number(model.playlistQueueDelayOnceMs || 0);
      model.playlistQueueDelayOnceMs = 0;
      if (responseDelay > 0) await new Promise((resolve) => setTimeout(resolve, responseDelay));
      const selectedEndpoint = url.pathname.endsWith("/selection");
      const selectedRequest = Array.isArray(requestBody.selected_positions);
      if (selectedEndpoint !== selectedRequest) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "wrong_playlist_queue_endpoint" }),
        });
        return;
      }
      if (model.forbidPlaylistItems) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "playlist_items_forbidden",
            message: "Spotify only allows this Echo app to expand playlists the connected account owns or collaborates on; other public playlists require Spotify Extended Quota",
          }),
        });
        return;
      }
      if (model.forceConfirmation && model.queuePlaylistBodies.length === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "confirmation_required", playable_count: 30, confirmation_threshold: 25 }),
        });
        return;
      }
      if (selectedRequest) {
        if (model.ambiguousPlaylistQueue) {
          if (!model.committedPlaylistRequestIds.has(requestBody.request_id)) {
            model.committedPlaylistRequestIds.add(requestBody.request_id);
            model.queuePlaylistMutations += 1;
          }
          if (!model.ambiguousResponseSent) {
            model.ambiguousResponseSent = true;
            await route.abort("connectionreset");
            return;
          }
        }
        if (model.selectedPlaylistPartial) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              partial: true,
              complete: false,
              request_id: requestBody.request_id,
              queue_batch_id: "selected-batch-1",
              queued_count: 1,
              queued_positions: [requestBody.selected_positions[1]],
              skipped: [{ position: requestBody.selected_positions[0], reason: "unavailable" }],
              failure: { status: 429, error: "spotify_rate_limited", message: "Spotify rate limit interrupted the batch.", retry_after: "12" },
            }),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            partial: false,
            complete: true,
            request_id: requestBody.request_id,
            queue_batch_id: "selected-batch-1",
            queued_count: requestBody.selected_positions.length,
            queued_positions: requestBody.selected_positions,
            skipped: [],
          }),
        });
        model.playlistQueueResponses += 1;
        return;
      }
      if (model.entirePlaylistPartial && !model.entirePlaylistPartialSent) {
        model.entirePlaylistPartialSent = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            partial: true,
            complete: false,
            request_id: requestBody.request_id,
            queue_batch_id: "entire-batch-1",
            queued_count: 2,
            queued_positions: [0, 1],
            remaining_positions: Array.from({ length: model.playlistTotal - 2 }, (_, index) => index + 2),
            skipped: [],
            failure: { status: 429, error: "spotify_rate_limited", message: "Spotify rate limit interrupted the batch.", retry_after: "12" },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, request_id: request.postDataJSON().request_id, queue_batch_id: "batch-1", queued_count: model.playlistTotal - 1, queued_positions: Array.from({ length: model.playlistTotal }, (_, index) => index).filter((position) => position !== 4), remaining_positions: [], skipped: [{ position: 4, reason: "unavailable" }], partial: false, complete: true }),
      });
      return;
    }
    if (url.pathname === "/api/jam/history" && request.method() === "GET") {
      increment(model, key);
      const historyItems = model.historyItems === null ? [{
        history_entry_id: "history-1",
        spotify_id: trackId,
        spotify_uri: `spotify:track:${trackId}`,
        spotify_url: `https://open.spotify.com/track/${trackId}`,
         name: "Played While Inactive",
         artist: "Fixture Artist",
         album_art_url: "https://i.scdn.co/image/history-fixture",
         duration_ms: 222_000,
         added_at_ms: 1_700_000_000_000,
        played_at_ms: 1_700_000_100_000,
        added_by_actor_id: "sam",
        added_by_name: "Sam",
        playlist: model.playlist,
      }] : model.historyItems;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          items: historyItems,
          offset: 0,
          limit: 20,
          total: historyItems.length,
          next_offset: null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/playback/stop" && request.method() === "POST") {
      increment(model, key);
      model.state.spotify_is_playing = false;
      if (model.state.now_playing) model.state.now_playing.is_playing = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (url.pathname === "/api/jam/stop" && request.method() === "POST") {
      increment(model, key);
      model.state.active = false;
      model.state.spotify_is_playing = false;
      model.state.now_playing = null;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    errors.push(`unexpected API request: ${key}`);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "unmodeled Phase 2 viewer-test endpoint" }),
    });
  });
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(25);
  expect(runtimeErrors.get(page) || [], "production page must run without runtime errors").toEqual([]);
});

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function openPhaseTwoViewer(page, scenario = {}) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate((options) => window.EchoLayoutTestScenario.install(options), {
    participants: 6,
    cameras: 2,
    screenShares: 1,
    ...scenario,
  });
  await page.evaluate(() => {
    room = {
      localParticipant: {
        identity: "layout-fixture-1",
        name: "Fixture Host",
        publishData: async function() {},
        trackPublications: new Map(),
      },
      remoteParticipants: new Map(),
    };
    adminToken = "phase-2-admin-token";
    currentAccessToken = "phase-2-participant-token";
    ["open-chat", "open-jam", "open-camera-lobby", "open-soundboard", "dock-output", "open-settings"].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = false;
    });
  });
  await nextPaint(page);
}

async function openJam(page) {
  const button = page.locator("#open-jam");
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expect(page.locator("#jam-spotify-status")).toHaveText("Spotify Connected");
  await expect(page.locator("#jam-search-section")).toBeVisible();
}

async function showSourcePcControls(page) {
  await page.evaluate(() => {
    if (_jamPollTimer) {
      clearInterval(_jamPollTimer);
      _jamPollTimer = null;
    }
    _jamSourceLocalControlPending = false;
    _jamSourceLocalControlLegacy = false;
    _jamSourceLocalControl = {
      is_source_host: true,
      takeover_enabled: true,
      monitor_enabled: true,
      takeover_active: true,
      agent_running: true,
      target_device_name: "Phase 2 Spotify fixture",
      last_error: "",
    };
    renderJamSourceLocalControl();
  });
  await expect(page.locator("#jam-panel [data-jam-source-local-card]")).toBeVisible();
}

async function searchJam(page, query = "clubhouse") {
  const input = page.locator("#jam-search-input");
  await input.fill(query);
  await expect(page.locator(".jam-result-item")).toHaveCount(6);
}

async function expectStageModule(page, module) {
  const host = page.locator("#stage-module-host");
  const stage = page.locator(".room-main");
  const activeModule = module === "screens" ? "" : module;
  await expect(host).toHaveAttribute("data-active-module", activeModule);
  if (activeModule) {
    await expect(page.locator("html")).toHaveAttribute("data-stage-module", activeModule);
    await expect(stage).toHaveAttribute("data-active-module", activeModule);
    await expect(stage).toHaveClass(/stage-module-open/);
    await expect(host).toBeVisible();
  } else {
    await expect(page.locator("html")).not.toHaveAttribute("data-stage-module", /.+/);
    await expect(stage).not.toHaveAttribute("data-active-module", /.+/);
    await expect(stage).not.toHaveClass(/stage-module-open/);
    await expect(host).toBeHidden();
  }

  const state = await page.evaluate((activeModule) => {
    const modules = {
      screens: document.getElementById("screen-grid"),
      chat: document.getElementById("chat-panel"),
      jam: document.getElementById("jam-panel"),
      camera: document.getElementById("camera-lobby"),
      soundboard: document.getElementById("soundboard-compact"),
    };
    return Object.fromEntries(Object.entries(modules).map(([name, element]) => [name, {
      ariaHidden: element && element.getAttribute("aria-hidden"),
      hidden: !element || element.classList.contains("hidden"),
      inert: !element || element.inert,
      rendered: !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
      expected: name === activeModule,
    }]));
  }, module);

  for (const [name, value] of Object.entries(state)) {
    expect(value.rendered, `${name} rendered state`).toBe(value.expected);
    expect(value.inert, `${name} inert state`).toBe(!value.expected);
    if (name !== "screens") {
      expect(value.hidden, `${name} hidden class`).toBe(!value.expected);
      expect(value.ariaHidden, `${name} aria-hidden state`).toBe(value.expected ? "false" : "true");
    }
  }
}

async function expectUsersVisible(page, visible) {
  const sidebar = page.locator("#room-sidebar");
  const presentation = await sidebar.evaluate((element) => ({
    ariaHidden: element.getAttribute("aria-hidden"),
    inert: element.inert,
    rendered: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
  }));
  expect(presentation.rendered, "Active Users rendered state").toBe(visible);
  expect(presentation.inert, "Active Users inert state").toBe(!visible);
  expect(presentation.ariaHidden, "Active Users aria-hidden state").toBe(visible ? "false" : "true");
  await expect(page.locator("#shell-toggle-utility")).toHaveAttribute("aria-expanded", String(visible));
}

async function setUsersVisible(page, visible) {
  const toggle = page.locator("#shell-toggle-utility");
  if ((await toggle.getAttribute("aria-expanded")) !== String(visible)) await toggle.click();
  await expectUsersVisible(page, visible);
}

async function resizeTo(page, viewport, expectedMode) {
  await page.setViewportSize(viewport);
  await expect.poll(() => page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))).toEqual(viewport);
  await nextPaint(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", expectedMode);
}

test("changed Stage-module assets share one cache cohort", async ({ page }) => {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  const versions = await page.evaluate((assetNames) => {
    const references = Array.from(document.querySelectorAll("link[href], script[src]"));
    return Object.fromEntries(assetNames.map((assetName) => {
      const reference = references.find((element) => {
        const rawUrl = element.getAttribute("href") || element.getAttribute("src") || "";
        return new URL(rawUrl, location.href).pathname.endsWith(`/${assetName}`);
      });
      const rawUrl = reference && (reference.getAttribute("href") || reference.getAttribute("src"));
      return [assetName, rawUrl ? new URL(rawUrl, location.href).searchParams.get("v") : null];
    }));
  }, [
    "clubhouse-shell.css",
    "phone-presentation.css",
    "phone-presentation.js",
    "state.js",
    "auth.js",
    "soundboard.js",
    "participants-grid.js",
    "grid-layout.js",
    "participants-avatar.js",
    "participants-fullscreen.js",
    "participants.js",
    "audio-routing.js",
    "media-controls.js",
    "connect.js",
    "android-firefox-presentation-recovery-loader.js",
    "app.js",
  ]);
  expect(Object.values(versions).every(Boolean), JSON.stringify(versions, null, 2)).toBe(true);
  expect(new Set(Object.values(versions)).size, JSON.stringify(versions, null, 2)).toBe(1);
});

test("Stage modules preserve their nodes and form state while Active Users remains independent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await page.evaluate(() => {
    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelector(":scope > .tile");
    const video = tile.querySelector("video");
    window.__phase2StageScreenSnapshot = {
      grid,
      mediaStreamTrack: video.srcObject && video.srcObject.getVideoTracks()[0],
      sdkTrack: video._lkTrack,
      srcObject: video.srcObject,
      tile,
      video,
    };
  });

  const structure = await page.evaluate(() => {
    const host = document.getElementById("stage-module-host");
    const stage = document.querySelector(".room-main");
    const jam = document.getElementById("jam-panel");
    window.__phase2JamNode = jam;
    return {
      cameraInsideHost: host.contains(document.getElementById("camera-lobby")),
      chatInsideHost: host.contains(document.getElementById("chat-panel")),
      jamInsideHost: host.contains(jam),
      jamCount: document.querySelectorAll("#jam-panel").length,
      peopleInsideHost: host.contains(document.getElementById("room-sidebar")),
      soundboardInsideHost: host.contains(document.getElementById("soundboard-compact")),
      stageContainsHost: stage.contains(host),
    };
  });
  expect(structure).toEqual({
    cameraInsideHost: true,
    chatInsideHost: true,
    jamInsideHost: true,
    jamCount: 1,
    peopleInsideHost: false,
    soundboardInsideHost: true,
    stageContainsHost: true,
  });
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);

  await page.locator("#open-chat").click();
  await expectStageModule(page, "chat");
  await expectUsersVisible(page, true);
  await page.locator("#chat-input").fill("A clubhouse Chat draft that must survive tool switches");

  await page.keyboard.press("Escape");
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);
  await expect(page.locator("#open-chat")).toBeFocused();

  await openJam(page);
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);
  await page.locator(".room-main").evaluate((stage) => {
    stage.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);
  await searchJam(page);
  await page.locator("#jam-volume-slider").evaluate((input) => {
    input.value = "73";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#jam-volume-value")).toHaveText("73%");
  await page.locator("#jam-browser").evaluate((browser) => { browser.scrollTop = browser.scrollHeight; });
  const jamScrollTop = await page.locator("#jam-browser").evaluate((browser) => browser.scrollTop);
  expect(jamScrollTop).toBeGreaterThan(0);

  await page.locator("#shell-toggle-utility").click();
  await expectUsersVisible(page, false);
  await expectStageModule(page, "jam");

  await page.locator("#shell-toggle-utility").click();
  await expectUsersVisible(page, true);
  await expectStageModule(page, "jam");
  await page.locator("#close-jam").click();
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);
  await page.locator("#open-chat").click();
  await expectStageModule(page, "chat");
  await expect(page.locator("#chat-input")).toHaveValue("A clubhouse Chat draft that must survive tool switches");

  await page.keyboard.press("Escape");
  await page.locator("#open-jam").click();
  await expectStageModule(page, "jam");
  await expect(page.locator("#jam-search-input")).toHaveValue("clubhouse");
  await expect(page.locator(".jam-result-item")).toHaveCount(6);
  await expect(page.locator("#jam-volume-slider")).toHaveValue("73");
  expect(await page.locator("#jam-browser").evaluate((browser) => browser.scrollTop)).toBe(jamScrollTop);
  expect(await page.evaluate(() => window.__phase2JamNode === document.getElementById("jam-panel"))).toBe(true);
  await page.locator("#close-jam").click();
  await expectStageModule(page, "screens");
  expect(await page.evaluate(() => {
    const saved = window.__phase2StageScreenSnapshot;
    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelector(":scope > .tile");
    const video = tile.querySelector("video");
    return {
      grid: saved.grid === grid,
      mediaStreamTrack: saved.mediaStreamTrack === (video.srcObject && video.srcObject.getVideoTracks()[0]),
      sdkTrack: saved.sdkTrack === video._lkTrack,
      srcObject: saved.srcObject === video.srcObject,
      tile: saved.tile === tile && tile.isConnected,
      trackState: saved.mediaStreamTrack.readyState,
      video: saved.video === video && video.isConnected,
    };
  })).toEqual({
    grid: true,
    mediaStreamTrack: true,
    sdkTrack: true,
    srcObject: true,
    tile: true,
    trackState: "live",
    video: true,
  });
});

test("Stage navigation uses stable Users and Back to Stage labels", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);

  const utilityToggle = page.locator("#shell-toggle-utility");
  await expect(utilityToggle).toHaveText("Users");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Hide active users");
  await expect(page.locator("#room-sidebar h2")).toHaveText("Active Users");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "Active Users");
  await expectUsersVisible(page, true);

  await page.locator("#open-chat").click();
  await expectStageModule(page, "chat");
  await expectUsersVisible(page, true);
  await expect(utilityToggle).toHaveText("Users");
  await expect(page.locator("#close-chat")).toHaveText("Back to Stage");
  await page.locator("#close-chat").click();
  await expectStageModule(page, "screens");

  await openJam(page);
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);
  await expect(utilityToggle).toHaveText("Users");
  await expect(page.locator("#close-jam")).toHaveText("Back to Stage");

  await utilityToggle.click();
  await expectUsersVisible(page, false);
  await expectStageModule(page, "jam");
  await expect(utilityToggle).toHaveText("Users");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Show active users");
  await utilityToggle.click();
  await expectUsersVisible(page, true);
  await expectStageModule(page, "jam");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Hide active users");

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#room-sidebar h2")).toHaveText("Active Users");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "People");

  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expect(page.locator("#room-sidebar h2")).toHaveText("Active Users");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "Active Users");
  await expectUsersVisible(page, true);
});

test("Active Users preference is independent from Stage modules across desktop and ultrawide widths", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, {
    cameras: 1,
    participants: 3,
    screenShares: 1,
    shareAspects: [32 / 9],
  });
  await page.evaluate(() => {
    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelector(":scope > .tile");
    const video = tile.querySelector("video");
    window.__phase2ModuleMatrixScreen = {
      grid,
      mediaStreamTrack: video.srcObject && video.srcObject.getVideoTracks()[0],
      sdkTrack: video._lkTrack,
      srcObject: video.srcObject,
      tile,
      video,
    };
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
  ]) {
    await resizeTo(page, viewport, "theater");
    for (const usersVisible of [true, false]) {
      await setUsersVisible(page, usersVisible);
      await page.evaluate(() => window.EchoStageModules.open("jam", null, { focus: false }));
      await expectStageModule(page, "jam");
      await expectUsersVisible(page, usersVisible);

      const geometry = await page.evaluate(() => {
        function rect(element) {
          const bounds = element.getBoundingClientRect();
          return {
            bottom: bounds.bottom,
            left: bounds.left,
            right: bounds.right,
            top: bounds.top,
          };
        }
        return {
          host: rect(document.getElementById("stage-module-host")),
          jam: rect(document.getElementById("jam-panel")),
          stage: rect(document.querySelector(".room-main")),
        };
      });
      for (const region of [geometry.host, geometry.jam]) {
        expect(region.left, `${viewport.width}px module left`).toBeGreaterThanOrEqual(geometry.stage.left - 1);
        expect(region.right, `${viewport.width}px module right`).toBeLessThanOrEqual(geometry.stage.right + 1);
        expect(region.top, `${viewport.width}px module top`).toBeGreaterThanOrEqual(geometry.stage.top - 1);
        expect(region.bottom, `${viewport.width}px module bottom`).toBeLessThanOrEqual(geometry.stage.bottom + 1);
      }

      await page.evaluate(() => window.EchoStageModules.close("jam", { restoreFocus: false }));
      await expectStageModule(page, "screens");
      await expectUsersVisible(page, usersVisible);
    }
  }

  await setUsersVisible(page, true);
  for (const module of ["chat", "jam", "camera", "soundboard"]) {
    await page.evaluate((name) => window.EchoStageModules.open(name, null, { focus: false }), module);
    await expectStageModule(page, module);
    await expectUsersVisible(page, true);
  }
  await page.evaluate(() => window.EchoStageModules.close("soundboard", { restoreFocus: false }));
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);

  expect(await page.evaluate(() => {
    const saved = window.__phase2ModuleMatrixScreen;
    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelector(":scope > .tile");
    const video = tile.querySelector("video");
    return {
      grid: saved.grid === grid,
      mediaStreamTrack: saved.mediaStreamTrack === (video.srcObject && video.srcObject.getVideoTracks()[0]),
      sdkTrack: saved.sdkTrack === video._lkTrack,
      srcObject: saved.srcObject === video.srcObject,
      tile: saved.tile === tile && tile.isConnected,
      trackState: saved.mediaStreamTrack.readyState,
      video: saved.video === video && video.isConnected,
    };
  })).toEqual({
    grid: true,
    mediaStreamTrack: true,
    sdkTrack: true,
    srcObject: true,
    tile: true,
    trackState: "live",
    video: true,
  });
});

test("Soundboard quick play and edit remain one inert-safe Stage module", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  const expectSoundboardSurface = async (activeSurface) => {
    expect(await page.evaluate((expectedSurface) => {
      const surfaces = {
        edit: document.getElementById("soundboard"),
        quick: document.getElementById("soundboard-compact"),
      };
      return Object.fromEntries(Object.entries(surfaces).map(([name, element]) => [name, {
        ariaHidden: element.getAttribute("aria-hidden"),
        hidden: element.classList.contains("hidden"),
        inert: element.inert,
        rendered: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
        expected: name === expectedSurface,
      }]));
    }, activeSurface)).toEqual({
      edit: {
        ariaHidden: activeSurface === "edit" ? "false" : "true",
        expected: activeSurface === "edit",
        hidden: activeSurface !== "edit",
        inert: activeSurface !== "edit",
        rendered: activeSurface === "edit",
      },
      quick: {
        ariaHidden: activeSurface === "quick" ? "false" : "true",
        expected: activeSurface === "quick",
        hidden: activeSurface !== "quick",
        inert: activeSurface !== "quick",
        rendered: activeSurface === "quick",
      },
    });
  };

  await expectStageModule(page, "screens");
  await expectSoundboardSurface(null);
  await expectUsersVisible(page, true);

  await page.locator("#open-soundboard").click();
  await expectStageModule(page, "soundboard");
  await expectSoundboardSurface("quick");
  await expectUsersVisible(page, true);

  await page.locator("#shell-toggle-utility").click();
  await expectUsersVisible(page, false);
  await page.locator("#open-soundboard-edit").click();
  await expect(page.locator("#back-to-soundboard")).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-stage-module", "soundboard");
  await expect(page.locator(".room-main")).toHaveClass(/stage-module-open/);
  await expect(page.locator("#stage-module-host")).toHaveAttribute("data-active-module", "soundboard");
  await expectSoundboardSurface("edit");
  await expectUsersVisible(page, false);

  await page.locator("#back-to-soundboard").click();
  await expect(page.locator("#open-soundboard-edit")).toBeFocused();
  await expectStageModule(page, "soundboard");
  await expectSoundboardSurface("quick");
  await expectUsersVisible(page, false);
  await page.locator("#close-soundboard").click();
  await expectStageModule(page, "screens");
  await expectSoundboardSurface(null);
  await expectUsersVisible(page, false);
});

test("Soundboard Quick Play and Edit remain reachable at short and narrow Stage sizes", async ({ page }) => {
  const viewports = [
    { width: 640, height: 360 },
    { width: 844, height: 390 },
    { width: 360, height: 640 },
  ];

  await page.setViewportSize(viewports[0]);
  await openPhaseTwoViewer(page);
  await page.evaluate(() => {
    currentRoomName = null;
    soundboardSounds.clear();
    for (let index = 1; index <= 48; index += 1) {
      soundboardSounds.set(`phase2-sound-${index}`, {
        icon: "🔊",
        id: `phase2-sound-${index}`,
        name: `Fixture Sound ${String(index).padStart(2, "0")}`,
        volume: 100,
      });
    }
  });

  const expectLastQuickSoundReachable = async (label) => {
    await page.evaluate(() => {
      const panel = document.getElementById("soundboard-compact");
      const grid = document.getElementById("soundboard-compact-grid");
      panel.scrollTop = panel.scrollHeight;
      grid.scrollTop = grid.scrollHeight;
    });
    await nextPaint(page);
    const geometry = await page.evaluate(() => {
      const panel = document.getElementById("soundboard-compact");
      const grid = document.getElementById("soundboard-compact-grid");
      const last = grid.lastElementChild;
      const panelRect = panel.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const lastRect = last.getBoundingClientRect();
      return {
        gridClientHeight: grid.clientHeight,
        gridOverflowsVertically: grid.scrollHeight > grid.clientHeight + 1,
        lastVisible: lastRect.top >= Math.max(panelRect.top, gridRect.top) - 1 &&
          lastRect.bottom <= Math.min(panelRect.bottom, gridRect.bottom) + 1,
        panelHasNoHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
      };
    });
    expect(geometry.gridClientHeight, `${label} Quick Play grid height`).toBeGreaterThanOrEqual(60);
    expect(geometry.gridOverflowsVertically, `${label} Quick Play grid overflow`).toBe(true);
    expect(geometry.lastVisible, `${label} final Quick Play sound`).toBe(true);
    expect(geometry.panelHasNoHorizontalOverflow, `${label} Quick Play horizontal overflow`).toBe(true);
  };

  for (const viewport of viewports) {
    const label = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await nextPaint(page);
    await page.locator("#open-soundboard").click();
    await expectStageModule(page, "soundboard");
    await page.evaluate(() => {
      document.getElementById("soundboard-compact").scrollTop = 0;
    });
    await nextPaint(page);

    const quick = await page.evaluate(() => {
      const panel = document.getElementById("soundboard-compact");
      const panelRect = panel.getBoundingClientRect();
      const contained = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 &&
          rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1;
      };
      return {
        ariaHidden: panel.getAttribute("aria-hidden"),
        controlsContained: [
          "#close-soundboard",
          "#open-soundboard-edit",
          "#toggle-soundboard-volume-compact",
          "#soundboard-compact-search",
        ].every(contained),
        inert: panel.inert,
        noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
      };
    });
    expect(quick, `${label} initial Quick Play geometry`).toEqual({
      ariaHidden: "false",
      controlsContained: true,
      inert: false,
      noHorizontalOverflow: true,
    });
    await expectLastQuickSoundReachable(label);

    await page.locator("#toggle-soundboard-volume-compact").click();
    await expect(page.locator("#toggle-soundboard-volume-compact")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#soundboard-volume-panel-compact")).toHaveAttribute("aria-hidden", "false");
    await expectLastQuickSoundReachable(`${label} expanded volume`);
    await page.locator("#toggle-soundboard-volume-compact").click();
    await expect(page.locator("#toggle-soundboard-volume-compact")).toHaveAttribute("aria-expanded", "false");

    await page.locator("#open-soundboard-edit").click();
    await expect(page.locator("#back-to-soundboard")).toBeFocused();
    await page.evaluate(() => {
      document.getElementById("soundboard").scrollTop = 0;
    });
    await nextPaint(page);
    const edit = await page.evaluate(() => {
      const panel = document.getElementById("soundboard");
      const panelRect = panel.getBoundingClientRect();
      const contained = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 &&
          rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1;
      };
      return {
        ariaHidden: panel.getAttribute("aria-hidden"),
        controlsContained: [
          "#toggle-soundboard-volume",
          "#back-to-soundboard",
          "#close-soundboard-stage",
        ].every(contained),
        inert: panel.inert,
        noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
        verticallyScrollable: panel.scrollHeight > panel.clientHeight + 1,
      };
    });
    expect(edit, `${label} initial Edit geometry`).toEqual({
      ariaHidden: "false",
      controlsContained: true,
      inert: false,
      noHorizontalOverflow: true,
      verticallyScrollable: true,
    });

    await page.evaluate(() => {
      const panel = document.getElementById("soundboard");
      panel.scrollTop = panel.scrollHeight;
    });
    await nextPaint(page);
    const upload = await page.evaluate(() => {
      const panel = document.getElementById("soundboard");
      const panelRect = panel.getBoundingClientRect();
      const uploadPanel = panel.querySelector(".soundboard-upload");
      const uploadRect = uploadPanel.getBoundingClientRect();
      const contained = (selector) => {
        const rect = panel.querySelector(selector).getBoundingClientRect();
        return rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1 &&
          rect.top >= panelRect.top - 1 && rect.bottom <= panelRect.bottom + 1;
      };
      return {
        controlsContained: [
          "#sound-name",
          "#sound-upload-button",
          ".sound-file",
          "#sound-clip-volume",
        ].every(contained),
        fullyVisible: uploadRect.left >= panelRect.left - 1 && uploadRect.right <= panelRect.right + 1 &&
          uploadRect.top >= panelRect.top - 1 && uploadRect.bottom <= panelRect.bottom + 1,
        height: uploadRect.height,
        noHorizontalOverflow: panel.scrollWidth <= panel.clientWidth + 1,
      };
    });
    expect(upload.controlsContained, `${label} Edit upload controls`).toBe(true);
    expect(upload.fullyVisible, `${label} Edit upload section`).toBe(true);
    expect(upload.height, `${label} Edit upload natural height`).toBeGreaterThanOrEqual(120);
    expect(upload.noHorizontalOverflow, `${label} Edit horizontal overflow after scroll`).toBe(true);

    await page.locator("#close-soundboard-stage").click();
    await expectStageModule(page, "screens");
    await expectUsersVisible(page, true);
  }
});

test("legacy rollback repairs module geometry, opener ownership, and the latest legacy intent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  await page.evaluate(() => {
    const opener = document.createElement("button");
    opener.id = "phase2-transient-jam-opener";
    opener.type = "button";
    opener.textContent = "Transient Jam";
    document.querySelector(".room-top").appendChild(opener);
    openJamPanel(opener);
  });
  await expectStageModule(page, "jam");

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expect(page.locator("#open-jam")).toHaveAttribute("aria-controls", "jam-panel");
  await expect(page.locator("#phase2-transient-jam-opener")).toHaveAttribute("aria-controls", "jam-panel");
  await expect(page.locator("#stage-module-host")).toHaveAttribute("aria-hidden", "true");
  expect(await page.locator("#stage-module-host").evaluate((host) => host.childElementCount)).toBe(0);

  await page.evaluate(() => closeJamPanel());
  await expect(page.locator("#jam-panel")).toBeHidden();
  expect(await page.evaluate(() => window.EchoStageModules.activeModule())).toBeNull();
  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expectStageModule(page, "screens");
  await expect(page.locator("#open-jam")).toHaveAttribute("aria-controls", "stage-module-host");

  await page.locator("#open-soundboard").click();
  await expectStageModule(page, "soundboard");
  await page.evaluate(() => {
    window.__phase2LegacySoundboardNode = document.getElementById("soundboard-compact");
    window.EchoUiShell.applyVariant("legacy");
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#soundboard-compact")).toBeVisible();

  const legacySoundboard = await page.evaluate(() => {
    const opener = document.getElementById("open-soundboard");
    const panel = document.getElementById("soundboard-compact");
    const openerRect = opener.getBoundingClientRect();
    return {
      expectedRight: window.innerWidth - openerRect.right,
      expectedTop: openerRect.bottom + 6,
      right: Number.parseFloat(panel.style.right),
      sameNode: window.__phase2LegacySoundboardNode === panel,
      top: Number.parseFloat(panel.style.top),
    };
  });
  expect(legacySoundboard.sameNode).toBe(true);
  expect(legacySoundboard.top).toBeCloseTo(legacySoundboard.expectedTop, 1);
  expect(legacySoundboard.right).toBeCloseTo(legacySoundboard.expectedRight, 1);
  for (const [opener, controlled] of [
    ["#open-chat", "chat-panel"],
    ["#open-jam", "jam-panel"],
    ["#open-camera-lobby", "camera-lobby"],
    ["#open-soundboard", "soundboard-compact"],
  ]) {
    await expect(page.locator(opener)).toHaveAttribute("aria-controls", controlled);
  }

  await page.evaluate(() => openChat());
  await expect(page.locator("#chat-panel")).toBeVisible();
  expect(await page.evaluate(() => window.EchoStageModules.activeModule())).toBe("chat");
  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expectStageModule(page, "chat");
  await expect(page.locator("#soundboard-compact")).toBeHidden();
  await page.evaluate(() => window.EchoStageModules.close("chat", { restoreFocus: false }));
  await expectStageModule(page, "screens");
});

test("leaving Jam pauses its visualizer and a removed opener falls back to canonical focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  await page.evaluate(() => {
    window.__phase2OriginalJamVisualizerController = window._jamAudioVisualizerController;
    window.__phase2JamPauseCalls = 0;
    window._jamAudioVisualizerController = {
      pause() {
        window.__phase2JamPauseCalls += 1;
      },
    };
    window.EchoStageModules.open("jam", null, { focus: false });
  });
  await expectStageModule(page, "jam");

  await page.evaluate(() => window.EchoStageModules.open("chat", null, { focus: false }));
  await expectStageModule(page, "chat");
  expect(await page.evaluate(() => window.__phase2JamPauseCalls)).toBeGreaterThan(0);
  await page.evaluate(() => {
    window.EchoStageModules.close("chat", { restoreFocus: false });
    window._jamAudioVisualizerController = window.__phase2OriginalJamVisualizerController;
    delete window.__phase2OriginalJamVisualizerController;
    delete window.__phase2JamPauseCalls;
  });
  await expectStageModule(page, "screens");

  await page.evaluate(() => {
    const opener = document.createElement("button");
    opener.id = "phase2-removed-jam-opener";
    opener.type = "button";
    opener.textContent = "Temporary Jam opener";
    document.querySelector(".room-top").appendChild(opener);
    window.EchoStageModules.open("jam", opener, { focus: false });
  });
  await expectStageModule(page, "jam");
  await page.evaluate(() => {
    document.getElementById("phase2-removed-jam-opener").remove();
    window.EchoStageModules.close("jam");
  });
  await expectStageModule(page, "screens");
  await expect(page.locator("#open-jam")).toBeFocused();
});

test("Camera Lobby teardown is isolated from avatar and Stage media across module and Room changes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, { cameras: 2, participants: 4, screenShares: 1 });
  await page.evaluate(() => window.EchoLayoutTestScenario.captureIdentitySnapshot());

  await page.evaluate(() => {
    window.__phase2MakeLobbyParticipant = function(identity, color) {
      const LK = getLiveKitClient();
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const mediaStreamTrack = canvas.captureStream(1).getVideoTracks()[0];
      const sdkTrack = {
        detachCalls: 0,
        detach: function() { this.detachCalls += 1; },
        mediaStreamTrack,
        sid: identity + "-camera",
      };
      const publication = {
        kind: LK.Track.Kind.Video,
        source: LK.Track.Source.Camera,
        track: sdkTrack,
        trackSid: sdkTrack.sid,
      };
      return {
        canvas,
        participant: {
          identity,
          name: identity,
          trackPublications: new Map([[publication.trackSid, publication]]),
        },
        sdkTrack,
      };
    };
    window.__phase2OldLobbyMedia = window.__phase2MakeLobbyParticipant("old-room-camera", "#7c3aed");
    room = {
      localParticipant: window.__phase2OldLobbyMedia.participant,
      remoteParticipants: new Map(),
    };
  });

  const mediaKeys = [
    "cameraStream", "cameraSdkTrack", "cameraTrack", "cameraVideo",
    "participantCard", "participantState", "screenStream", "screenSdkTrack",
    "screenTile", "screenTrack", "screenVideo",
  ];
  for (const module of ["jam", "chat", "soundboard"]) {
    await page.evaluate(() => openCameraLobby());
    await expectStageModule(page, "camera");
    await expect(page.locator("#camera-lobby-grid > .camera-lobby-tile")).toHaveCount(1);
    await page.locator("#camera-lobby-grid > .camera-lobby-tile").click();
    await expect(page.locator("#camera-lobby-grid > .camera-lobby-tile")).toHaveClass(/enlarged/);
    await page.evaluate(() => {
      window.__phase2DepartingLobbyVideo = document.querySelector("#camera-lobby-grid video");
    });

    await page.evaluate((nextModule) => {
      window.EchoStageModules.open(nextModule, null, { focus: false });
    }, module);
    await expectStageModule(page, module);
    await expect(page.locator("#camera-lobby-grid > .camera-lobby-tile")).toHaveCount(0);
    expect(await page.evaluate(() => ({
      connected: window.__phase2DepartingLobbyVideo.isConnected,
      lkTrack: window.__phase2DepartingLobbyVideo._lkTrack,
      srcObject: window.__phase2DepartingLobbyVideo.srcObject,
    }))).toEqual({ connected: false, lkTrack: null, srcObject: null });

    const identity = await page.evaluate(() => window.EchoLayoutTestScenario.inspectIdentitySnapshot());
    for (const key of mediaKeys) expect(identity[key], `${module} preserves ${key}`).toBe(true);
    await page.evaluate((activeModule) => {
      window.EchoStageModules.close(activeModule, { restoreFocus: false });
    }, module);
    await expectStageModule(page, "screens");
  }

  await page.evaluate(() => openCameraLobby());
  await expectStageModule(page, "camera");
  await page.evaluate(() => {
    window.__phase2OldRoomLobbyVideo = document.querySelector("#camera-lobby-grid video");
    const next = window.__phase2MakeLobbyParticipant("new-room-camera", "#0f766e");
    window.__phase2NewLobbyMedia = next;
    const nextRoom = { localParticipant: next.participant, remoteParticipants: new Map() };
    clearMedia();
    room = nextRoom;
    refreshActiveCameraLobbyForRoom(nextRoom);
  });
  await expectStageModule(page, "camera");
  await expect(page.locator('#camera-lobby-grid > .camera-lobby-tile[data-identity="new-room-camera"]')).toHaveCount(1);
  expect(await page.evaluate(() => ({
    detachCalls: window.__phase2OldLobbyMedia.sdkTrack.detachCalls,
    oldConnected: window.__phase2OldRoomLobbyVideo.isConnected,
    oldReadyState: window.__phase2OldLobbyMedia.sdkTrack.mediaStreamTrack.readyState,
    oldSrcObject: window.__phase2OldRoomLobbyVideo.srcObject,
    staleEnlarged: !!document.querySelector("#camera-lobby-grid > .enlarged"),
  }))).toEqual({
    detachCalls: 4,
    oldConnected: false,
    oldReadyState: "live",
    oldSrcObject: null,
    staleEnlarged: false,
  });
});

test("hidden Stage grid mutations recover after rapid module reopen on ultrawide displays", async ({ page }) => {
  await page.setViewportSize({ width: 3440, height: 1440 });
  await openPhaseTwoViewer(page, { cameras: 1, participants: 3, screenShares: 1, shareAspects: [32 / 9] });

  for (const viewport of [
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
  ]) {
    await resizeTo(page, viewport, "theater");
    await page.evaluate(() => {
      const grid = document.getElementById("screen-grid");
      const originalTile = grid.querySelector(":scope > .tile");
      const originalVideo = originalTile.querySelector("video");
      window.__phase2HiddenGridSnapshot = {
        grid,
        mediaStreamTrack: originalVideo.srcObject.getVideoTracks()[0],
        sdkTrack: originalVideo._lkTrack,
        srcObject: originalVideo.srcObject,
        tile: originalTile,
        video: originalVideo,
      };
      window.EchoStageModules.open("jam", null, { focus: false });
      const lateTile = document.createElement("article");
      lateTile.className = "tile";
      lateTile.dataset.identity = "late-ultrawide-share";
      lateTile.dataset.mediaKind = "screen";
      lateTile.style.setProperty("--screen-source-aspect-ratio", String(16 / 9));
      const title = document.createElement("h3");
      title.textContent = "Late ultrawide share";
      lateTile.appendChild(title);
      grid.appendChild(lateTile);
      window.__phase2LateGridTile = lateTile;
    });
    await expectStageModule(page, "jam");
    // Drain the grid observer's delayed insertion retries, then model the exact
    // zero-visible state a hidden measurement can publish. The final close must
    // repair this state on its own; no insertion retry remains to mask a miss.
    await page.waitForTimeout(1100);
    await page.evaluate(() => {
      const grid = document.getElementById("screen-grid");
      grid.dataset.visibleTiles = "0";
      grid.style.gridTemplateColumns = "";
      grid.style.gridTemplateRows = "";
      grid.querySelectorAll(":scope > .tile").forEach((tile) => {
        tile.removeAttribute("data-grid-visible");
        tile.style.width = "";
        tile.style.height = "";
      });
    });
    await expect(page.locator("#screen-grid")).toHaveAttribute("data-visible-tiles", "0");

    await page.evaluate(() => {
      window.EchoStageModules.close("jam", { restoreFocus: false });
      window.EchoStageModules.open("jam", null, { focus: false });
    });
    await expectStageModule(page, "jam");
    await page.evaluate(() => window.EchoStageModules.close("jam", { restoreFocus: false }));
    await expectStageModule(page, "screens");
    await expect.poll(() => page.locator("#screen-grid").getAttribute("data-visible-tiles")).toBe("2");
    await expect(page.locator("#screen-grid > .tile[data-grid-visible]")).toHaveCount(2);
    await expect.poll(() => page.locator("#screen-grid").evaluate((grid) => grid.style.gridTemplateColumns)).not.toBe("");

    expect(await page.evaluate(() => {
      const saved = window.__phase2HiddenGridSnapshot;
      const video = saved.tile.querySelector("video");
      return {
        grid: saved.grid === document.getElementById("screen-grid"),
        mediaStreamTrack: saved.mediaStreamTrack === video.srcObject.getVideoTracks()[0],
        sdkTrack: saved.sdkTrack === video._lkTrack,
        srcObject: saved.srcObject === video.srcObject,
        tile: saved.tile.isConnected,
        video: saved.video === video && video.isConnected,
      };
    })).toEqual({
      grid: true,
      mediaStreamTrack: true,
      sdkTrack: true,
      srcObject: true,
      tile: true,
      video: true,
    });

    await page.evaluate(() => {
      window.__phase2LateGridTile.remove();
      window._echoRecalcGrid();
    });
    await expect.poll(() => page.locator("#screen-grid").getAttribute("data-visible-tiles")).toBe("1");
  }
});

test("short landscape keeps every Stage module and Active Users independently usable", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 360 });
  await openPhaseTwoViewer(page);

  for (const viewport of [
    { width: 640, height: 360 },
    { width: 844, height: 390 },
  ]) {
    await resizeTo(page, viewport, "mini");
    await expect(page.locator("html")).toHaveAttribute("data-ui-short", "");
    for (const module of ["chat", "jam", "camera", "soundboard"]) {
      await page.evaluate((name) => window.EchoStageModules.open(name, null, { focus: false }), module);
      await expectStageModule(page, module);
      await expectUsersVisible(page, true);
      const geometry = await page.evaluate(() => {
        const stage = document.querySelector(".room-main").getBoundingClientRect();
        const users = document.getElementById("room-sidebar").getBoundingClientRect();
        const host = document.getElementById("stage-module-host").getBoundingClientRect();
        return {
          host: { bottom: host.bottom, left: host.left, right: host.right, top: host.top },
          stage: { bottom: stage.bottom, height: stage.height, left: stage.left, right: stage.right, top: stage.top, width: stage.width },
          users: { bottom: users.bottom, height: users.height, left: users.left, right: users.right, top: users.top, width: users.width },
        };
      });
      expect(geometry.stage.width).toBeGreaterThanOrEqual(300);
      expect(geometry.stage.height).toBeGreaterThanOrEqual(180);
      expect(geometry.users.width).toBeGreaterThanOrEqual(219);
      expect(geometry.users.height).toBeGreaterThanOrEqual(180);
      expect(geometry.stage.right).toBeLessThanOrEqual(geometry.users.left + 1);
      expect(geometry.host.left).toBeGreaterThanOrEqual(geometry.stage.left - 1);
      expect(geometry.host.right).toBeLessThanOrEqual(geometry.stage.right + 1);
      await page.evaluate((name) => window.EchoStageModules.close(name, { restoreFocus: false }), module);
      await expectStageModule(page, "screens");
      await expectUsersVisible(page, true);
    }
  }
});

test("one participant's 32:9 screen and camera remain independent Stage tiles", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, {
    cameras: 1,
    participants: 3,
    screenOwners: [2],
    screenShares: 1,
    shareAspects: [32 / 9],
  });

  const identity = "layout-fixture-2";
  const card = page.locator(`.user-card[data-identity="${identity}"]`);
  await expect(card).toHaveClass(/has-camera/);
  await page.evaluate((participantIdentity) => {
    const cardRef = participantCards.get(participantIdentity);
    const cardElement = document.querySelector(`.user-card[data-identity="${participantIdentity}"]`);
    const sourceVideo = cardElement.querySelector("video");
    const track = sourceVideo._lkTrack;
    const LK = getLiveKitClient();
    const publication = {
      kind: LK.Track.Kind.Video,
      source: LK.Track.Source.Camera,
      track,
      trackSid: track.sid,
    };
    const participant = {
      identity: participantIdentity,
      name: "Friend 2",
      trackPublications: new Map([[publication.trackSid, publication]]),
    };
    room.remoteParticipants.set(participantIdentity, participant);
    cardRef.setCameraStageAvailable(true);
    const screenTile = screenTileByIdentity.get(participantIdentity);
    const screenVideo = screenTile.querySelector("video");
    window.__phase2MixedStageSnapshot = {
      cameraSdkTrack: track,
      cameraSourceMediaTrack: sourceVideo.srcObject && sourceVideo.srcObject.getVideoTracks()[0],
      cameraSourceStream: sourceVideo.srcObject,
      cameraSourceVideo: sourceVideo,
      screenMediaTrack: screenVideo.srcObject && screenVideo.srcObject.getVideoTracks()[0],
      screenSdkTrack: screenVideo._lkTrack,
      screenStream: screenVideo.srcObject,
      screenTile,
      screenVideo,
    };
  }, identity);

  const settingsToggle = card.locator(".participant-settings-toggle");
  await settingsToggle.click();
  const settings = card.locator(".participant-settings-popover");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Show Friend 2's camera on my Stage" }).click();

  const screenTile = page.locator(`#screen-grid > .tile[data-media-kind="screen"][data-identity="${identity}"]`);
  const cameraTile = page.locator(`#screen-grid > .tile[data-media-kind="camera"][data-identity="${identity}"]`);
  await expect(screenTile).toBeVisible();
  await expect(cameraTile).toBeVisible();
  await expect(page.locator("#screen-grid > .tile[data-grid-visible]")).toHaveCount(2);

  expect(await page.evaluate((participantIdentity) => {
    const saved = window.__phase2MixedStageSnapshot;
    const currentSourceVideo = document.querySelector(
      `.user-card[data-identity="${participantIdentity}"] video`,
    );
    const stageVideo = cameraStageTileByIdentity.get(participantIdentity).querySelector("video");
    return {
      distinctVideo: stageVideo !== currentSourceVideo,
      mediaTrackShared: saved.cameraSourceMediaTrack ===
        (stageVideo.srcObject && stageVideo.srcObject.getVideoTracks()[0]),
      sdkTrackShared: saved.cameraSdkTrack === stageVideo._lkTrack,
      sourceStreamPreserved: saved.cameraSourceStream === currentSourceVideo.srcObject,
      sourceTrackLive: saved.cameraSourceMediaTrack.readyState,
      sourceVideoPreserved: saved.cameraSourceVideo === currentSourceVideo && currentSourceVideo.isConnected,
    };
  }, identity)).toEqual({
    distinctVideo: true,
    mediaTrackShared: true,
    sdkTrackShared: true,
    sourceStreamPreserved: true,
    sourceTrackLive: "live",
    sourceVideoPreserved: true,
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
  ]) {
    await resizeTo(page, viewport, "theater");
    await expect.poll(() => page.evaluate(() => document.getElementById("screen-grid").style.gridTemplateColumns))
      .not.toBe("");
    const geometry = await page.evaluate((participantIdentity) => {
      function rect(element) {
        const bounds = element.getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      }
      const grid = document.getElementById("screen-grid");
      const screen = grid.querySelector(
        `:scope > .tile[data-media-kind="screen"][data-identity="${participantIdentity}"]`,
      );
      const camera = grid.querySelector(
        `:scope > .tile[data-media-kind="camera"][data-identity="${participantIdentity}"]`,
      );
      const screenRect = rect(screen);
      const cameraRect = rect(camera);
      const overlapWidth = Math.max(0, Math.min(screenRect.right, cameraRect.right) -
        Math.max(screenRect.left, cameraRect.left));
      const overlapHeight = Math.max(0, Math.min(screenRect.bottom, cameraRect.bottom) -
        Math.max(screenRect.top, cameraRect.top));
      return {
        camera: cameraRect,
        cameraFit: getComputedStyle(camera.querySelector("video")).objectFit,
        grid: rect(grid),
        overlapArea: overlapWidth * overlapHeight,
        screen: screenRect,
        screenFit: getComputedStyle(screen.querySelector("video")).objectFit,
      };
    }, identity);
    for (const region of [geometry.screen, geometry.camera]) {
      expect(region.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
      expect(region.right).toBeLessThanOrEqual(geometry.grid.right + 1);
      expect(region.top).toBeGreaterThanOrEqual(geometry.grid.top - 1);
      expect(region.bottom).toBeLessThanOrEqual(geometry.grid.bottom + 1);
    }
    expect(geometry.overlapArea).toBeLessThanOrEqual(1);
    expect(geometry.screen.width / geometry.screen.height).toBeCloseTo(32 / 9, 2);
    expect(geometry.camera.width / geometry.camera.height).toBeCloseTo(16 / 9, 2);
    expect(geometry.screenFit).toBe("contain");
    expect(geometry.cameraFit).toBe("contain");
  }

  await page.evaluate(() => window.EchoStageModules.open("jam", null, { focus: false }));
  await expectStageModule(page, "jam");
  await page.evaluate(() => window.EchoStageModules.close("jam", { restoreFocus: false }));
  await expectStageModule(page, "screens");
  expect(await page.evaluate((participantIdentity) => {
    const saved = window.__phase2MixedStageSnapshot;
    const currentScreenTile = screenTileByIdentity.get(participantIdentity);
    const currentScreenVideo = currentScreenTile.querySelector("video");
    const currentCameraTile = cameraStageTileByIdentity.get(participantIdentity);
    return {
      cameraTile: !!currentCameraTile && currentCameraTile.isConnected,
      screenMediaTrack: saved.screenMediaTrack ===
        (currentScreenVideo.srcObject && currentScreenVideo.srcObject.getVideoTracks()[0]),
      screenSdkTrack: saved.screenSdkTrack === currentScreenVideo._lkTrack,
      screenStream: saved.screenStream === currentScreenVideo.srcObject,
      screenTile: saved.screenTile === currentScreenTile && currentScreenTile.isConnected,
      screenVideo: saved.screenVideo === currentScreenVideo && currentScreenVideo.isConnected,
    };
  }, identity)).toEqual({
    cameraTile: true,
    screenMediaTrack: true,
    screenSdkTrack: true,
    screenStream: true,
    screenTile: true,
    screenVideo: true,
  });

  if (!(await settings.isVisible())) await settingsToggle.click();
  await settings.getByRole("button", { name: /Hide the shared screen from Friend 2 on my Stage/i }).click();
  await expect(screenTile).toBeHidden();
  await expect(cameraTile).toBeVisible();
  await settings.getByRole("button", { name: /Show the shared screen from Friend 2 on my Stage/i }).click();
  await expect(screenTile).toBeVisible();
  await settings.getByRole("button", { name: "Hide Friend 2's camera from my Stage" }).click();
  await expect(cameraTile).toHaveCount(0);
  await expect(screenTile).toBeVisible();

  expect(await page.evaluate(() => {
    const saved = window.__phase2MixedStageSnapshot;
    return {
      cameraIntentCount: stagedCameraIdentities.size,
      cameraTileCount: cameraStageTileByIdentity.size,
      sourceTrackState: saved.cameraSourceMediaTrack.readyState,
      sourceVideo: saved.cameraSourceVideo.isConnected,
      sourceVideoTrack: saved.cameraSourceMediaTrack ===
        (saved.cameraSourceVideo.srcObject && saved.cameraSourceVideo.srcObject.getVideoTracks()[0]),
    };
  })).toEqual({
    cameraIntentCount: 0,
    cameraTileCount: 0,
    sourceTrackState: "live",
    sourceVideo: true,
    sourceVideoTrack: true,
  });
});

test("Ultra Instinct keeps the Goku GIF visible through the Phase 2 stage", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPhaseTwoViewer(page, { screenShares: 0 });
  await page.evaluate(() => applyTheme("ultra-instinct"));

  const presentation = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const stageStyle = getComputedStyle(document.querySelector(".room-main"));
    const alphaMatch = stageStyle.backgroundColor.match(
      /(?:rgba\([^,]+,[^,]+,[^,]+,\s*|\/\s*)([0-9.]+)\s*\)/
    );
    return {
      bodyBackground: bodyStyle.backgroundImage,
      particleCanvases: document.querySelectorAll("#ui-particles").length,
      stageAlpha: alphaMatch ? Number(alphaMatch[1]) : 1,
    };
  });
  expect(presentation.bodyBackground).toContain("ultrainstinct.gif");
  expect(presentation.particleCanvases).toBe(1);
  expect(presentation.stageAlpha).toBeGreaterThan(0);
  expect(presentation.stageAlpha).toBeLessThan(1);

  const gif = await page.evaluate(() => new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({ height: image.naturalHeight, width: image.naturalWidth }), { once: true });
    image.addEventListener("error", () => resolve({ height: 0, width: 0 }), { once: true });
    image.src = `ultrainstinct.gif?phase2-test=${Date.now()}`;
  }));
  expect(gif.width).toBeGreaterThan(0);
  expect(gif.height).toBeGreaterThan(0);

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toContain("ultrainstinct.gif");
});

test("empty Stage crest is large, naturally proportioned, and contained", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, { screenShares: 0 });

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    const presentation = await page.locator("#screen-grid").evaluate((grid) => {
      const gridRect = grid.getBoundingClientRect();
      const stageRect = grid.closest(".room-main").getBoundingClientRect();
      const pseudo = getComputedStyle(grid, "::before");
      return {
        backgroundImage: pseudo.backgroundImage,
        backgroundSize: pseudo.backgroundSize,
        content: pseudo.content,
        grid: { bottom: gridRect.bottom, left: gridRect.left, right: gridRect.right, top: gridRect.top },
        paddingTop: Number.parseFloat(pseudo.paddingTop),
        stage: { bottom: stageRect.bottom, left: stageRect.left, right: stageRect.right, top: stageRect.top },
        tiles: grid.querySelectorAll(":scope > .tile").length,
      };
    });
    expect(presentation.tiles).toBe(0);
    expect(presentation.content).toContain("No one is sharing");
    expect(presentation.backgroundImage).toContain("badge.jpg");
    expect(presentation.backgroundSize).toContain("auto");
    expect(presentation.backgroundSize).not.toContain("58px 58px");
    expect(presentation.paddingTop).toBeGreaterThanOrEqual(135);
    expect(presentation.grid.left).toBeGreaterThanOrEqual(presentation.stage.left - 1);
    expect(presentation.grid.right).toBeLessThanOrEqual(presentation.stage.right + 1);
    expect(presentation.grid.top).toBeGreaterThanOrEqual(presentation.stage.top - 1);
    expect(presentation.grid.bottom).toBeLessThanOrEqual(presentation.stage.bottom + 1);
  }

  const badge = await page.evaluate(() => new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({ height: image.naturalHeight, width: image.naturalWidth }), { once: true });
    image.addEventListener("error", () => resolve({ height: 0, width: 0 }), { once: true });
    image.src = `badge.jpg?empty-stage-test=${Date.now()}`;
  }));
  expect(badge.width / badge.height).toBeGreaterThan(1.8);
  expect(badge.width / badge.height).toBeLessThan(2);
});

test("People actions stay visible and contained in the theater rail and mini sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    await expectStageModule(page, "screens");
    await expectUsersVisible(page, true);
    const geometry = await page.evaluate(() => {
      const sidebar = document.getElementById("room-sidebar").getBoundingClientRect();
      const titleRow = document.querySelector("#room-sidebar .sidebar-title-row");
      const participantAvatar = document.querySelector("#room-sidebar .user-card:not(.has-camera) .user-avatar");
      const actions = Array.from(document.querySelectorAll("#room-sidebar .sidebar-actions button"))
        .filter((button) => getComputedStyle(button).display !== "none")
        .map((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            bottom: rect.bottom,
            height: rect.height,
            hit: hit === button || button.contains(hit),
            id: button.id,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          };
        });
      return {
        actions,
        compactLabels: ["open-soundboard", "open-camera-lobby"].map((id) => {
          const button = document.getElementById(id);
          return {
            after: getComputedStyle(button, "::after").content,
            before: getComputedStyle(button, "::before").content,
            fontSize: getComputedStyle(button).fontSize,
          };
        }),
        participantAvatarWidth: participantAvatar?.getBoundingClientRect().width || 0,
        sidebar: { bottom: sidebar.bottom, left: sidebar.left, right: sidebar.right, top: sidebar.top, width: sidebar.width },
        titleOverflow: titleRow.scrollWidth - titleRow.clientWidth,
      };
    });

    expect(geometry.actions).toHaveLength(7);
    if (expectedMode === "theater") {
      expect(geometry.sidebar.width).toBeGreaterThanOrEqual(299.5);
      expect(geometry.sidebar.width).toBeLessThanOrEqual(328.5);
    }
    expect(geometry.participantAvatarWidth).toBeGreaterThanOrEqual(53.5);
    expect(geometry.titleOverflow).toBeLessThanOrEqual(1);
    expect(geometry.compactLabels).toEqual([
      { after: "none", before: '"Sounds"', fontSize: "0px" },
      { after: "none", before: '"Cameras"', fontSize: "0px" },
    ]);
    for (const action of geometry.actions) {
      expect(action.left, `${action.id} left at ${viewport.width}px`).toBeGreaterThanOrEqual(geometry.sidebar.left - 1);
      expect(action.right, `${action.id} right at ${viewport.width}px`).toBeLessThanOrEqual(geometry.sidebar.right + 1);
      expect(action.top, `${action.id} top at ${viewport.width}px`).toBeGreaterThanOrEqual(geometry.sidebar.top - 1);
      expect(action.bottom, `${action.id} bottom at ${viewport.width}px`).toBeLessThanOrEqual(geometry.sidebar.bottom + 1);
      expect(action.width, `${action.id} width at ${viewport.width}px`).toBeGreaterThanOrEqual(39.5);
      expect(action.height, `${action.id} height at ${viewport.width}px`).toBeGreaterThanOrEqual(39.5);
      expect(action.hit, `${action.id} center hit at ${viewport.width}px`).toBe(true);
    }
  }
});

test("responsive modes and live legacy rollback retain the same Jam node, state, and Users preference", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await searchJam(page, "anthem");
  await page.locator("#jam-volume-slider").evaluate((input) => {
    input.value = "64";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => { window.__phase2ResponsiveJamNode = document.getElementById("jam-panel"); });

  for (const [viewport, expectedMode] of [
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
    [{ width: 640, height: 360 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    await expectStageModule(page, "jam");
    await expectUsersVisible(page, true);
    expect(await page.evaluate(() => window.__phase2ResponsiveJamNode === document.getElementById("jam-panel"))).toBe(true);
    await expect(page.locator("#jam-search-input")).toHaveValue("anthem");
    await expect(page.locator("#jam-volume-slider")).toHaveValue("64");
  }

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#jam-panel")).toBeVisible();
  const legacy = await page.locator("#jam-panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      sameNode: window.__phase2ResponsiveJamNode === panel,
      viewportCenterX: window.innerWidth / 2,
      viewportCenterY: window.innerHeight / 2,
    };
  });
  expect(legacy.sameNode).toBe(true);
  expect(Math.abs(legacy.centerX - legacy.viewportCenterX)).toBeLessThanOrEqual(1);
  expect(Math.abs(legacy.centerY - legacy.viewportCenterY)).toBeLessThanOrEqual(1);
  await expect(page.locator("#jam-search-input")).toHaveValue("anthem");
  await expect(page.locator("#jam-volume-slider")).toHaveValue("64");

  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);
  expect(await page.evaluate(() => window.__phase2ResponsiveJamNode === document.getElementById("jam-panel"))).toBe(true);
});

test("Jam focus returns through Escape while Settings explicitly inerts the active Stage module", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);
  await openJam(page);

  await expect(page.locator("#close-jam")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);
  await expect(page.locator("#open-jam")).toBeFocused();

  await page.locator("#open-jam").click();
  await expectStageModule(page, "jam");
  const output = page.locator("#dock-output");
  await output.click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#settings-panel")).toHaveAttribute("aria-modal", "");
  await expect(page.locator("#close-settings")).toBeFocused();
  await expect.poll(() => page.locator("#clubhouse-shell").evaluate((shell) => shell.inert)).toBe(true);
  await expect.poll(() => page.locator("#jam-panel").evaluate((panel) => panel.inert)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(output).toBeFocused();
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expect.poll(() => page.locator("#jam-panel").evaluate((panel) => panel.inert)).toBe(false);
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);

  await page.keyboard.press("Escape");
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, true);
  await expect(page.locator("#open-jam")).toBeFocused();
});

test("hidden Users does not close Chat and a top overlay owns the first Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);

  await page.locator("#open-chat").click();
  await expectStageModule(page, "chat");
  await expectUsersVisible(page, true);
  await page.locator("#shell-toggle-utility").click();
  await expectUsersVisible(page, false);
  await expectStageModule(page, "chat");

  await page.evaluate((src) => openImageLightbox(src), transparentDataUrl);
  await expect(page.locator(".image-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".image-lightbox")).toHaveCount(0);
  await expectStageModule(page, "chat");
  await expectUsersVisible(page, false);

  await page.keyboard.press("Escape");
  await expectStageModule(page, "screens");
  await expectUsersVisible(page, false);
});

test("source-PC settings stay collapsed while playback controls remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await showSourcePcControls(page);

  const disclosure = page.locator("#jam-panel .jam-source-local-details");
  const summary = page.locator("#jam-panel .jam-source-local-summary");
  const switches = page.locator("#jam-panel .jam-source-local-switch input");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(summary).toBeVisible();
  await expect(switches).toHaveCount(2);
  await expect(switches.first()).toBeHidden();
  expect(await page.evaluate(() => {
    const controls = document.getElementById("jam-host-controls");
    const card = document.querySelector("#jam-panel [data-jam-source-local-card]");
    return !!(controls.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    await page.evaluate(() => {
      const body = document.querySelector("#jam-panel .jam-body");
      const overview = document.querySelector("#jam-panel .jam-session-overview");
      const scrollOwner = getComputedStyle(body).display === "grid" ? overview : body;
      scrollOwner.scrollTop = 0;
    });
    await nextPaint(page);

    const initial = await page.evaluate(() => {
      function verticalBounds(element) {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      }
      const buttonTops = Array.from(document.querySelectorAll("#jam-host-controls button"))
        .filter((button) => getComputedStyle(button).display !== "none")
        .map((button) => Math.round(button.getBoundingClientRect().top));
      const body = document.querySelector("#jam-panel .jam-body");
      const overview = document.querySelector("#jam-panel .jam-session-overview");
      const scrollOwner = getComputedStyle(body).display === "grid" ? overview : body;
      return {
        bodyRect: verticalBounds(scrollOwner),
        buttonTops,
        toolbarRect: verticalBounds(document.getElementById("jam-host-controls")),
      };
    });
    expect(initial.toolbarRect.top).toBeGreaterThanOrEqual(initial.bodyRect.top - 1);
    expect(initial.toolbarRect.bottom).toBeLessThanOrEqual(initial.bodyRect.bottom + 1);
    expect(new Set(initial.buttonTops).size, `one playback row at ${viewport.width}x${viewport.height}`).toBe(1);

    await page.evaluate(() => {
      const body = document.querySelector("#jam-panel .jam-body");
      const overview = document.querySelector("#jam-panel .jam-session-overview");
      const scrollOwner = getComputedStyle(body).display === "grid" ? overview : body;
      scrollOwner.scrollTop = scrollOwner.scrollHeight;
    });
    await nextPaint(page);
    const sticky = await page.evaluate(() => {
      function verticalBounds(element) {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      }
      const body = document.querySelector("#jam-panel .jam-body");
      const overview = document.querySelector("#jam-panel .jam-session-overview");
      const scrollOwner = getComputedStyle(body).display === "grid" ? overview : body;
      return {
        bodyRect: verticalBounds(scrollOwner),
        toolbarRect: verticalBounds(document.getElementById("jam-host-controls")),
      };
    });
    expect(sticky.toolbarRect.top, `sticky toolbar top at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(sticky.bodyRect.top - 1);
    expect(sticky.toolbarRect.bottom, `sticky toolbar bottom at ${viewport.width}x${viewport.height}`)
      .toBeLessThanOrEqual(sticky.bodyRect.bottom + 1);
  }

  await page.evaluate(() => {
    const body = document.querySelector("#jam-panel .jam-body");
    const overview = document.querySelector("#jam-panel .jam-session-overview");
    const scrollOwner = getComputedStyle(body).display === "grid" ? overview : body;
    scrollOwner.scrollTop = 0;
  });
  await summary.click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(switches.first()).toBeVisible();
  const expanded = await page.evaluate(() => {
    const card = document.querySelector("#jam-panel [data-jam-source-local-card]");
    const cardRect = card.getBoundingClientRect();
    const rows = Array.from(card.querySelectorAll(".jam-source-local-switch-row")).map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      card: { left: cardRect.left, right: cardRect.right },
      overflow: card.scrollWidth - card.clientWidth,
      rows,
    };
  });
  expect(expanded.overflow).toBeLessThanOrEqual(1);
  for (const row of expanded.rows) {
    expect(row.left).toBeGreaterThanOrEqual(expanded.card.left - 1);
    expect(row.right).toBeLessThanOrEqual(expanded.card.right + 1);
  }
});

test("populated Jam remains inside the workspace and above the dock at representative sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, { unbrokenNames: true });
  await openJam(page);
  await searchJam(page, "responsive");

  for (const [viewport, expectedMode] of [
    [{ width: 5120, height: 1440 }, "theater"],
    [{ width: 3440, height: 1440 }, "theater"],
    [{ width: 1920, height: 1080 }, "theater"],
    [{ width: 1366, height: 768 }, "theater"],
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    const geometry = await page.evaluate(() => {
      function rect(selector) {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      }
      const targetSizes = Array.from(document.querySelectorAll(
        "#jam-panel button:not(.hidden):not([style*='display:none']):not([style*='display: none'])",
      )).filter((button) => getComputedStyle(button).display !== "none" && button.getClientRects().length > 0).map((button) => {
        const bounds = button.getBoundingClientRect();
        return { height: bounds.height, id: button.id || button.className, width: bounds.width };
      });
      const textOverflow = Array.from(document.querySelectorAll(
        "#jam-panel .jam-result-info, #jam-panel .jam-now-playing-info, #jam-panel .jam-result-name, #jam-panel .jam-result-artist",
      )).some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible");
      return {
        bodyDisplay: getComputedStyle(document.querySelector("#jam-panel .jam-body")).display,
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        browser: rect("#jam-browser"),
        dockInert: document.getElementById("call-controls").inert,
        documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        dock: rect("#call-controls"),
        header: rect('.room-top[data-ui-region="shell-header"]'),
        jam: rect("#jam-panel"),
        overview: rect("#jam-panel .jam-session-overview"),
        overviewEnd: rect("#jam-status"),
        search: rect("#jam-search-input"),
        scrimVisible: !document.getElementById("utility-scrim").classList.contains("hidden"),
        screenInert: document.getElementById("screen-grid").inert,
        stage: rect('[data-ui-region="primary-stage"]'),
        stageInert: document.querySelector('[data-ui-region="primary-stage"]').inert,
        targetSizes,
        textOverflow,
        visualizer: rect("#jam-audio-visualizer"),
        visualizerBackingPixels: Number(document.getElementById("jam-audio-visualizer-canvas").dataset.backingPixels || 0),
        visualizerCanvasCount: document.querySelectorAll("#jam-audio-visualizer canvas").length,
        visualizerOverflow: document.getElementById("jam-audio-visualizer").scrollWidth - document.getElementById("jam-audio-visualizer").clientWidth,
        viewport: { height: window.innerHeight, width: window.innerWidth },
        usersInert: document.getElementById("room-sidebar").inert,
        usersVisible: document.getElementById("room-sidebar").getClientRects().length > 0,
        workspace: rect('.room-layout[data-ui-region="workspace"]'),
      };
    });

    expect(geometry.jam.left).toBeGreaterThanOrEqual(geometry.stage.left - 1);
    expect(geometry.jam.right).toBeLessThanOrEqual(geometry.stage.right + 1);
    expect(geometry.jam.top).toBeGreaterThanOrEqual(geometry.stage.top - 1);
    expect(geometry.jam.bottom).toBeLessThanOrEqual(geometry.stage.bottom + 1);
    expect(geometry.jam.top).toBeGreaterThanOrEqual(geometry.header.bottom - 1);
    expect(geometry.jam.bottom).toBeLessThanOrEqual(geometry.dock.top - 1);
    expect(geometry.search.top).toBeGreaterThanOrEqual(geometry.jam.top - 1);
    expect(geometry.search.bottom).toBeLessThanOrEqual(geometry.jam.bottom + 1);
    expect(geometry.documentOverflowX).toBeLessThanOrEqual(1);
    expect(geometry.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(geometry.textOverflow).toBe(false);
    expect(geometry.visualizerCanvasCount).toBe(1);
    expect(geometry.visualizerOverflow).toBeLessThanOrEqual(1);
    expect(geometry.visualizerBackingPixels).toBeGreaterThan(0);
    expect(geometry.visualizerBackingPixels).toBeLessThanOrEqual(180000);
    expect(geometry.visualizer.left).toBeGreaterThanOrEqual(geometry.jam.left - 1);
    expect(geometry.visualizer.right).toBeLessThanOrEqual(geometry.jam.right + 1);
    if (geometry.bodyDisplay === "grid") {
      expect(geometry.visualizer.left).toBeGreaterThanOrEqual(geometry.overview.left - 1);
      expect(geometry.visualizer.right).toBeLessThanOrEqual(geometry.overview.right + 1);
    }
    expect(geometry.scrimVisible).toBe(false);
    expect(geometry.screenInert).toBe(true);
    expect(geometry.stageInert).toBe(false);
    expect(geometry.usersInert).toBe(false);
    expect(geometry.usersVisible).toBe(true);
    expect(geometry.dockInert).toBe(false);
    expect(Math.abs(geometry.jam.width - geometry.stage.width)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(geometry.jam.height - geometry.stage.height)).toBeLessThanOrEqual(2.5);
    const expectedJamBodyDisplay = geometry.jam.width >= 854 ? "grid" : "flex";
    expect(geometry.bodyDisplay).toBe(expectedJamBodyDisplay);
    if (expectedJamBodyDisplay === "grid") {
      expect(geometry.overview.right).toBeLessThanOrEqual(geometry.browser.left + 1);
      expect(geometry.browser.width).toBeGreaterThanOrEqual(459.5);
    } else {
      expect(geometry.overviewEnd.bottom).toBeLessThanOrEqual(geometry.browser.top + 1);
    }
    expect(geometry.targetSizes.length).toBeGreaterThan(4);
    for (const target of geometry.targetSizes) {
      expect(target.height, `${target.id} height at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(39.5);
      expect(target.width, `${target.id} width at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(39.5);
    }
  }
});

test("Echo Pulse uses real Jam analyser data, survives state polls, and honors reduced motion", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPhaseTwoViewer(page);
  await openJam(page);

  const visualizer = page.locator("#jam-audio-visualizer");
  const canvas = visualizer.locator("canvas");
  await expect(visualizer).toBeVisible();
  await expect(visualizer).toHaveAttribute("data-state", "waiting");
  await expect(visualizer).toHaveAttribute("data-reactive", "false");
  await expect(page.locator("#jam-audio-visualizer-status")).toHaveText("JOIN JAM TO ACTIVATE");
  await expect(visualizer).toHaveAttribute("aria-hidden", "true");
  await expect(canvas).toHaveAttribute("aria-hidden", "true");
  await expect(canvas).not.toHaveAttribute("tabindex", /.+/);

  await page.evaluate(() => {
    const visualizerNode = document.getElementById("jam-audio-visualizer");
    window.__echoPulseStableNode = visualizerNode;
    const analyser = {
      frequencyBinCount: 256,
      fftSize: 512,
      getByteFrequencyData(target) {
        for (let index = 0; index < target.length; index += 1) {
          target[index] = 42 + ((index * 31) % 190);
        }
      },
      getByteTimeDomainData(target) {
        for (let index = 0; index < target.length; index += 1) {
          target[index] = 128 + Math.round(Math.sin(index / 7) * 54);
        }
      },
    };
    _jamAudioAnalysisGraph = { available: true, analyser, destroy() {} };
    _jamAudioCtx = { state: "running" };
    _jamAudioStreamReady = true;
    _jamAudioWs = { readyState: 1 };
    syncJamAudioVisualizer(_jamState.now_playing);
  });
  await nextPaint(page);

  await expect(visualizer).toHaveAttribute("data-state", "live");
  await expect(visualizer).toHaveAttribute("data-reactive", "true");
  await expect(page.locator("#jam-audio-visualizer-status")).toHaveText("LIVE");
  const active = await page.evaluate(() => {
    const canvasElement = document.getElementById("jam-audio-visualizer-canvas");
    const context = canvasElement.getContext("2d");
    const pixels = context.getImageData(0, 0, canvasElement.width, canvasElement.height).data;
    let energy = 0;
    for (let index = 3; index < pixels.length; index += 4) energy += pixels[index];
    return {
      energy,
      nodeStable: window.__echoPulseStableNode === document.getElementById("jam-audio-visualizer"),
      snapshot: _jamAudioVisualizerController.snapshot(),
    };
  });
  expect(active.energy).toBeGreaterThan(0);
  expect(active.nodeStable).toBe(true);
  expect(active.snapshot.drawCount).toBeGreaterThan(0);
  expect(active.snapshot.backingPixels).toBeGreaterThan(0);
  expect(active.snapshot.backingPixels).toBeLessThanOrEqual(180000);

  await page.evaluate(() => { document.getElementById("jam-panel").inert = true; });
  await expect.poll(() => page.evaluate(() => _jamAudioVisualizerController.snapshot().frameScheduled)).toBe(false);
  const drawCountWhileInert = await page.evaluate(() => _jamAudioVisualizerController.snapshot().drawCount);
  await page.evaluate(() => { document.getElementById("jam-panel").inert = false; });
  await expect.poll(() => page.evaluate(() => _jamAudioVisualizerController.snapshot().frameScheduled)).toBe(true);
  await expect.poll(() => page.evaluate(() => _jamAudioVisualizerController.snapshot().drawCount)).toBeGreaterThan(drawCountWhileInert);

  await page.evaluate(async () => {
    await fetchJamState();
    await fetchJamState();
  });
  expect(await page.evaluate(() => window.__echoPulseStableNode === document.getElementById("jam-audio-visualizer"))).toBe(true);
  await expect(page.locator("#jam-audio-visualizer canvas")).toHaveCount(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "still");
  await expect(visualizer).toHaveAttribute("data-motion", "still");
  await expect(visualizer).toHaveAttribute("data-state", "still");
  await expect(visualizer).toHaveAttribute("data-reactive", "false");
  await expect(page.locator("#jam-audio-visualizer-status")).toHaveText("MOTION OFF");
  expect(await page.evaluate(() => _jamAudioVisualizerController.snapshot().frameScheduled)).toBe(false);

  const model = apiModels.get(page);
  model.state.spotify_is_playing = false;
  model.state.now_playing.is_playing = false;
  await page.evaluate(() => fetchJamState());
  await expect(visualizer).toBeHidden();
  await expect(visualizer).toHaveAttribute("data-state", "idle");
});

test("Echo Pulse observes scheduled PCM on a muted branch without replacing playback", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPhaseTwoViewer(page);
  await openJam(page);

  const graph = await page.evaluate(async () => {
    const NativeAudioContext = window.AudioContext;
    const NativeWebkitAudioContext = window.webkitAudioContext;
    const NativeWebSocket = window.WebSocket;
    let contextInstance = null;
    let socketInstance = null;

    class FakeNode {
      constructor(kind) {
        this.kind = kind;
        this.connections = [];
        this.disconnectCount = 0;
      }
      connect(target) {
        this.connections.push(target && target.kind ? target.kind : "unknown");
        return target;
      }
      disconnect() { this.disconnectCount += 1; }
    }

    class FakeAudioContext {
      constructor() {
        contextInstance = this;
        this.state = "running";
        this.currentTime = 1;
        this.destination = new FakeNode("destination");
        this.sources = [];
        this.gains = [];
        this.analyser = null;
      }
      createGain() {
        const gain = new FakeNode(this.gains.length ? "analysis-sink" : "playback-gain");
        gain.gain = { value: 1 };
        this.gains.push(gain);
        return gain;
      }
      createAnalyser() {
        const analyser = new FakeNode("analyser");
        analyser.frequencyBinCount = 256;
        analyser.getByteFrequencyData = (target) => target.fill(120);
        analyser.getByteTimeDomainData = (target) => target.fill(128);
        this.analyser = analyser;
        return analyser;
      }
      createBuffer(channels, length, sampleRate) {
        const channelData = Array.from({ length: channels }, () => new Float32Array(length));
        return {
          duration: length / sampleRate,
          getChannelData(index) { return channelData[index]; },
        };
      }
      createBufferSource() {
        const source = new FakeNode("buffer-source");
        source.startedAt = null;
        source.start = (time) => { source.startedAt = time; };
        this.sources.push(source);
        return source;
      }
      resume() { return Promise.resolve(); }
      close() { this.state = "closed"; return Promise.resolve(); }
    }

    class FakeWebSocket {
      constructor(url) {
        socketInstance = this;
        this.url = url;
        this.binaryType = "";
        this.sent = [];
        this.closed = false;
      }
      send(value) { this.sent.push(value); }
      close() { this.closed = true; }
    }

    try {
      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = undefined;
      window.WebSocket = FakeWebSocket;
      _jamAudioCtx = null;
      _jamGainNode = null;
      _jamAudioWs = null;
      _jamAudioStreamReady = false;
      destroyJamAudioAnalysisGraph();
      _jamListeningGeneration = _jamState.generation;
      _jamContract = { canJoin: true, compatible: true };

      startJamAudioStream();
      socketInstance.onopen();
      socketInstance.onmessage({ data: JSON.stringify({ type: "ready" }) });
      socketInstance.onmessage({ data: new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4, -0.4]).buffer });

      const source = contextInstance.sources[0];
      return {
        analyserConnections: contextInstance.analyser.connections.slice(),
        analysisSinkConnections: contextInstance.gains[1].connections.slice(),
        analysisSinkGain: contextInstance.gains[1].gain.value,
        authFrames: socketInstance.sent.length,
        playbackConnections: contextInstance.gains[0].connections.slice(),
        sourceConnections: source.connections.slice(),
        sourceStarted: Number.isFinite(source.startedAt),
        visualizerState: document.getElementById("jam-audio-visualizer").dataset.state,
      };
    } finally {
      stopJamAudioStream();
      window.AudioContext = NativeAudioContext;
      window.webkitAudioContext = NativeWebkitAudioContext;
      window.WebSocket = NativeWebSocket;
    }
  });

  expect(graph.playbackConnections).toEqual(["destination"]);
  expect(graph.sourceConnections).toEqual(["playback-gain", "analyser"]);
  expect(graph.analyserConnections).toEqual(["analysis-sink"]);
  expect(graph.analysisSinkConnections).toEqual(["destination"]);
  expect(graph.analysisSinkGain).toBe(0);
  expect(graph.authFrames).toBe(1);
  expect(graph.sourceStarted).toBe(true);
  expect(graph.visualizerState).toBe("live");
});

test("an Echo Pulse failure cannot block Jam audio startup", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);

  const result = await page.evaluate(() => {
    const NativeAudioContext = window.AudioContext;
    const NativeWebkitAudioContext = window.webkitAudioContext;
    const NativeWebSocket = window.WebSocket;
    const NativeVisualizer = window.EchoJamVisualizer;
    let socketCreated = false;

    class FakeGain {
      constructor() { this.gain = { value: 1 }; }
      connect() {}
      disconnect() {}
    }
    class FakeAudioContext {
      constructor() {
        this.state = "running";
        this.destination = {};
      }
      createGain() { return new FakeGain(); }
      createAnalyser() { throw new Error("analysis unavailable"); }
      close() { return Promise.resolve(); }
    }
    class FakeWebSocket {
      constructor() { socketCreated = true; }
      close() {}
    }

    try {
      destroyJamAudioVisualizer();
      _jamAudioVisualizerDisabled = false;
      _jamAudioCtx = null;
      _jamGainNode = null;
      _jamAudioWs = null;
      _jamAudioStreamReady = false;
      _jamListeningGeneration = _jamState.generation;
      _jamContract = { canJoin: true, compatible: true };
      window.AudioContext = FakeAudioContext;
      window.webkitAudioContext = undefined;
      window.WebSocket = FakeWebSocket;
      window.EchoJamVisualizer = Object.assign({}, NativeVisualizer, {
        createJamVisualizerController() { throw new Error("canvas failed"); },
      });

      startJamAudioStream();
      return {
        socketCreated,
        socketInstalled: _jamAudioWs instanceof FakeWebSocket,
        audioContextInstalled: _jamAudioCtx instanceof FakeAudioContext,
        visualizerDisabled: _jamAudioVisualizerDisabled,
      };
    } finally {
      stopJamAudioStream();
      window.AudioContext = NativeAudioContext;
      window.webkitAudioContext = NativeWebkitAudioContext;
      window.WebSocket = NativeWebSocket;
      window.EchoJamVisualizer = NativeVisualizer;
    }
  });

  expect(result).toEqual({
    socketCreated: true,
    socketInstalled: true,
    audioContextInstalled: true,
    visualizerDisabled: true,
  });
});

test("Jam browser tabs are keyboard navigable and history remains available while inactive", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const model = apiModels.get(page);
  model.state.active = false;
  model.state.spotify_is_playing = false;
  model.state.now_playing = null;
  await openPhaseTwoViewer(page);
  await openJam(page);

  await expect(page.locator("#jam-connect-spotify")).toBeVisible();
  await expect(page.locator("#jam-connect-spotify")).toHaveText("Refresh Spotify Access");
  const spotifyAttribution = page.locator(".jam-spotify-attribution");
  await expect(spotifyAttribution).toHaveAttribute("href", "https://open.spotify.com/");
  await expect(spotifyAttribution.locator("img")).toHaveAttribute("alt", "Spotify");
  expect(await spotifyAttribution.locator("img").evaluate((image) => image.getBoundingClientRect().width)).toBeGreaterThanOrEqual(70);
  const searchTab = page.locator("#jam-view-search-tab");
  await searchTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#jam-view-library-tab")).toBeFocused();
  await expect(page.locator("#jam-library-section")).toBeVisible();
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(2);
  expect(model.counts["GET /api/jam/history"] || 0).toBe(0);

  await page.keyboard.press("End");
  await expect(page.locator("#jam-view-history-tab")).toBeFocused();
  await expect(page.locator("#jam-history-section")).toBeVisible();
  await expect(page.locator("#jam-history-list")).toContainText("Played While Inactive");
  await expect(page.locator("#jam-history-list")).toContainText("Added by Sam");
  await expect(page.locator("#jam-history-list .jam-history-playlist a")).toHaveText("Fixture Road Trip");
  await expect.poll(() => model.counts["GET /api/jam/history"] || 0).toBe(1);
  await page.evaluate(async () => { await fetchJamState(); });
  expect(model.counts["GET /api/jam/history"] || 0).toBe(1);

  const overflow = await page.locator("#jam-browser").evaluate((browser) => ({
    browser: browser.scrollWidth - browser.clientWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.browser).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
});

test("visible History refreshes once when the server history revision advances", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.evaluate(() => {
    if (_jamPollTimer) clearInterval(_jamPollTimer);
    _jamPollTimer = null;
  });

  await page.locator("#jam-view-history-tab").click();
  await expect(page.locator("#jam-history-list")).toContainText("Played While Inactive");
  await expect.poll(() => model.counts["GET /api/jam/history"] || 0).toBe(1);

  model.state.history_revision = 1;
  model.historyItems = [{
    history_entry_id: "history-2",
    spotify_id: "1234567890ABCDEFGHIJKL",
    spotify_uri: "spotify:track:1234567890ABCDEFGHIJKL",
    spotify_url: "https://open.spotify.com/track/1234567890ABCDEFGHIJKL",
    name: "Advanced Without Tab Switching",
    artist: "Fixture Artist Two",
    added_at_ms: 1_700_000_200_000,
    played_at_ms: 1_700_000_300_000,
    added_by_actor_id: "friend",
    added_by_name: "Friend",
  }];

  await page.evaluate(async () => { await fetchJamState(); });
  await expect.poll(() => model.counts["GET /api/jam/history"] || 0).toBe(2);
  await expect(page.locator("#jam-history-section")).toBeVisible();
  await expect(page.locator("#jam-view-history-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#jam-history-list")).toContainText("Advanced Without Tab Switching");
  await page.evaluate(() => { window.__phase2HistoryRow = document.querySelector("#jam-history-list > li"); });

  await page.evaluate(async () => { await fetchJamState(); });
  expect(model.counts["GET /api/jam/history"] || 0).toBe(2);
  expect(await page.evaluate(() => window.__phase2HistoryRow === document.querySelector("#jam-history-list > li"))).toBe(true);
});

test("History adds a playable song through the existing queue path without leaving the current view", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  const model = apiModels.get(page);
  model.queueTrackDelayOnceMs = 300;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.evaluate(() => {
    if (_jamPollTimer) clearInterval(_jamPollTimer);
    _jamPollTimer = null;
  });

  await page.locator("#jam-view-history-tab").click();
  await page.locator("#jam-history-sort").selectOption("added_at");
  await page.locator("#jam-history-direction").selectOption("asc");
  const add = page.getByRole("button", {
    name: "Add Played While Inactive by Fixture Artist to queue",
    exact: true,
  });
  await expect(add).toBeEnabled();
  await expect(add).toHaveAttribute("title", "Add this song to the active Jam queue");

  const geometry = await add.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const rowRect = button.closest(".jam-history-item").getBoundingClientRect();
    const panelRect = document.getElementById("jam-panel").getBoundingClientRect();
    return {
      buttonLeft: buttonRect.left,
      buttonRight: buttonRect.right,
      rowLeft: rowRect.left,
      rowRight: rowRect.right,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(geometry.buttonLeft).toBeGreaterThanOrEqual(geometry.rowLeft - 1);
  expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.rowRight + 1);
  expect(geometry.rowLeft).toBeGreaterThanOrEqual(geometry.panelLeft - 1);
  expect(geometry.rowRight).toBeLessThanOrEqual(geometry.panelRight + 1);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);

  await add.click();
  await expect.poll(() => model.counts["POST /api/jam/queue"] || 0).toBe(1);
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute("title", "Wait for the current song to finish adding");
  await expect(add).toHaveAttribute("aria-description", "Wait for the current song to finish adding");
  expect(model.queueTrackBodies[0]).toMatchObject({
    spotify_uri: `spotify:track:${trackId}`,
    name: "Played While Inactive",
    artist: "Fixture Artist",
    album_art_url: "https://i.scdn.co/image/history-fixture",
    duration_ms: 222_000,
    generation: 7,
  });
  expect(model.queueTrackBodies[0].request_id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);

  await expect(add).toBeEnabled({ timeout: 2_000 });
  await expect(page.locator("#jam-history-status")).toHaveText("Added Played While Inactive to the queue.");
  await expect(page.locator("#jam-history-section")).toBeVisible();
  await expect(page.locator("#jam-view-history-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#jam-history-sort")).toHaveValue("added_at");
  await expect(page.locator("#jam-history-direction")).toHaveValue("asc");
});

test("History explains why queue actions are disabled before Start Jam and sends no request", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  const model = apiModels.get(page);
  model.state.active = false;
  model.state.spotify_is_playing = false;
  model.state.now_playing = null;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-history-tab").click();

  const add = page.getByRole("button", {
    name: "Add Played While Inactive by Fixture Artist to queue",
    exact: true,
  });
  const guidance = "Start a Jam to add this song to the queue";
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute("title", guidance);
  await expect(add).toHaveAttribute("aria-description", guidance);
  await add.evaluate((button) => button.click());
  expect(model.counts["POST /api/jam/queue"] || 0).toBe(0);
  await expect(page.locator("#jam-history-section")).toBeVisible();
  await expect(page.locator("#jam-view-history-tab")).toHaveAttribute("aria-selected", "true");
});

test("empty History explains why songs played directly in Spotify are not recorded", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.historyItems = [];
  await openPhaseTwoViewer(page);
  await openJam(page);
  await expect(page.locator("#jam-results")).not.toHaveAttribute("role", "list");
  await page.locator("#jam-view-history-tab").click();

  const explanation = "History records only songs added through Echo and then observed playing";
  await expect(page.locator("#jam-history-list .jam-history-empty")).toContainText(explanation);
  await expect(page.locator("#jam-history-list .jam-history-empty")).toContainText("played directly in Spotify are not recorded");
  await expect(page.locator("#jam-history-list .jam-history-empty")).toContainText("no Jam adder attribution");
  await expect(page.locator("#jam-history-status")).toContainText(explanation);
  await expect(page.locator("#jam-history-list > li")).toHaveCount(1);
});

test("Queue removes one or multiple pending songs while truthfully locking Spotify-committed entries", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const model = apiModels.get(page);
  model.state.now_playing.spotify_uri = model.state.queue[0].spotify_uri;
  model.state.queue[1].spotify_uri = model.state.queue[0].spotify_uri;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-queue-tab").click();

  await expect(page.locator("#jam-queue-list .jam-queue-select")).toHaveCount(6);
  await expect(page.locator('[data-queue-entry-id="queue-entry-1"] .jam-queue-lock-reason'))
    .toContainText("Currently playing in Spotify");
  await expect(page.locator('[data-queue-entry-id="queue-entry-2"] .jam-queue-lock-reason'))
    .toContainText("Spotify delivery could not be verified. End Jam and start a new one to recover.");
  await expect(page.locator('[data-queue-entry-id="queue-entry-1"] .jam-queue-remove-one')).toHaveCount(0);

  const narrowGeometry = await page.locator("#jam-queue-section").evaluate((section) => {
    const sectionRect = section.getBoundingClientRect();
    const itemRects = Array.from(section.querySelectorAll(".jam-queue-item")).map((item) => {
      const rect = item.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      internalOverflow: section.scrollWidth - section.clientWidth,
      viewportOverflow: document.documentElement.scrollWidth - window.innerWidth,
      itemsContained: itemRects.every((rect) => rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1),
    };
  });
  expect(narrowGeometry.internalOverflow).toBeLessThanOrEqual(1);
  expect(narrowGeometry.viewportOverflow).toBeLessThanOrEqual(1);
  expect(narrowGeometry.itemsContained).toBe(true);

  const thirdRow = page.locator('[data-queue-entry-id="queue-entry-3"]');
  const fourthRow = page.locator('[data-queue-entry-id="queue-entry-4"]');
  const thirdChoice = thirdRow.locator(".jam-queue-select");
  const fourthChoice = fourthRow.locator(".jam-queue-select");
  await expect(thirdChoice).toHaveAttribute("aria-label", /queue position 3 for removal$/);
  await thirdChoice.check();
  await fourthChoice.check();
  await expect(page.locator("#jam-queue-selection-count")).toHaveText("2 songs selected");

  await page.evaluate(async () => { await fetchJamState(); });
  await expect(thirdChoice).toBeChecked();
  await expect(fourthChoice).toBeChecked();

  await page.locator("#jam-queue-remove-selected").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/remove"] || 0).toBe(1);
  expect(model.queueRemovalBodies[0]).toMatchObject({
    generation: 7,
    expected_queue_revision: 11,
    queue_entry_ids: ["queue-entry-3", "queue-entry-4"],
  });
  expect(model.queueRemovalBodies[0].request_id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"]')).toHaveCount(0);
  await expect(page.locator('[data-queue-entry-id="queue-entry-4"]')).toHaveCount(0);
  await expect(page.locator("#jam-queue-status")).toHaveText("Removed 2 songs from the queue.");

  const fifthRow = page.locator('[data-queue-entry-id="queue-entry-5"]');
  const removeFifth = fifthRow.getByRole("button", { name: /Remove Queued Song 5 .* queue position 3 from queue$/ });
  await expect(removeFifth).toHaveText("Remove");
  await removeFifth.click();
  await expect.poll(() => model.counts["POST /api/jam/queue/remove"] || 0).toBe(2);
  expect(model.queueRemovalBodies[1]).toMatchObject({
    generation: 7,
    expected_queue_revision: 12,
    queue_entry_ids: ["queue-entry-5"],
  });
  await expect(page.locator('[data-queue-entry-id="queue-entry-5"]')).toHaveCount(0);
  await expect(page.locator("#jam-queue-status")).toHaveText("Removed 1 song from the queue.");
});

test("commit-unknown queue recovery guidance overrides the now-playing explanation", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.state.queue[0].delivery_state = "commit_unknown";
  model.state.queue[0].can_remove = false;
  model.state.now_playing.spotify_uri = model.state.queue[0].spotify_uri;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-queue-tab").click();

  const reason = page.locator('[data-queue-entry-id="queue-entry-1"] .jam-queue-lock-reason');
  await expect(reason).toHaveText(
    "Spotify delivery could not be verified. End Jam and start a new one to recover.",
  );
  await expect(reason).not.toContainText("Currently playing");
});

test("stale queue removal refreshes for review and preserves only still-removable selections", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.queueRemovalConflictOnce = true;
  model.expectedQueueRemovalConflict = true;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-queue-tab").click();

  await page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-select').check();
  await page.locator('[data-queue-entry-id="queue-entry-4"] .jam-queue-select').check();
  await page.locator("#jam-queue-remove-selected").click();

  await expect.poll(() => model.counts["POST /api/jam/queue/remove"] || 0).toBe(1);
  await expect(page.locator("#jam-queue-status")).toContainText("queue changed");
  await expect(page.locator("#jam-queue-status")).toContainText("review your selections");
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-select')).toHaveCount(0);
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-lock-reason'))
    .toContainText("Already sent to Spotify");
  await expect(page.locator('[data-queue-entry-id="queue-entry-4"] .jam-queue-select')).toBeChecked();
  await expect(page.locator("#jam-queue-selection-count")).toHaveText("1 song selected");
  await expect(page.locator("#jam-queue-remove-selected")).toBeEnabled();
  await page.waitForTimeout(50);
  expect(model.counts["POST /api/jam/queue/remove"]).toBe(1);
});

test("an interrupted queue-removal response refreshes and confirms the server result", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.queueRemovalAbortAfterCommitOnce = true;
  model.expectedQueueRemovalNetworkError = true;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-queue-tab").click();

  await page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-select').check();
  await page.locator("#jam-queue-remove-selected").click();

  await expect.poll(() => model.counts["POST /api/jam/queue/remove"] || 0).toBe(1);
  await expect.poll(() => model.counts["GET /api/jam/state"] || 0).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"]')).toHaveCount(0);
  await expect(page.locator("#jam-queue-selection-count")).toHaveText("0 songs selected");
  await expect(page.locator("#jam-queue-status")).toContainText("response was interrupted");
  await expect(page.locator("#jam-queue-status")).toContainText("confirmed 1 selected song is no longer queued");
});

test("large Queue stays unbuilt while hidden, preserves DOM on unchanged polls, and restores focus after revisions", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.state.queue = Array.from({ length: 220 }, (_, index) => ({
    queue_entry_id: `large-queue-entry-${index + 1}`,
    delivery_state: "pending",
    can_remove: true,
    spotify_uri: `spotify:track:large-${index + 1}`,
    name: `Large Queue Song ${index + 1}`,
    artist: `Large Queue Artist ${index + 1}`,
    album_art_url: "",
    duration_ms: 180_000,
    added_by: `Friend ${index + 1}`,
  }));
  model.state.queue_revision = 42;
  await openPhaseTwoViewer(page);
  await openJam(page);

  await expect(page.locator("#jam-queue-list .jam-queue-item")).toHaveCount(0);
  await page.evaluate(async () => { await fetchJamState(); });
  await expect(page.locator("#jam-queue-list .jam-queue-item")).toHaveCount(0);

  await page.locator("#jam-view-queue-tab").click();
  await expect(page.locator("#jam-queue-list .jam-queue-item")).toHaveCount(220);
  const focusedChoice = page.locator('[data-queue-entry-id="large-queue-entry-150"] .jam-queue-select');
  await focusedChoice.focus();
  await focusedChoice.check();
  await page.locator('[data-queue-entry-id="large-queue-entry-1"]').evaluate((row) => { row.dataset.pollIdentity = "preserved"; });

  await page.evaluate(async () => { await fetchJamState(); });
  await expect(page.locator('[data-queue-entry-id="large-queue-entry-1"]')).toHaveAttribute("data-poll-identity", "preserved");
  await expect(focusedChoice).toBeFocused();
  await expect(focusedChoice).toBeChecked();

  model.state.queue_revision += 1;
  model.state.queue[219].name = "Large Queue Song 220 revised";
  await page.evaluate(async () => { await fetchJamState(); });
  await expect(page.locator('[data-queue-entry-id="large-queue-entry-1"]')).not.toHaveAttribute("data-poll-identity", "preserved");
  await expect(page.locator('[data-queue-entry-id="large-queue-entry-150"] .jam-queue-select')).toBeFocused();
  await expect(page.locator('[data-queue-entry-id="large-queue-entry-150"] .jam-queue-select')).toBeChecked();
  await expect(page.locator("#jam-queue-list")).toContainText("Large Queue Song 220 revised");
});

test.describe("coarse pointer Queue controls", () => {
  test.use({ hasTouch: true });

  test("queue selection choices expose a computed 44 by 44 hit target", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await openPhaseTwoViewer(page);
    await openJam(page);
    await page.locator("#jam-view-queue-tab").click();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const size = await page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-choice').evaluate((choice) => {
      const rect = choice.getBoundingClientRect();
      return { height: rect.height, width: rect.width };
    });
    expect(size.width).toBeGreaterThanOrEqual(44);
    expect(size.height).toBeGreaterThanOrEqual(44);
  });
});

test("single-song queue actions serialize double-clicks and send an idempotency key", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.queueTrackDelayOnceMs = 300;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-search-input").fill("single track");
  const firstAdd = page.locator("#jam-results .jam-result-add").first();
  await expect(firstAdd).toBeEnabled();
  await firstAdd.dblclick();

  await expect.poll(() => model.counts["POST /api/jam/queue"] || 0).toBe(1);
  await expect(firstAdd).toBeDisabled();
  for (const button of await page.locator("#jam-results .jam-result-add").all()) await expect(button).toBeDisabled();
  await page.waitForTimeout(100);
  expect(model.counts["POST /api/jam/queue"]).toBe(1);
  expect(model.queueTrackBodies[0]).toMatchObject({
    generation: 7,
    spotify_uri: model.searchTracks[0].spotify_uri,
  });
  expect(model.queueTrackBodies[0].request_id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  await expect(firstAdd).toBeEnabled({ timeout: 2_000 });
  expect(model.queueTrackMutations).toBe(1);
});

test("interrupted single-song adds retry with the same request id without a second mutation", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.queueTrackAbortAfterCommitOnce = true;
  model.expectedTrackQueueNetworkError = true;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-search-input").fill("retry track");
  const firstAdd = page.locator("#jam-results .jam-result-add").first();

  await firstAdd.click();
  await expect(page.locator("#jam-status")).toContainText("response was interrupted");
  await expect(firstAdd).toBeEnabled();
  await firstAdd.click();

  await expect.poll(() => model.counts["POST /api/jam/queue"] || 0).toBe(2);
  await expect(firstAdd).toBeEnabled();
  expect(model.queueTrackBodies[1].request_id).toBe(model.queueTrackBodies[0].request_id);
  expect(model.queueTrackMutations).toBe(1);
  await expect.poll(() => page.evaluate(() => {
    const entries = JSON.parse(sessionStorage.getItem("echo-jam-track-ambiguous-v1") || "[]");
    return entries.length;
  })).toBe(0);
});

test("Library cards expose explicit Spotify and queue or song-selection actions", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  const trackCard = page.locator("#jam-library-list .jam-catalog-track").filter({ hasText: "Shared Favorite" });
  await expect(trackCard).toHaveCount(1);
  const trackSpotify = trackCard.getByRole("link", { name: "Open Shared Favorite in Spotify", exact: true });
  await expect(trackSpotify).toHaveText("Open in Spotify");
  await expect(trackSpotify).toHaveAttribute("href", `https://open.spotify.com/track/${trackId}`);
  const addTrack = trackCard.getByRole("button", { name: "Add Shared Favorite by Fixture Artist to queue", exact: true });
  await expect(addTrack).toHaveText("Add to queue");
  await addTrack.click();
  await expect.poll(() => model.counts["POST /api/jam/queue"] || 0).toBe(1);
  expect(model.queueTrackBodies).toHaveLength(1);
  expect(model.queueTrackBodies[0]).toMatchObject({
    spotify_uri: `spotify:track:${trackId}`,
    name: "Shared Favorite",
    artist: "Fixture Artist",
    generation: 7,
  });

  const libraryPlaylist = page.locator("#jam-library-list .jam-catalog-playlist").filter({ hasText: "Fixture Road Trip" });
  await expect(libraryPlaylist).toHaveCount(1);
  const playlistArtwork = libraryPlaylist.locator("img.jam-result-art");
  await expect(playlistArtwork).toHaveAttribute("src", "https://i.scdn.co/image/playlist-fixture");
  await expect.poll(() => playlistArtwork.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(libraryPlaylist.getByRole("link", { name: "Open Fixture Road Trip in Spotify", exact: true }))
    .toHaveText("Open in Spotify");
  const chooseLibrarySongs = libraryPlaylist.getByRole("button", { name: "Choose songs from Fixture Road Trip", exact: true });
  await expect(chooseLibrarySongs).toHaveText("Choose songs");
  await chooseLibrarySongs.click();
  await expect(page.locator("#jam-playlist-detail")).toBeVisible();
  await expect(page.locator("#jam-playlist-back")).toHaveText("Back to Library");
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(30);

  await page.locator("#jam-playlist-back").click();
  await page.locator("#jam-view-search-tab").click();
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  const searchPlaylist = page.locator("#jam-results .jam-catalog-playlist").filter({ hasText: "Fixture Road Trip" });
  await expect(searchPlaylist).toHaveCount(1);
  await expect(searchPlaylist.getByRole("link", { name: "Open Fixture Road Trip in Spotify", exact: true }))
    .toHaveText("Open in Spotify");
  const chooseSearchSongs = searchPlaylist.getByRole("button", { name: "Choose songs from Fixture Road Trip", exact: true });
  await expect(chooseSearchSongs).toHaveText("Choose songs");
  await chooseSearchSongs.click();
  await expect(page.locator("#jam-playlist-back")).toHaveText("Back to search results");
  await page.locator("#jam-playlist-back").click();
  await expect(searchPlaylist).toBeVisible();

  await page.setViewportSize({ width: 360, height: 640 });
  await searchPlaylist.scrollIntoViewIfNeeded();
  const narrowActions = await searchPlaylist.evaluate((card) => ({
    cardOverflow: card.scrollWidth - card.clientWidth,
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    actionWidths: Array.from(card.querySelectorAll(".jam-card-actions > *"), (action) => action.getBoundingClientRect().width),
  }));
  expect(narrowActions.cardOverflow).toBeLessThanOrEqual(1);
  expect(narrowActions.documentOverflow).toBeLessThanOrEqual(1);
  expect(narrowActions.actionWidths.every((width) => width >= 39.5)).toBe(true);
});

test("expired playlist artwork falls back to the clean Library placeholder", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.expectedArtworkFailure = true;
  model.favoriteItems = [{
    ...model.playlist,
    artwork_url: "https://i.scdn.co/image/expired-playlist-fixture",
    attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 100, source: "echo" }],
    contributor_count: 1,
    favorited_by_me: true,
  }];
  await page.route("https://i.scdn.co/image/expired-playlist-fixture", async (route) => {
    await route.abort("failed");
  });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  const playlistCard = page.locator("#jam-library-list .jam-catalog-playlist");
  await expect(playlistCard.locator("img.jam-result-art")).toHaveCount(0);
  await expect(playlistCard.locator(".jam-result-art.jam-art-placeholder")).toHaveCount(1);
});

test("playlist detail returns to the preserved Library page and restores its opener focus", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.favoriteItems = Array.from({ length: 20 }, (_, index) => ({
    ...model.searchTracks[index % model.searchTracks.length],
    kind: "track",
    spotify_id: `2${String(index + 1).padStart(21, "0")}`,
    spotify_uri: `spotify:track:2${String(index + 1).padStart(21, "0")}`,
    name: `Paged Favorite ${index + 1}`,
    attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 100 + index, source: "manual" }],
    favorited_by_me: true,
  }));
  model.favoriteItems.push({
    ...model.playlist,
    attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 500, source: "manual" }],
    favorited_by_me: true,
  });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();
  await page.locator("#jam-library-next").click();

  await expect(page.locator("#jam-library-page")).toHaveText("21 favorites \u00b7 2 of 2");
  const playlistCard = page.locator("#jam-library-list .jam-catalog-playlist");
  const opener = playlistCard.getByRole("button", { name: "Choose songs from Fixture Road Trip", exact: true });
  await playlistCard.evaluate((card) => { card.dataset.preservedPage = "yes"; });
  await opener.click();
  await expect(page.locator("#jam-playlist-back")).toHaveText("Back to Library");
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(30);
  await page.locator("#jam-playlist-back").click();

  await expect(page.locator("#jam-library-page")).toHaveText("21 favorites \u00b7 2 of 2");
  await expect(page.locator("#jam-library-list .jam-catalog-playlist")).toHaveAttribute("data-preserved-page", "yes");
  await expect(opener).toBeFocused();
  expect(model.favoriteQueries.map((query) => query.offset)).toEqual(["0", "20"]);
});

test("empty Echo Favorites explains first use and copies Spotify saves idempotently", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Bring in your Spotify saves");
  await expect(page.locator("#jam-library-import-card")).toContainText("not the songs inside playlists");
  await expect(page.locator("#jam-library-import-card")).toContainText("nothing is added to the Jam queue");
  await expect(page.locator("#jam-library-refresh-spotify")).toBeHidden();
  await expect(page.locator("#jam-import-spotify")).toHaveText("Copy Spotify saves");
  await expect(page.locator("#jam-import-spotify")).toHaveClass(/jam-primary-btn/);
  await expect(page.locator("#jam-import-spotify")).toBeEnabled();
  await expect(page.locator("#jam-library-status")).toHaveText(
    "No Echo Favorites yet. Copy your Spotify saves above, or use Search and press ☆.",
  );
  await expect(page.locator("#jam-library-list .jam-library-empty")).toHaveText(
    "Your shared Echo Favorites library is empty.",
  );
  await expect(page.locator("#jam-library-list .jam-library-empty")).not.toHaveAttribute("role", "listitem");
  await expect(page.locator("#jam-library-list")).not.toHaveAttribute("role", "list");

  await page.locator("#jam-import-spotify").click();
  await expect.poll(() => model.counts["POST /api/jam/favorites/import-spotify"] || 0).toBe(1);
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(2);
  await expect(page.locator("#jam-library-status")).toHaveText(
    "Checked 1 Liked Song and 1 saved playlist; added 2 new Echo Favorites.",
  );
  await expect(page.locator("#jam-library-list")).toContainText("Imported Saved Playlist");
  await expect(page.locator("#jam-library-import-card")).toHaveClass(/compact/);
  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Spotify saves");
  await expect(page.locator("#jam-import-spotify")).toHaveText("Check for new Spotify saves");
  await expect(page.locator("#jam-import-spotify")).toHaveClass(/jam-secondary-btn/);

  await page.setViewportSize({ width: 360, height: 640 });
  await page.locator("#jam-library-import-card").scrollIntoViewIfNeeded();
  const compactLayout = await page.locator("#jam-library-import-card").evaluate((card) => ({
    cardOverflow: card.scrollWidth - card.clientWidth,
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    actionWidth: card.querySelector("#jam-import-spotify").getBoundingClientRect().width,
  }));
  expect(compactLayout.cardOverflow).toBeLessThanOrEqual(1);
  expect(compactLayout.documentOverflow).toBeLessThanOrEqual(1);
  expect(compactLayout.actionWidth).toBeGreaterThanOrEqual(120);
  await page.setViewportSize({ width: 1366, height: 768 });

  await page.locator("#jam-library-kind").selectOption("playlist");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(1);
  await expect(page.locator("#jam-library-list")).toContainText("Imported Saved Playlist");

  await page.locator("#jam-import-spotify").click();
  await expect.poll(() => model.counts["POST /api/jam/favorites/import-spotify"] || 0).toBe(2);
  await expect(page.locator("#jam-library-status")).toContainText("added 0 new Echo Favorites");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(1);
});

test("filtered import does not leave the global-empty message stale", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  model.importTracksOnly = true;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();
  await expect(page.locator("#jam-library-list .jam-library-empty")).toHaveText(
    "Your shared Echo Favorites library is empty.",
  );

  await page.locator("#jam-library-kind").selectOption("playlist");
  await page.locator("#jam-import-spotify").click();
  await expect.poll(() => model.counts["POST /api/jam/favorites/import-spotify"] || 0).toBe(1);
  await expect(page.locator("#jam-library-list .jam-library-empty")).toHaveText(
    "Nothing matches the current Library filters.",
  );

  await page.locator("#jam-library-kind").selectOption("all");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(1);
  await expect(page.locator("#jam-library-list")).toContainText("Imported Liked Song");
});

test("disconnected Spotify Library presents only the connect action", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  await openPhaseTwoViewer(page);
  await openJam(page);
  model.state.spotify_connected = false;
  model.state.spotify_library_authorized = false;
  await page.evaluate(async () => { await fetchJamState(); });
  await page.locator("#jam-view-library-tab").click();

  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Connect your Spotify Library");
  await expect(page.locator("#jam-library-refresh-spotify")).toHaveText("Connect Spotify");
  await expect(page.locator("#jam-library-refresh-spotify")).toBeVisible();
  await expect(page.locator("#jam-import-spotify")).toBeHidden();
});

test("stale Spotify authorization presents only the library-access action", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  model.state.spotify_library_authorized = false;
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  await expect(page.locator("#jam-library-import-card")).toHaveClass(/needs-access/);
  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Spotify Library access required");
  await expect(page.locator("#jam-library-import-card")).toContainText(
    "Grant read access to copy your Liked Songs and saved playlists into shared Echo Favorites.",
  );
  await expect(page.locator("#jam-library-refresh-spotify")).toHaveText("Grant Spotify Library Access");
  await expect(page.locator("#jam-library-refresh-spotify")).toBeEnabled();
  await expect(page.locator("#jam-import-spotify")).toBeHidden();
  expect(await page.locator("#jam-library-refresh-spotify").evaluate((button) => typeof button.onclick)).toBe("function");
});

test("Spotify account allowlist failures stay distinct from missing Library scopes", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  model.importError = {
    status: 403,
    error: "spotify_account_forbidden",
    message: "Spotify rejected this account: User is not registered for this application.",
  };
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  await page.locator("#jam-import-spotify").click();
  await expect(page.locator("#jam-library-status")).toHaveText(model.importError.message);
  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Bring in your Spotify saves");
  await expect(page.locator("#jam-library-refresh-spotify")).toBeHidden();
  await expect(page.locator("#jam-import-spotify")).toBeEnabled();
});

test("backend Library-scope errors switch Import to reauthorization guidance", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const model = apiModels.get(page);
  model.favoriteItems = [];
  model.importError = {
    status: 403,
    error: "spotify_library_scope_required",
    message: "Spotify Library access is missing. Use Refresh Spotify Access, then try again.",
  };
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();

  await page.locator("#jam-import-spotify").click();
  await expect(page.locator("#jam-library-status")).toHaveText(model.importError.message);
  await expect(page.locator("#jam-library-import-card strong")).toHaveText("Spotify Library access required");
  await expect(page.locator("#jam-library-refresh-spotify")).toHaveText("Grant Spotify Library Access");
  await expect(page.locator("#jam-import-spotify")).toBeHidden();
});

test("zero-match kind keeps the selected favorite contributor and truthful empty results", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.favoriteItems = [
    {
      kind: "track",
      spotify_id: trackId,
      spotify_uri: `spotify:track:${trackId}`,
      spotify_url: `https://open.spotify.com/track/${trackId}`,
      name: "Friend Track",
      artist: "Fixture Artist",
      attributions: [{ actor_id: "friend", display_name: "Friend", added_at_ms: 200, source: "manual" }],
      contributor_count: 1,
      favorited_by_me: false,
    },
    {
      ...model.playlist,
      name: "Sam Playlist",
      attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 100, source: "manual" }],
      contributor_count: 1,
      favorited_by_me: true,
    },
  ];
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-view-library-tab").click();
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(2);

  const contributor = page.locator("#jam-library-contributor");
  await contributor.selectOption("friend");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(1);
  await expect(page.locator("#jam-library-list")).toContainText("Friend Track");

  await page.locator("#jam-library-kind").selectOption("playlist");
  await expect(contributor).toHaveValue("friend");
  await expect(contributor.locator('option[value="friend"]')).toHaveText("Friend (0)");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(0);
  await expect(page.locator("#jam-library-status")).toHaveText("No Echo Favorites match these filters.");
  expect(model.favoriteQueries.at(-1)).toMatchObject({ kind: "playlist", actor_id: "friend" });

  await contributor.selectOption("");
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(1);
  await expect(page.locator("#jam-library-list")).toContainText("Sam Playlist");
  expect(model.favoriteQueries.at(-1)).toMatchObject({ kind: "playlist" });
  expect(model.favoriteQueries.at(-1).actor_id).toBeUndefined();
});

test("catalog search aborts and rejects stale results", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  await expect(page.locator("#jam-now-playing .jam-now-playing-name")).toHaveAttribute("href", `https://open.spotify.com/track/${trackId}`);
  await expect(page.locator("#jam-banner .jam-banner-title")).toHaveAttribute("href", `https://open.spotify.com/track/${trackId}`);
  await expect(page.locator("#jam-now-playing")).not.toHaveAttribute("role", "button");
  await expect(page.locator("#jam-join-btn")).toBeVisible();
  await expect(page.locator("#jam-banner")).toHaveAttribute("role", "group");
  await expect(page.locator("#jam-banner .jam-banner-open")).toHaveRole("button");
  const input = page.locator("#jam-search-input");

  await input.fill("slow original");
  await expect.poll(() => model.counts["POST /api/jam/catalog/search"] || 0).toBe(1);
  await input.fill("fresh replacement");
  await expect(page.locator("#jam-results")).toContainText("Fresh Result");
  await page.waitForTimeout(600);
  await expect(page.locator("#jam-results")).not.toContainText("Stale Result");
});

test("playlist detail preserves cross-page selections and clears only processed positions after a partial batch", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.selectedPlaylistPartial = true;
  model.playlistTotal = 130;
  model.playlist.track_count = 130;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  const first = page.getByRole("checkbox", { name: /Select Playlist Song 1 by Search Artist 1/ });
  const third = page.getByRole("checkbox", { name: /Select Playlist Song 3 by Search Artist 3/ });
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-select")).toHaveCount(50);
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  await expect(page.locator("#jam-playlist-add-selected")).toBeDisabled();
  await first.check();
  await third.check();
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("2 songs selected");
  await page.locator("#jam-playlist-clear-selection").click();
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  await expect(page.locator("#jam-playlist-clear-selection")).toBeDisabled();
  await expect(first).not.toBeChecked();
  await expect(third).not.toBeChecked();
  await first.check();
  await third.check();

  await page.locator("#jam-playlist-load-more").click();
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-select")).toHaveCount(100);
  await expect(first).toBeChecked();
  await expect(third).toBeChecked();
  const fiftyFirst = page.getByRole("checkbox", { name: /Select Playlist Song 51 by/ });
  await fiftyFirst.check();
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("3 songs selected");

  await page.locator("#jam-playlist-add-selected").dblclick();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist/selection"] || 0).toBe(1);
  expect(model.queuePlaylistBodies).toHaveLength(1);
  expect(model.queuePlaylistBodies[0]).toMatchObject({
    playlist_id: playlistId,
    selected_positions: [0, 2, 50],
    snapshot_id: "snapshot-fixture-1",
    confirmed: false,
    generation: 7,
  });
  expect(model.queuePlaylistBodies[0].request_id).toBeTruthy();
  await expect(page.locator("#jam-playlist-status")).toContainText("1 song remains selected");
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("1 song selected");
  await expect(first).not.toBeChecked();
  await expect(third).not.toBeChecked();
  await expect(fiftyFirst).toBeChecked();

  await resizeTo(page, { width: 360, height: 640 }, "mini");
  await page.locator(".jam-playlist-selection").scrollIntoViewIfNeeded();
  const narrowGeometry = await page.locator(".jam-playlist-selection").evaluate((selection) => {
    const rect = selection.getBoundingClientRect();
    const panel = document.getElementById("jam-panel").getBoundingClientRect();
    return {
      insidePanel: rect.left >= panel.left - 1 && rect.right <= panel.right + 1,
      internalOverflow: selection.scrollWidth - selection.clientWidth,
      viewportOverflow: document.documentElement.scrollWidth - window.innerWidth,
      actionWidths: Array.from(selection.querySelectorAll("button"), (button) => button.getBoundingClientRect().width),
    };
  });
  expect(narrowGeometry.insidePanel).toBe(true);
  expect(narrowGeometry.internalOverflow).toBeLessThanOrEqual(1);
  expect(narrowGeometry.viewportOverflow).toBeLessThanOrEqual(1);
  expect(narrowGeometry.actionWidths.every((width) => width >= 39.5)).toBe(true);
});

test("playlist selection stays hidden when the server does not advertise the safe selection endpoint", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  const model = apiModels.get(page);
  model.state.playlist_selection_supported = false;
  await openJam(page);
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  await expect(page.locator(".jam-playlist-selection")).toBeHidden();
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-choice")).toHaveCount(30);
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-choice").first()).toBeHidden();
  await expect(page.locator("#jam-playlist-add-all")).toBeVisible();
});

test("playlist page snapshot changes discard mixed rows and selections before reloading page one", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.playlistSnapshotChangesOnAppend = true;
  model.playlistTotal = 130;
  model.playlist.track_count = 130;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  const first = page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ });
  await first.check();
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("1 song selected");
  await page.locator("#jam-playlist-load-more").click();
  await expect.poll(() => model.playlistItemOffsets.join(",")).toBe("0,50,0");
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(50);
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  await expect(page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ })).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => _jamPlaylist && _jamPlaylist.snapshot_id)).toBe("snapshot-fixture-2");
  expect(model.queuePlaylistBodies).toHaveLength(0);
});

test("ambiguous selected-playlist retries reuse the request id and do not commit twice", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.ambiguousPlaylistQueue = true;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();
  await page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ }).check();

  await page.locator("#jam-playlist-add-selected").click();
  await expect(page.locator("#jam-playlist-status")).toContainText("Could not add the selected songs");
  await page.locator("#jam-playlist-add-selected").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist/selection"] || 0).toBe(2);
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  expect(model.queuePlaylistBodies).toHaveLength(2);
  expect(model.queuePlaylistBodies[1].request_id).toBe(model.queuePlaylistBodies[0].request_id);
  expect(model.queuePlaylistMutations).toBe(1);
});

test("playlist request id survives teardown before an in-flight success can be applied", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.trackPlaylistQueueMutations = true;
  model.playlistQueueDelayOnceMs = 300;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();
  await page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ }).check();

  await page.locator("#jam-playlist-add-selected").click();
  await expect.poll(() => model.queuePlaylistBodies.length).toBe(1);
  const firstRequestId = model.queuePlaylistBodies[0].request_id;
  await expect.poll(() => page.evaluate((requestId) => {
    const entries = JSON.parse(sessionStorage.getItem("echo-jam-playlist-ambiguous-v1") || "[]");
    return entries.some((entry) => Array.isArray(entry) && entry[1] === requestId);
  }, firstRequestId)).toBe(true);

  // Model the state invalidation caused by a reload/disconnect while keeping
  // same-origin sessionStorage. The late success must not discard the key.
  await page.evaluate(() => {
    _jamPlaylistRequestSeq += 1;
    invalidateJamPlaylistQueueLifecycle();
    _jamPlaylistAmbiguousRequests = null;
  });
  await page.waitForTimeout(350);
  await expect.poll(() => page.evaluate((requestId) => {
    const entries = JSON.parse(sessionStorage.getItem("echo-jam-playlist-ambiguous-v1") || "[]");
    return entries.some((entry) => Array.isArray(entry) && entry[1] === requestId);
  }, firstRequestId)).toBe(true);

  await page.locator("#jam-playlist-add-selected").click();
  await expect.poll(() => model.queuePlaylistBodies.length).toBe(2);
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  expect(model.queuePlaylistBodies[1].request_id).toBe(firstRequestId);
  expect(model.queuePlaylistMutations).toBe(1);
});

test("cleanup invalidates an old playlist operation without letting its late finally unlock a new one", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  const model = apiModels.get(page);
  model.playlistTotal = 2;
  model.playlist.track_count = 2;
  model.playlistQueueDelays = [1_200, 2_200];
  await openPhaseTwoViewer(page);
  await openJam(page);
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(2);
  await page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ }).check();
  await page.locator("#jam-playlist-add-selected").click();
  await expect.poll(() => model.queuePlaylistBodies.length).toBe(1);

  const cleanupControls = await page.evaluate(() => {
    cleanupJam();
    return {
      backDisabled: document.getElementById("jam-playlist-back").disabled,
      tabsDisabled: Array.from(document.querySelectorAll(".jam-browser-tab"), (tab) => tab.disabled),
    };
  });
  expect(cleanupControls.backDisabled).toBe(false);
  expect(cleanupControls.tabsDisabled.every((disabled) => disabled === false)).toBe(true);

  await openJam(page);
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("");
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(2);
  await page.getByRole("checkbox", { name: /Select Playlist Song 1 by/ }).check();
  await page.locator("#jam-playlist-add-selected").click();
  await expect.poll(() => model.queuePlaylistBodies.length).toBe(2);
  await expect(page.locator("#jam-playlist-back")).toBeDisabled();

  await expect.poll(() => model.playlistQueueResponses).toBe(1);
  await page.waitForTimeout(50);
  await expect(page.locator("#jam-playlist-back")).toBeDisabled();
  for (const tab of await page.locator(".jam-browser-tab").all()) await expect(tab).toBeDisabled();
  await expect.poll(() => page.evaluate(() => jamPlaylistQueuePending())).toBe(true);

  await expect.poll(() => model.playlistQueueResponses, { timeout: 3_500 }).toBe(2);
  await expect(page.locator("#jam-playlist-back")).toBeEnabled();
  for (const tab of await page.locator(".jam-browser-tab").all()) await expect(tab).toBeEnabled();
  await expect.poll(() => page.evaluate(() => jamPlaylistQueuePending())).toBe(false);
});

test("playlist navigation stays locked until a partial batch receipt is applied", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.entirePlaylistPartial = true;
  model.playlistQueueDelayOnceMs = 300;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await page.locator("#jam-playlist-add-all").click();
  await expect.poll(() => model.queuePlaylistBodies.length).toBe(1);
  await expect(page.locator("#jam-playlist-back")).toBeDisabled();
  await expect(page.locator(".jam-browser-tab")).toHaveCount(4);
  for (const tab of await page.locator(".jam-browser-tab").all()) await expect(tab).toBeDisabled();
  await page.evaluate(() => closeJamPlaylistDetail());
  await expect(page.locator("#jam-playlist-detail")).toBeVisible();
  await expect(page.locator("#jam-playlist-status")).toContainText("Wait for the playlist queue operation");

  await expect(page.locator("#jam-playlist-status")).toContainText("28 songs remain selected");
  await expect(page.locator("#jam-playlist-back")).toBeEnabled();
  for (const tab of await page.locator(".jam-browser-tab").all()) await expect(tab).toBeEnabled();
});

test("interrupted entire-playlist batches resume only the remaining positions", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.entirePlaylistPartial = true;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await page.locator("#jam-playlist-add-all").click();
  await expect(page.locator("#jam-playlist-status")).toContainText("28 songs remain selected");
  await expect(page.locator("#jam-playlist-add-all")).toHaveText("Add remaining songs");
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("28 songs selected");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("28 selected songs");
    await dialog.accept();
  });
  await page.locator("#jam-playlist-add-all").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist/selection"] || 0).toBe(1);
  await expect(page.locator("#jam-playlist-selection-count")).toHaveText("0 songs selected");
  await expect(page.locator("#jam-playlist-add-all")).toHaveText("Add entire playlist");
  expect(model.queuePlaylistBodies).toHaveLength(2);
  expect(model.queuePlaylistBodies[0]).not.toHaveProperty("selected_positions");
  expect(model.queuePlaylistBodies[1].selected_positions).toEqual(Array.from({ length: 28 }, (_, index) => index + 2));
  expect(model.queuePlaylistBodies[1].request_id).not.toBe(model.queuePlaylistBodies[0].request_id);
});

test("duplicate playlist occurrences have distinct position-aware checkbox names", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.duplicatePlaylistTracks = true;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await page.locator("#jam-results .jam-inspect-btn").click();

  await expect(page.getByRole("checkbox", { name: "Select Duplicate Song by Same Artist, playlist position 1", exact: true })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "Select Duplicate Song by Same Artist, playlist position 2", exact: true })).toHaveCount(1);
});

test("playlist detail confirms over 25 once and enqueues the entire playlist as one locked server batch", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.playlistTotal = 120;
  model.playlist.track_count = 120;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await expect(page.locator("#jam-results .jam-inspect-btn")).toHaveCount(1);
  await page.locator("#jam-results .jam-inspect-btn").click();
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(50);
  await expect(page.locator("#jam-playlist-load-more")).toBeVisible();
  await expect(page.locator("#jam-playlist-add-all")).toHaveText("Add entire playlist");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("120 songs");
    await dialog.accept();
  });
  await page.locator("#jam-playlist-add-all").dblclick();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist"] || 0).toBe(1);
  expect(model.queuePlaylistBodies).toHaveLength(1);
  expect(model.queuePlaylistBodies[0]).toMatchObject({
    playlist_id: playlistId,
    snapshot_id: "snapshot-fixture-1",
    confirmed: true,
    generation: 7,
  });
  expect(model.queuePlaylistBodies[0]).not.toHaveProperty("selected_positions");
  expect(model.queuePlaylistBodies[0].request_id).toBeTruthy();
  await expect(page.locator("#jam-playlist-status")).toContainText("Added 119 songs");
  await expect(page.locator("#jam-playlist-status")).toContainText("skipped 1 unavailable");
  await expect(page.locator("#jam-playlist-status")).not.toContainText("partially added");
});

test("unknown playlist count honors the server confirmation_required contract", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.forceConfirmation = true;
  model.expectedConfirmationConflict = true;
  await page.evaluate((id) => {
    _jamPlaylist = normalizeSpotifyCatalogItem({ kind: "playlist", spotify_id: id, name: "Unknown Count" }, "playlist");
    _jamPlaylistTotal = null;
    _jamPlaylistLoading = false;
    document.getElementById("jam-search-section").hidden = true;
    document.getElementById("jam-playlist-detail").hidden = false;
    renderJamPlaylistSummary();
  }, playlistId);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("30 songs");
    await dialog.accept();
  });
  await page.locator("#jam-playlist-add-all").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist"] || 0).toBe(2);
  expect(model.queuePlaylistBodies.map((body) => body.confirmed)).toEqual([false, true]);
  expect(model.queuePlaylistBodies[1].request_id).toBe(model.queuePlaylistBodies[0].request_id);
});

test("restricted playlists load and document their private cache in 50-song chunks", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.playlistTotal = 268;
  model.playlist.track_count = 268;
  model.playlistItemsSource = "local_cache";

  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("hardwave");
  await page.locator("#jam-results .jam-inspect-btn").click();

  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(50);
  await expect(page.locator("#jam-playlist-status")).toContainText("50 of 268 songs are cached privately on Echo in 50-song chunks");
  await expect(page.locator("#jam-playlist-load-more")).toHaveText("Load next 50 songs");

  await page.locator("#jam-playlist-load-more").click();
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(100);
  await expect(page.locator("#jam-playlist-status")).toContainText("100 of 268 songs are cached privately on Echo in 50-song chunks");

  for (let pageIndex = 2; pageIndex < 6; pageIndex += 1) {
    await page.locator("#jam-playlist-load-more").click();
  }
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(268);
  await expect(page.locator("#jam-playlist-status")).toContainText("268 of 268 songs are cached privately on Echo in 50-song chunks");
  await expect(page.locator("#jam-playlist-load-more")).toBeHidden();
  expect(model.playlistItemOffsets).toEqual([0, 50, 100, 150, 200, 250]);
});

test("restricted playlists over 1,000 songs stay selectable but cannot bulk queue", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.playlistTotal = 1200;
  model.playlist.track_count = 1200;
  model.playlistItemsSource = "local_cache";

  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("large restricted playlist");
  await page.locator("#jam-results .jam-inspect-btn").click();

  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(50);
  await expect(page.locator("#jam-playlist-status")).toContainText(
    "Echo exposes the first 1000 positions; select a smaller group to queue",
  );
  await expect(page.locator("#jam-playlist-add-all")).toBeDisabled();
  await expect(page.locator("#jam-playlist-add-all")).toHaveAttribute(
    "title",
    "Echo can queue at most 1,000 songs at once; select a smaller group",
  );
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-select").first()).toBeEnabled();

  for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
    await page.locator("#jam-playlist-load-more").click();
    await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount((pageIndex + 1) * 50);
  }
  await expect(page.locator("#jam-playlist-load-more")).toBeHidden();
  expect(model.playlistItemOffsets).toEqual(Array.from({ length: 20 }, (_, index) => index * 50));
});

test("a failed bounded public-catalog fallback renders retry guidance without queueing", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.forbidPlaylistItems = true;
  model.expectedPlaylistForbidden = true;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("restricted playlist");
  await page.locator("#jam-results .jam-inspect-btn").click();
  const expectedMessage = "Spotify changed its public playlist response";
  await expect(page.locator("#jam-playlist-status")).toContainText(expectedMessage);
  await expect(page.locator("#jam-playlist-status")).not.toContainText("unavailable right now");
  const blocked = page.locator("#jam-playlist-items .jam-playlist-access-blocked");
  await expect(blocked).toBeVisible();
  await expect(page.locator("#jam-playlist-items")).not.toHaveAttribute("role", "list");
  await expect(blocked).toContainText("Echo couldn't load this playlist's next 50 songs");
  await expect(blocked).toContainText("bounded public-catalog fallback did not complete");
  await expect(blocked.getByRole("link", { name: "Open Fixture Road Trip in Spotify", exact: true }))
    .toHaveAttribute("href", `https://open.spotify.com/playlist/${playlistId}`);
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(0);
  await expect(page.locator("#jam-playlist-add-all")).toBeDisabled();
  await expect(page.locator(".jam-playlist-selection")).toBeHidden();
  await expect(page.locator("#jam-playlist-load-more")).toBeHidden();

  await blocked.getByRole("button", { name: "Retry 50-song chunk", exact: true }).click();
  await expect.poll(() => model.counts[`GET /api/jam/playlists/${playlistId}/items`] || 0).toBe(2);
  await expect(blocked).toBeVisible();

  await page.evaluate(() => addPlaylistToQueue());
  await page.waitForTimeout(25);
  expect(model.counts["POST /api/jam/queue/playlist"] || 0).toBe(0);
  await expect(page.locator("#jam-playlist-status")).toContainText(expectedMessage);
});

test("pending Skip reconciliation pauses queue mutations while Stop Music and End Jam stay available", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const model = apiModels.get(page);
  model.state.skip_reconciliation_pending = true;
  model.state.last_error = "PRIVATE RAW SPOTIFY ERROR <script>must not render</script>";
  await openPhaseTwoViewer(page);
  await openJam(page);

  const warning = page.locator("#jam-skip-reconciliation-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText(
    "Echo is confirming the last Skip with Spotify. Skip and queue changes are paused until that check finishes.",
  );
  await expect(page.locator("#jam-panel")).not.toContainText("PRIVATE RAW SPOTIFY ERROR");
  await expect(page.locator("#jam-skip-btn")).toBeDisabled();
  await expect(page.locator("#jam-stop-music-btn")).toBeEnabled();
  await expect(page.locator("#jam-end-btn")).toBeEnabled();

  await page.locator("#jam-search-input").fill("reconciliation track");
  const searchAdd = page.locator("#jam-results .jam-result-add").first();
  await expect(searchAdd).toBeDisabled();
  await page.evaluate(async () => { await addToQueue(_jamSearchItems[0]); });
  expect(model.counts["POST /api/jam/queue"] || 0).toBe(0);

  await page.locator("#jam-view-library-tab").click();
  await expect(page.locator("#jam-library-list .jam-library-queue-btn").first()).toBeDisabled();

  await page.locator("#jam-view-queue-tab").click();
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-select')).toBeDisabled();
  await expect(page.locator('[data-queue-entry-id="queue-entry-3"] .jam-queue-remove-one')).toBeDisabled();
  await expect(page.locator("#jam-queue-remove-selected")).toBeDisabled();

  await page.locator("#jam-view-search-tab").click();
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("reconciliation playlist");
  await page.locator("#jam-results .jam-inspect-btn").click();
  await expect(page.locator("#jam-playlist-items .jam-playlist-track-select").first()).toBeDisabled();
  await expect(page.locator("#jam-playlist-add-selected")).toBeDisabled();
  await expect(page.locator("#jam-playlist-add-all")).toBeDisabled();

  await page.evaluate(async () => { await fetchJamState(); });
  await expect(warning).toBeVisible();

  model.state.skip_reconciliation_pending = false;
  await page.evaluate(async () => { await fetchJamState(); });

  await expect(warning).toBeHidden();
  await expect(warning).toHaveText("");
  await expect(page.locator("#jam-skip-btn")).toBeEnabled();
  await expect(page.locator("#jam-stop-music-btn")).toBeEnabled();
  await expect(page.locator("#jam-end-btn")).toBeEnabled();
  await expect(page.locator("#jam-playlist-add-all")).toBeEnabled();
  const firstPlaylistChoice = page.locator("#jam-playlist-items .jam-playlist-track-select").first();
  await expect(firstPlaylistChoice).toBeEnabled();
  await firstPlaylistChoice.check();
  await expect(page.locator("#jam-playlist-add-selected")).toBeEnabled();
});

test("Stop Music preserves the Jam while exact-host End Jam remains a distinct destructive action", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  const stopMusic = page.locator("#jam-stop-music-btn");
  const endJam = page.locator("#jam-end-btn");

  await expect(stopMusic).toBeVisible();
  await expect(endJam).toBeVisible();
  await expect(stopMusic).toHaveAttribute("title", /Jam stays open/);
  await expect(endJam).toHaveAttribute("title", /Ends the Jam/);
  const visualDistinction = await page.evaluate(() => {
    const stopStyle = getComputedStyle(document.getElementById("jam-stop-music-btn"));
    const endStyle = getComputedStyle(document.getElementById("jam-end-btn"));
    return {
      backgroundDifferent: stopStyle.backgroundColor !== endStyle.backgroundColor,
      borderDifferent: stopStyle.borderColor !== endStyle.borderColor,
      colorDifferent: stopStyle.color !== endStyle.color,
    };
  });
  expect(Object.values(visualDistinction).some(Boolean)).toBe(true);

  await stopMusic.click();
  await expect.poll(() => model.counts["POST /api/jam/playback/stop"] || 0).toBe(1);
  expect(model.counts["POST /api/jam/stop"] || 0).toBe(0);
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expectStageModule(page, "jam");
  await expectUsersVisible(page, true);
  await expect(page.locator("#jam-now-playing")).toContainText("No music playing");
  expect(model.state.active).toBe(true);
  expect(model.state.generation).toBe(7);
  expect(model.state.listeners).toEqual(["layout-fixture-2", "layout-fixture-3"]);

  model.state.host_identity = "layout-fixture-1-RECONNECTED";
  await page.evaluate(() => fetchJamState());
  await expect(endJam).toBeHidden();
  await expect(stopMusic).toBeVisible();

  model.state.host_identity = "layout-fixture-1";
  await page.evaluate(() => fetchJamState());
  await expect(endJam).toBeVisible();
  await endJam.click();
  await expect.poll(() => model.counts["POST /api/jam/stop"] || 0).toBe(1);
  expect(model.counts["POST /api/jam/playback/stop"] || 0).toBe(1);
  expect(model.state.active).toBe(false);
  await expect(endJam).toBeHidden();
});
