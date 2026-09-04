const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup() {
  const sent = [];
  const local = { identity: "local", publications: [], publishData: (bytes, options) => {
    sent.push({ message: JSON.parse(new TextDecoder().decode(bytes)), options });
  } };
  const remote = { identity: "friend", publications: [] };
  const room = { localParticipant: local, remoteParticipants: new Map([[remote.identity, remote]]) };
  const context = { room, window: {}, TextEncoder, participantCards: new Map(),
    getParticipantPublications: participant => participant.publications };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "screen-share-state.js"), "utf8"), context);
  const screen = (sid) => ({ kind: "video", source: "screen_share", trackSid: sid });
  const message = (sid, title = "Onimusha: Way of the Sword") => ({
    type: "stream-activity", version: 1, trackSid: sid,
    source: { source_type: "game", source_title: title },
  });
  return { context, room, local, remote, sent, screen, message };
}

test("activity describes the selected game/window and uses honest desktop/browser fallbacks", () => {
  const { context: c } = setup();
  assert.equal(c.streamActivityLabel({ source_type: "game", source_title: "Onimusha: Way of the Sword" }), "Playing Onimusha: Way of the Sword");
  assert.equal(c.streamActivityLabel({ source_type: "window", source_title: "Paint" }), "Sharing Paint");
  assert.equal(c.streamActivityLabel({ source_type: "monitor", source_title: "Monitor 1" }), "Sharing desktop");
  assert.equal(c.streamActivityLabel({ source_type: "browser", source_title: "browser" }), "Sharing browser tab");
  assert.equal(c.streamActivityLabel({ source_type: "browser", source_title: "private tab title" }), "Sharing screen");
  assert.equal(c.streamActivityLabel(null), "Sharing screen");
});

test("activity strings are bounded plain text with control and bidi characters removed", () => {
  const { context: c } = setup();
  const normalized = c.normalizeStreamActivity({ source_type: "game", source_title: " A\u202e\n B " + "x".repeat(300), source_id: "private handle" });
  assert.equal(normalized.source_title.length, 160);
  assert.match(normalized.source_title, /^A B /);
  assert.equal(normalized.source_id, undefined);
  assert.equal(c.normalizeStreamActivity({ source_type: "invented", source_title: "Game" }), null);
});

test("activity arriving before publication becomes visible only on its own track", () => {
  const { context: c, remote, room, screen, message } = setup();
  assert.equal(c.receiveStreamActivity(message("old"), remote, room), true);
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Sharing screen");
  remote.publications = [screen("old")];
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Playing Onimusha: Way of the Sword");
  remote.publications = [screen("new")];
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Sharing screen");
  c.receiveStreamActivity(message("new", "Brotato"), remote, room);
  c.receiveStreamActivity({ ...message("old"), source: null }, remote, room);
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Playing Brotato");
  remote.publications = [];
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Sharing screen");
});

test("native companion tracks resolve their parent activity without depending on subscription", () => {
  const { context: c, remote, room, screen, message } = setup();
  const companion = { identity: "friend$screen", publications: [screen("native")] };
  room.remoteParticipants.set(companion.identity, companion);
  c.receiveStreamActivity(message("native"), remote, room);
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Playing Onimusha: Way of the Sword");
  assert.equal(c.receiveStreamActivity(message("native"), companion, room), false);
  room.remoteParticipants.delete(companion.identity);
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Sharing screen");
});

test("room replacement, sender replacement, and anonymous/spoofed messages cannot label another participant", () => {
  const { context: c, remote, room, screen, message } = setup();
  remote.publications = [screen("screen")];
  assert.equal(c.receiveStreamActivity(message("screen"), null, room), false);
  assert.equal(c.receiveStreamActivity(message("screen"), { ...remote }, room), false);
  assert.equal(c.receiveStreamActivity(message("screen"), remote, { ...room }), false);
  c.receiveStreamActivity({ ...message("screen"), identity: "local" }, remote, room);
  assert.equal(c.participantStreamActivityLabel("local"), "Sharing screen");
  room.remoteParticipants.set(remote.identity, { ...remote });
  assert.equal(c.participantStreamActivityLabel(remote.identity), "Sharing screen");
  assert.equal(c.receiveStreamActivity(message("screen"), remote, room), false);
});

test("publishing deduplicates, targets late joiners, clears stopped shares, and emits only source description", () => {
  const { context: c, local, sent, screen } = setup();
  local.publications = [screen("local-screen")];
  c.window._echoCaptureSourceReport = { source_type: "game", source_title: "Brotato", source_id: "hwnd", monitor_id: "id" };
  c.broadcastStreamActivity();
  c.broadcastStreamActivity();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].message.source, { source_type: "game", source_title: "Brotato" });
  c.broadcastStreamActivity("new-friend");
  assert.equal(sent.length, 2);
  assert.deepEqual(Array.from(sent[1].options.destinationIdentities), ["new-friend"]);
  local.publications = [];
  c.broadcastStreamActivity();
  assert.equal(sent.at(-1).message.source, null);
  assert.equal(sent.at(-1).message.trackSid, "local-screen");
});

test("failed publication can retry and a stale rejection does not clear a newer send", async () => {
  const { context: c, local, screen } = setup();
  local.publications = [screen("screen")];
  let rejectFirst;
  local.publishData = () => new Promise((_, reject) => { rejectFirst = reject; });
  c.broadcastStreamActivity();
  const rejectOld = rejectFirst;
  c.window._echoCaptureSourceReport = { source_type: "game", source_title: "New game" };
  local.publishData = () => Promise.resolve();
  c.broadcastStreamActivity();
  rejectOld(new Error("old connection"));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(c.sentStreamActivityByParticipant.get(local).key, /New game/);
  local.publishData = () => Promise.reject(new Error("offline"));
  c.broadcastStreamActivity("joining");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.sentStreamActivityByParticipant.has(local), false);
});

test("reconnect query requests current descriptions without changing capture state", () => {
  const { context: c, sent } = setup();
  c.requestStreamActivities();
  assert.equal(sent[0].message.type, "stream-activity-query");
  assert.equal(sent[0].options.reliable, true);
  assert.equal(c.window._echoCaptureSourceReport, undefined);
});
