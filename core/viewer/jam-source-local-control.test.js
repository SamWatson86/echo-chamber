const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const viewerDir = __dirname;
const jamSource = fs.readFileSync(path.join(viewerDir, "jam.js"), "utf8");
const indexSource = fs.readFileSync(path.join(viewerDir, "index.html"), "utf8");

function functionSource(name, nextName) {
  const start = jamSource.indexOf(`function ${name}(`);
  const asyncStart = jamSource.indexOf(`async function ${name}(`);
  const actualStart = start === -1 ? asyncStart : start;
  const next = jamSource.indexOf(`function ${nextName}(`, actualStart + 1);
  const asyncNext = jamSource.indexOf(`async function ${nextName}(`, actualStart + 1);
  const actualNext = [next, asyncNext].filter((value) => value !== -1).sort((a, b) => a - b)[0];
  assert.notEqual(actualStart, -1, `${name} is present`);
  assert.notEqual(actualNext, undefined, `${nextName} follows ${name}`);
  return jamSource.slice(actualStart, actualNext);
}

test("source-PC switches appear in synchronized portal and Jam cards", () => {
  assert.equal((indexSource.match(/data-jam-source-local-card/g) || []).length, 2);
  assert.equal((indexSource.match(/>Allow Echo Jam to use Spotify on this PC</g) || []).length, 2);
  assert.equal((indexSource.match(/>Hear Jam on this PC</g) || []).length, 2);
  assert.equal((indexSource.match(/data-jam-source-takeover-toggle/g) || []).length, 2);
  assert.equal((indexSource.match(/data-jam-source-monitor-toggle/g) || []).length, 2);
  assert.ok(
    indexSource.indexOf("data-jam-source-local-card") < indexSource.indexOf('<div class="portal-form">'),
    "the source-PC controls are available before Echo Connect",
  );
});

test("source-PC controls boot before login and refresh with Jam polling", () => {
  assert.match(jamSource, /DOMContentLoaded", initJamSourceLocalControlUi/);
  assert.match(jamSource, /else\s*{\s*initJamSourceLocalControlUi\(\);\s*}/);

  const refresh = functionSource("refreshJamSourceLocalControl", "setJamSourceLocalControl");
  assert.match(refresh, /tauriInvoke\("get_jam_source_local_control"\)/);

  const poll = functionSource("fetchJamState", "renderJamPanel");
  assert.match(poll, /refreshJamSourceLocalControl\(\)/);

  const init = functionSource("initJamSourceLocalControlUi", "detectJamSourceHost");
  assert.match(init, /setInterval\(refreshJamSourceLocalControl, 2000\)/);
});

test("both source-PC settings use their native IPC setters", () => {
  const setter = functionSource("setJamSourceLocalControl", "bindJamSourceLocalControls");
  assert.match(setter, /set_jam_source_takeover_enabled/);
  assert.match(setter, /set_jam_source_monitor_enabled/);
  assert.match(setter, /tauriInvoke\(command,\s*{ enabled: enabled === true }\)/);
});

test("source relay muting never overwrites the independent Jam volume", () => {
  const mute = functionSource("muteSourceHostRelayIfNeeded", "evaluateJamServerContract");
  assert.match(mute, /applyJamRelayGain\(\)/);
  assert.doesNotMatch(mute, /_jamVolume\s*=/);
  assert.doesNotMatch(mute, /jam-volume-slider/);

  const routingHook = functionSource("installJamRelayAudioRoutingHook", "refreshJamSourceLocalControl");
  assert.match(routingHook, /originalSetRoomAudioMutedState\(next\)/);
  assert.match(routingHook, /applyJamRelayGain\(\)/);
});
