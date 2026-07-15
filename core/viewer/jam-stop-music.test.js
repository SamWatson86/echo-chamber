const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const viewerDir = __dirname;
const jamSource = fs.readFileSync(path.join(viewerDir, "jam.js"), "utf8");
const indexSource = fs.readFileSync(path.join(viewerDir, "index.html"), "utf8");

function functionSource(name, nextName) {
  const start = jamSource.indexOf(`async function ${name}(`);
  const end = jamSource.indexOf(`async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} is present`);
  assert.notEqual(end, -1, `${nextName} follows ${name}`);
  return jamSource.slice(start, end);
}

test("Stop Music is a distinct red playback control", () => {
  assert.match(indexSource, /id="jam-stop-btn"[^>]*class="jam-stop-btn"[^>]*>Stop Music<\/button>/);
  assert.match(indexSource, /Stops Spotify playback for everyone; the Jam stays open/);
});

test("Stop Music never tears down Jam membership or listener audio", () => {
  const handler = functionSource("stopJamPlayback", "skipTrack");

  assert.match(handler, /\/api\/jam\/playback\/stop/);
  assert.match(handler, /jam-playback-stopped/);
  assert.doesNotMatch(handler, /\/api\/jam\/stop["']/);
  assert.doesNotMatch(handler, /stopJamAudioStream/);
  assert.doesNotMatch(handler, /leaveSucceeded/);
  assert.doesNotMatch(handler, /_jamListeningGeneration\s*=\s*null/);
});
