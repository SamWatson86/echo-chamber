const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeCanvasSize,
  computeLogBandRanges,
  sampleSpectrumBands,
  computeSpectrumBars,
  resolveVisualizerState,
  frameIntervalForMotion,
  createAnalysisGraph,
  connectSource,
  createJamVisualizerController,
} = require("./jam-visualizer.js");

test("canvas and spectrum geometry stay finite and inside their budgets", () => {
  const ordinary = computeCanvasSize(340, 64, 2, { dprCap: 1.25, pixelBudget: 180000 });
  assert.equal(ordinary.width, 425);
  assert.equal(ordinary.height, 80);
  assert.equal(ordinary.pixels, 34000);

  const extreme = computeCanvasSize(7680, 4320, 4, { dprCap: 1.25, pixelBudget: 180000 });
  assert.ok(extreme.width > 0);
  assert.ok(extreme.height > 0);
  assert.ok(extreme.pixels <= 180000);

  const ranges = computeLogBandRanges(256, 32);
  assert.equal(ranges.length, 32);
  for (const range of ranges) {
    assert.ok(Number.isInteger(range.start));
    assert.ok(Number.isInteger(range.end));
    assert.ok(range.start >= 0);
    assert.ok(range.end > range.start);
    assert.ok(range.end <= 256);
  }

  const silence = new Uint8Array(256);
  const energy = new Uint8Array(256).fill(220);
  const silentLevels = sampleSpectrumBands(silence, ranges, [], 0.84);
  const energeticLevels = sampleSpectrumBands(energy, ranges, [], 0.84);
  assert.ok(energeticLevels.every((level, index) => level > silentLevels[index]));

  const bars = computeSpectrumBars(energeticLevels, 340, 64);
  assert.equal(bars.length, 32);
  for (const bar of bars) {
    for (const value of [bar.x, bar.width, bar.top, bar.height, bar.reflectionTop, bar.reflectionHeight]) {
      assert.ok(Number.isFinite(value));
      assert.ok(value >= 0);
    }
    assert.ok(bar.x + bar.width <= 340.001);
    assert.ok(bar.top + bar.height <= 64.001);
    assert.ok(bar.reflectionTop + bar.reflectionHeight <= 64.001);
  }
});

test("visualizer state distinguishes real audio, connection, fallback, and reduced motion", () => {
  const base = {
    playing: true,
    streamReady: true,
    analyserAvailable: true,
    contextState: "running",
    motion: "full",
  };
  assert.equal(resolveVisualizerState(base), "live");
  assert.equal(resolveVisualizerState({ ...base, motion: "ambient" }), "live");
  assert.equal(resolveVisualizerState({ ...base, motion: "still" }), "still");
  assert.equal(resolveVisualizerState({ ...base, streamReady: false, streamConnecting: true }), "connecting");
  assert.equal(resolveVisualizerState({ ...base, streamReady: false, streamConnecting: false }), "waiting");
  assert.equal(resolveVisualizerState({ ...base, analyserAvailable: false }), "unavailable");
  assert.equal(resolveVisualizerState({ ...base, contextState: "suspended" }), "connecting");
  assert.equal(resolveVisualizerState({ ...base, playing: false }), "idle");
  assert.equal(frameIntervalForMotion("full"), 1000 / 24);
  assert.equal(frameIntervalForMotion("ambient"), 1000 / 12);
  assert.equal(frameIntervalForMotion("still"), Number.POSITIVE_INFINITY);
});

test("analysis is a muted optional branch and cannot replace Jam playback", () => {
  const destination = { name: "destination" };
  const connections = [];
  let analyserDisconnected = 0;
  let sinkDisconnected = 0;
  const analyser = {
    connect(target) { connections.push(["analyser", target]); },
    disconnect() { analyserDisconnected += 1; },
  };
  const sink = {
    gain: { value: 1 },
    connect(target) { connections.push(["sink", target]); },
    disconnect() { sinkDisconnected += 1; },
  };
  const graph = createAnalysisGraph({
    destination,
    createAnalyser() { return analyser; },
    createGain() { return sink; },
  });

  assert.equal(graph.available, true);
  assert.equal(sink.gain.value, 0);
  assert.equal(analyser.fftSize, 512);
  assert.deepEqual(connections, [["analyser", sink], ["sink", destination]]);

  const playbackGain = { name: "playback" };
  const sourceConnections = [];
  const source = { connect(target) { sourceConnections.push(target); } };
  assert.equal(connectSource(source, playbackGain, analyser), true);
  assert.deepEqual(sourceConnections, [playbackGain, analyser]);

  graph.destroy();
  graph.destroy();
  assert.equal(analyserDisconnected, 1);
  assert.equal(sinkDisconnected, 1);

  const fallback = createAnalysisGraph({
    destination,
    createAnalyser() { throw new Error("unsupported"); },
    createGain() { throw new Error("must not matter"); },
  });
  assert.equal(fallback.available, false);

  const failingSourceConnections = [];
  const failingSource = {
    connect(target) {
      failingSourceConnections.push(target);
      if (target === analyser) throw new Error("analysis branch failed");
    },
  };
  assert.equal(connectSource(failingSource, playbackGain, analyser), false);
  assert.equal(failingSourceConnections[0], playbackGain);
});

function createControllerHarness() {
  const callbacks = new Map();
  let nextFrameId = 1;
  let resizeCallback = null;
  let mutationCallback = null;
  const listeners = new Map();
  const root = {
    hidden: false,
    dataset: {},
    clientWidth: 340,
    clientHeight: 64,
    getBoundingClientRect() { return { width: 340, height: 64 }; },
  };
  const canvasContext = {
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    createLinearGradient() { return { addColorStop() {} }; },
  };
  const canvas = {
    width: 0,
    height: 0,
    dataset: {},
    style: {},
    getContext() { return canvasContext; },
  };
  const status = { textContent: "" };
  const panel = {
    hidden: false,
    inert: false,
    classList: { contains() { return false; } },
  };
  const documentElement = { dataset: { themeMotionEffective: "full" } };
  const document = {
    hidden: false,
    documentElement,
    getElementById(id) {
      return {
        "jam-audio-visualizer": root,
        "jam-audio-visualizer-canvas": canvas,
        "jam-audio-visualizer-status": status,
        "jam-panel": panel,
      }[id] || null;
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const window = {
    document,
    devicePixelRatio: 2,
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    getComputedStyle() { return { getPropertyValue() { return ""; } }; },
    ResizeObserver: class {
      constructor(callback) { resizeCallback = callback; }
      observe() {}
      disconnect() { resizeCallback = null; }
    },
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe() {}
      disconnect() { mutationCallback = null; }
    },
  };
  const controller = createJamVisualizerController({ window, document, root, canvas, status });
  return {
    controller,
    root,
    canvas,
    status,
    panel,
    document,
    documentElement,
    callbacks,
    triggerResize() { if (resizeCallback) resizeCallback([]); },
    triggerMutation() { if (mutationCallback) mutationCallback([]); },
    step(timestamp) {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      for (const [, callback] of pending) callback(timestamp);
    },
  };
}

test("controller owns one capped loop and stops for still, hidden, idle, and destroy", () => {
  const harness = createControllerHarness();
  const analyser = {
    frequencyBinCount: 256,
    fftSize: 512,
    getByteFrequencyData(target) {
      for (let index = 0; index < target.length; index += 1) target[index] = (index * 17) % 255;
    },
    getByteTimeDomainData(target) {
      for (let index = 0; index < target.length; index += 1) target[index] = 128 + Math.round(Math.sin(index / 8) * 48);
    },
  };
  const audioContext = { state: "running" };

  harness.controller.update({
    playing: true,
    streamReady: true,
    streamConnecting: false,
    analyser,
    audioContext,
  });
  harness.controller.update({ playing: true, analyser, audioContext });
  assert.equal(harness.controller.snapshot().state, "live");
  assert.equal(harness.callbacks.size, 1);
  assert.equal(harness.root.hidden, false);
  assert.equal(harness.root.dataset.reactive, "true");

  for (let frame = 0; frame <= 120; frame += 1) harness.step((frame * 1000) / 120);
  const active = harness.controller.snapshot();
  assert.ok(active.drawCount >= 23 && active.drawCount <= 25, `draw count was ${active.drawCount}`);
  assert.equal(harness.callbacks.size, 1);
  assert.ok(active.backingPixels > 0 && active.backingPixels <= 180000);

  harness.panel.inert = true;
  harness.triggerMutation();
  assert.equal(harness.callbacks.size, 0);
  harness.panel.inert = false;
  harness.triggerMutation();
  assert.equal(harness.callbacks.size, 1);

  harness.documentElement.dataset.themeMotionEffective = "still";
  harness.controller.refresh();
  const still = harness.controller.snapshot();
  assert.equal(still.state, "still");
  assert.equal(still.frameScheduled, false);
  assert.equal(harness.root.dataset.reactive, "false");
  assert.equal(harness.callbacks.size, 0);
  for (let resize = 0; resize < 20; resize += 1) harness.triggerResize();
  assert.equal(harness.callbacks.size, 1);
  harness.step(1100);
  assert.equal(harness.callbacks.size, 0);

  harness.document.hidden = true;
  harness.controller.refresh();
  assert.equal(harness.callbacks.size, 0);
  harness.document.hidden = false;
  harness.documentElement.dataset.themeMotionEffective = "full";
  harness.controller.refresh();
  assert.equal(harness.callbacks.size, 1);

  harness.controller.update({ playing: false });
  assert.equal(harness.controller.snapshot().state, "idle");
  assert.equal(harness.root.hidden, true);
  assert.equal(harness.callbacks.size, 0);

  harness.controller.destroy();
  assert.equal(harness.controller.snapshot().destroyed, true);
  assert.equal(harness.callbacks.size, 0);
});
