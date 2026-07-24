const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const zlib = require("node:zlib");

const {
  ANIMATED_THEME_IDS,
  EFFECT_PROFILES,
  MOTION_BUDGETS,
  computeCanvasSize,
  createThemeEffectController,
  resolveEffectRequest,
} = require("./theme-effects.js");

function createEffectHarness() {
  let nextFrameId = 1;
  let nextTimerId = 1;
  let clock = 0;
  const frames = new Map();
  const timers = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const canvases = [];
  const context = {
    arc() {},
    beginPath() {},
    clearRect() {},
    fill() {},
    fillRect() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    stroke() {},
  };
  const body = {
    prepend(canvas) {
      canvas.isConnected = true;
    },
  };
  const document = {
    body,
    hidden: false,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    createElement(tagName) {
      assert.equal(tagName, "canvas");
      const canvas = {
        className: "",
        dataset: {},
        height: 0,
        id: "",
        isConnected: false,
        style: {},
        width: 0,
        getContext() {
          return context;
        },
        remove() {
          canvas.isConnected = false;
        },
        setAttribute() {},
      };
      canvases.push(canvas);
      return canvas;
    },
    removeEventListener(type, listener) {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    },
  };
  const window = {
    devicePixelRatio: 4,
    innerHeight: 4320,
    innerWidth: 7680,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    removeEventListener(type, listener) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    },
    setTimeout(callback, delay) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, {
        callback,
        dueAt: clock + Math.max(0, Number(delay) || 0),
      });
      return id;
    },
  };

  function dispatchDocument(type) {
    const listener = documentListeners.get(type);
    if (listener) listener();
  }

  function dispatchWindow(type) {
    const listener = windowListeners.get(type);
    if (listener) listener();
  }

  function step(timestamp) {
    clock = timestamp;
    let dueTimers = Array.from(timers.entries()).filter(([, timer]) => (
      timer.dueAt <= timestamp
    ));
    while (dueTimers.length) {
      dueTimers.forEach(([id, timer]) => {
        timers.delete(id);
        timer.callback();
      });
      dueTimers = Array.from(timers.entries()).filter(([, timer]) => (
        timer.dueAt <= timestamp
      ));
    }
    const pending = Array.from(frames.entries());
    frames.clear();
    pending.forEach(([, callback]) => callback(timestamp));
  }

  const controller = createThemeEffectController({
    document,
    now: () => clock,
    random: () => 0.42,
    window,
  });

  return {
    canvases,
    controller,
    dispatchDocument,
    dispatchWindow,
    document,
    frames,
    step,
    timers,
    window,
  };
}

test("Animated Worlds share strict lightweight budgets", () => {
  assert.deepEqual(ANIMATED_THEME_IDS, [
    "matrix",
    "event-horizon",
    "tempest",
    "abyss",
    "neon-wilds",
    "ultra-instinct",
  ]);
  assert.equal(MOTION_BUDGETS.ambient.fpsCap, 12);
  assert.equal(MOTION_BUDGETS.full.fpsCap, 24);
  assert.ok(MOTION_BUDGETS.ambient.maxPixels <= 480000);
  assert.ok(MOTION_BUDGETS.full.maxPixels <= 1050000);
  ANIMATED_THEME_IDS.forEach((themeId) => {
    assert.ok(EFFECT_PROFILES[themeId].entities.ambient <= 96);
    assert.ok(EFFECT_PROFILES[themeId].entities.full <= 96);
  });
});

test("procedural effects stay asset-free and tiny over the wire", () => {
  const source = fs.readFileSync(require.resolve("./theme-effects.js"), "utf8");
  assert.ok(zlib.gzipSync(source).byteLength <= 8192);
  assert.doesNotMatch(
    source,
    /fetch\s*\(|new\s+Image\b|createRadialGradient|createElement\s*\([^)]*["'](?:audio|video)["']/,
  );
});

test("canvas sizing caps extreme 8K and high-DPR displays", () => {
  const ambient = computeCanvasSize(7680, 4320, 4, {
    maxDpr: MOTION_BUDGETS.ambient.maxDpr,
    maxPixels: MOTION_BUDGETS.ambient.maxPixels,
  });
  const full = computeCanvasSize(7680, 4320, 4, {
    maxDpr: MOTION_BUDGETS.full.maxDpr,
    maxPixels: MOTION_BUDGETS.full.maxPixels,
  });
  assert.ok(ambient.pixels <= 480000);
  assert.ok(full.pixels <= 1050000);
  assert.ok(ambient.scale <= 1);
  assert.ok(full.scale <= 1.25);
});

test("only a global Animated World with effective motion requests a renderer", () => {
  assert.equal(resolveEffectRequest({
    effectiveMotion: "full",
    globalTheme: "frost",
    resolvedThemes: { chat: "matrix" },
  }), null);
  assert.equal(resolveEffectRequest({
    effectiveMotion: "still",
    globalTheme: "matrix",
  }), null);
  assert.deepEqual(
    resolveEffectRequest({
      effectiveMotion: "ambient",
      globalTheme: "event-horizon",
    }),
    {
      canvasId: "event-horizon-field",
      entityCap: 44,
      fpsCap: 12,
      kind: "event-horizon",
      maxDpr: 1,
      maxPixels: 480000,
      motion: "ambient",
    },
  );
});

test("one reusable renderer stays capped, pauses hidden, and tears down cleanly", () => {
  const harness = createEffectHarness();
  harness.controller.sync({ effectiveMotion: "ambient", globalTheme: "matrix" });
  assert.equal(harness.canvases.length, 1);
  assert.equal(harness.frames.size, 1);
  const sharedCanvas = harness.canvases[0];
  assert.ok(Number(sharedCanvas.dataset.effectBackingPixels) <= 480000);
  assert.equal(sharedCanvas.dataset.effectFpsCap, "12");
  assert.equal(sharedCanvas.dataset.effectEntityCap, "42");

  for (let tick = 0; tick <= 120; tick += 1) {
    harness.step(tick * (1000 / 120));
  }
  const ambientDraws = harness.controller.getMetrics().drawCount;
  const ambientCallbacks = harness.controller.getMetrics().frameCallbackCount;
  assert.ok(ambientDraws >= 10 && ambientDraws <= 13);
  assert.ok(ambientCallbacks <= 14);
  assert.equal(harness.frames.size + harness.timers.size, 1);

  harness.controller.sync({ effectiveMotion: "full", globalTheme: "event-horizon" });
  assert.equal(harness.canvases.length, 1);
  assert.equal(harness.canvases[0], sharedCanvas);
  assert.equal(sharedCanvas.dataset.themeEffect, "event-horizon");
  assert.ok(Number(sharedCanvas.dataset.effectBackingPixels) <= 1050000);
  const fullStart = harness.controller.getMetrics().drawCount;
  for (let tick = 121; tick <= 241; tick += 1) {
    harness.step(tick * (1000 / 120));
  }
  const fullDraws = harness.controller.getMetrics().drawCount - fullStart;
  assert.ok(fullDraws >= 20 && fullDraws <= 25);
  assert.ok(
    harness.controller.getMetrics().frameCallbackCount - ambientCallbacks <= 26
  );

  ["tempest", "abyss", "neon-wilds", "ultra-instinct", "matrix"].forEach((themeId) => {
    harness.controller.sync({ effectiveMotion: "full", globalTheme: themeId });
    assert.equal(harness.canvases.length, 1);
    assert.equal(harness.canvases[0], sharedCanvas);
    assert.equal(harness.frames.size, 1);
  });

  for (let index = 0; index < 20; index += 1) harness.dispatchWindow("resize");
  assert.equal(harness.frames.size, 1);

  harness.document.hidden = true;
  harness.dispatchDocument("visibilitychange");
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 0);
  const hiddenDraws = harness.controller.getMetrics().drawCount;
  harness.step(3000);
  assert.equal(harness.controller.getMetrics().drawCount, hiddenDraws);

  harness.document.hidden = false;
  harness.dispatchDocument("visibilitychange");
  assert.equal(harness.frames.size, 1);
  harness.step(3010);
  assert.ok(harness.controller.getMetrics().drawCount > hiddenDraws);

  harness.controller.sync({ effectiveMotion: "still", globalTheme: "matrix" });
  assert.equal(sharedCanvas.isConnected, false);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 0);
  harness.controller.destroy();
  assert.equal(harness.controller.getMetrics().canvasConnected, false);
});
