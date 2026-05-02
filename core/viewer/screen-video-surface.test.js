const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const gridJs = fs.readFileSync(path.join(__dirname, "participants-grid.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");

test("screen tiles do not apply a render-size cap", () => {
  assert.equal(gridJs.includes("computeScreenRenderCap"), false);
  assert.equal(gridJs.includes("applyScreenRenderCap"), false);
  assert.equal(gridJs.includes("maxWidth ="), false);
  assert.equal(gridJs.includes("maxHeight ="), false);
});

test("screen video elements receive the protected surface class", () => {
  assert.match(gridJs, /element\.classList\.add\("screen-video-surface"\)/);
});

test("protected video surface rules avoid direct filters and clipping", () => {
  const match = css.match(/\.screens-grid \.tile video\.screen-video-surface\s*\{([^}]*)\}/);
  assert.ok(match, "missing .screens-grid .tile video.screen-video-surface rule");
  assert.equal(/filter\s*:/.test(match[1]), false);
  assert.equal(/backdrop-filter\s*:/.test(match[1]), false);
  assert.equal(/border-radius\s*:/.test(match[1]), false);
  assert.equal(/box-shadow\s*:/.test(match[1]), false);
});
