const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "jam.js"), "utf8");
const trackId = "0123456789ABCDEFGHIJKL";
const secondId = "1234567890ABCDEFGHIJKL";
const playlistId = "ABCDEFGHIJKL0123456789";
const track = (id = trackId) => ({ kind: "track", spotify_id: id, name: `Song ${id}` });
const playlist = { kind: "playlist", spotify_id: playlistId, name: "Song Radio", snapshot_id: "snapshot-a", item_count: 500 };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness() {
  const status = [];
  const context = vm.createContext({
    window: { location: { href: "https://echo.test/" }, confirm: () => true },
    document: { readyState: "loading", addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    currentAccessToken: "participant-a", adminToken: "admin-a", debugLog() {},
  });
  vm.runInContext(source, context);
  Object.assign(context, {
    openJamPanel() {},
    renderJamPlaylistSummary() {},
    renderJamPlaylistItems() {},
    renderJamPlaylistSelectionControls() {},
    renderQueue() {},
    renderJamQueueRemovalControls() {},
    jamSetBusy() {},
    jamSetViewStatus: (id, message, tone) => status.push({ id, message, tone }),
    apiUrl: (url) => url,
    jamRequestId: () => "request-a",
    jamActionAllowed: () => true,
    fetchJamState: async () => {},
  });
  return { context, status };
}

test("Song Radio ignores an older response even when it finishes parsing after a newer song", async () => {
  const { context } = harness();
  const oldBody = deferred();
  const opened = [];
  const requests = [];
  context.openJamPlaylistDetail = (value, opener, seed) => opened.push(seed.spotify_id);
  context.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: () => url.includes(trackId) ? oldBody.promise : Promise.resolve({ seed_track_id: secondId, playlist }) };
  };
  const old = context.openJamSongRadio(track());
  await Promise.resolve();
  await context.openJamSongRadio(track(secondId));
  oldBody.resolve({ seed_track_id: trackId, playlist });
  await old;
  assert.deepEqual(opened, [secondId]);
  assert.equal(requests[0].options.headers["X-Echo-Participant-Token"], "participant-a");
  assert.equal(requests[0].options.signal.aborted, true);
});

test("leaving Song Radio invalidates its in-flight resolution without opening late detail", async () => {
  const { context } = harness();
  const response = deferred();
  let opened = false;
  context.openJamPlaylistDetail = () => { opened = true; };
  context.fetch = () => response.promise;
  const loading = context.openJamSongRadio(track());
  context.setJamView("search", false);
  response.resolve({ ok: true, json: async () => ({ seed_track_id: trackId, playlist }) });
  await loading;
  assert.equal(opened, false);
  assert.equal(context._jamPlaylistLoading, false);
});

test("Song Radio rejects mismatched seed metadata instead of inventing a radio playlist", async () => {
  const { context, status } = harness();
  let opened = false;
  context.openJamPlaylistDetail = () => { opened = true; };
  context.fetch = async () => ({ ok: true, json: async () => ({ seed_track_id: secondId, playlist }) });
  await context.openJamSongRadio(track());
  assert.equal(opened, false);
  assert.match(status.at(-1).message, /unavailable for this song/);
});

test("Song Radio batches the first 250 source positions and retries only remaining positions", () => {
  const { context } = harness();
  Object.assign(context, {
    _jamPlaylist: playlist,
    _jamPlaylistRadioSeed: track(),
    _jamPlaylistTotal: 500,
    _jamState: { generation: 7 },
    _jamContract: { playlistSelectionSupported: true },
    enqueueJamPlaylist: (action) => action,
  });
  const action = context.addPlaylistToQueue();
  assert.equal(action.selected_positions.length, 250);
  assert.equal(action.selected_positions[0], 0);
  assert.equal(action.selected_positions.at(-1), 249);
  assert.equal(action.snapshot_id, "snapshot-a");
  context._jamPlaylistSelectedPositions = new Set([5, 9]);
  context._jamPlaylistResumeRequired = true;
  assert.deepEqual(Array.from(context.addPlaylistToQueue().selected_positions), [5, 9]);
  assert.deepEqual(Array.from(context.jamPlaylistQueueActionContext([0, 249, 250, -1, 1.5]).selected_positions), [0, 249]);
});

test("Song Radio paging never exposes source position 250 and retains its seed after metadata refresh", async () => {
  const { context } = harness();
  Object.assign(context, { _jamPlaylist: playlist, _jamPlaylistRadioSeed: track() });
  context.fetch = async () => ({ ok: true, json: async () => ({
    playlist, total: 500, next_offset: 300,
    items: [249, 250].map((position) => ({ ...track(), playlist_position: position })),
  }) });
  await context.fetchJamPlaylistItems(200, false);
  assert.equal(context._jamPlaylistTotal, 250);
  assert.equal(context._jamPlaylistItems.length, 1);
  assert.equal(context._jamPlaylistItems[0].playlist_position, 249);
  assert.equal(context._jamPlaylistNextOffset, null);
  assert.equal(context._jamPlaylistRadioSeed.spotify_id, trackId);
});

function queueState(generation = 7) {
  return {
    generation, queue_revision: 3, queue_clear_supported: true,
    queue: [
      { queue_entry_id: "playing", delivery_state: "spotify_committed", can_remove: false },
      { queue_entry_id: "waiting", delivery_state: "pending", can_remove: true },
    ],
  };
}

test("Clear All sends a revision-guarded batch and reports Spotify-controlled songs retained", async () => {
  const { context, status } = harness();
  context._jamState = queueState();
  let request;
  context.fetch = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ removed_entry_ids: ["waiting"], removed_count: 1, retained_count: 1, queue_revision: 4 }) };
  };
  await context.clearJamQueue();
  assert.equal(request.url, "/api/jam/queue/clear");
  assert.deepEqual(request.body, { generation: 7, request_id: "request-a", expected_queue_revision: 3 });
  assert.deepEqual(context._jamState.queue.map((row) => row.queue_entry_id), ["playing"]);
  assert.match(status.at(-1).message, /1 already controlled by Spotify remain/);
  assert.equal(context._jamQueueRemovalPending, false);
});

test("an old Clear All receipt cannot mutate a new Jam or unlock its pending operation", async () => {
  const { context } = harness();
  const first = deferred();
  const second = deferred();
  let count = 0;
  context._jamState = queueState();
  context.fetch = () => (++count === 1 ? first.promise : second.promise);
  const old = context.clearJamQueue();
  context._jamQueueRemovalEpoch += 1;
  context._jamQueueRemovalPending = false;
  context._jamState = queueState(8);
  const current = context.clearJamQueue();
  const receipt = { ok: true, json: async () => ({ removed_entry_ids: ["waiting"], removed_count: 1, queue_revision: 4 }) };
  first.resolve(receipt);
  await old;
  assert.equal(context._jamState.queue.length, 2);
  assert.equal(context._jamQueueRemovalPending, true);
  second.resolve(receipt);
  await current;
  assert.equal(context._jamState.queue.length, 1);
  assert.equal(context._jamQueueRemovalPending, false);
});

test("failed refresh after Clear All conflict leaves actionable feedback", async () => {
  const { context, status } = harness();
  context._jamState = queueState();
  context.fetch = async () => ({ ok: false, status: 409 });
  context.fetchJamState = async () => { context._jamState = null; };
  await context.clearJamQueue();
  assert.match(status.at(-1).message, /could not refresh/);
  assert.equal(status.at(-1).tone, "error");
  assert.equal(context._jamQueueRemovalPending, false);
});
