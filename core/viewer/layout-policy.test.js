const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
  DEFAULT_MODE_THRESHOLDS,
  MODES,
  MODE_ORDER,
  chooseOptimalGrid,
  classifyLayoutMode,
  fitAspectRatio,
  isMode,
  listGridCandidates,
  normalizeGeometry,
  normalizeThresholds,
  resolveLayoutMode,
  resolveLayoutPolicy,
  scoreGridCandidate,
} = require("./layout-policy.js");

const EPSILON = 1e-7;

function approximatelyEqual(actual, expected, epsilon = EPSILON) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test("browser build exposes the same policy through EchoLayoutPolicy", () => {
  const source = fs.readFileSync(path.join(__dirname, "layout-policy.js"), "utf8");
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: "layout-policy.js" });

  assert.equal(typeof context.globalThis.EchoLayoutPolicy, "object");
  assert.equal(
    context.globalThis.EchoLayoutPolicy.resolveLayoutMode({ width: 1280, height: 720 }),
    MODES.THEATER
  );
  assert.equal(typeof context.globalThis.EchoLayoutPolicy.chooseOptimalGrid, "function");
});

test("named layout modes are stable and ordered from smallest to largest", () => {
  assert.deepEqual(MODE_ORDER, [
    MODES.MINI,
    MODES.COMPACT,
    MODES.LOUNGE,
    MODES.THEATER,
  ]);
  for (const mode of MODE_ORDER) assert.equal(isMode(mode), true);
  assert.equal(isMode("desktop"), false);
  assert.equal(isMode(null), false);
});

test("geometry normalization is deterministic for invalid measurements", () => {
  assert.deepEqual(normalizeGeometry(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(normalizeGeometry("900", "600"), { width: 900, height: 600 });
  assert.deepEqual(normalizeGeometry(-1, Number.NaN), { width: 0, height: 0 });
  assert.deepEqual(normalizeGeometry(Infinity, undefined), { width: 0, height: 0 });
});

test("base classification changes exactly at every width and height boundary", () => {
  const cases = [
    [639, 2000, MODES.MINI],
    [640, 479, MODES.MINI],
    [640, 480, MODES.COMPACT],
    [899, 2000, MODES.COMPACT],
    [900, 599, MODES.COMPACT],
    [900, 600, MODES.LOUNGE],
    [1279, 2000, MODES.LOUNGE],
    [1280, 719, MODES.LOUNGE],
    [1280, 720, MODES.THEATER],
  ];

  for (const [width, height, expected] of cases) {
    assert.equal(classifyLayoutMode(width, height), expected, `${width}x${height}`);
  }
});

test("base classification is constrained by the weaker geometry axis", () => {
  assert.equal(classifyLayoutMode(2560, 479), MODES.MINI);
  assert.equal(classifyLayoutMode(2560, 480), MODES.COMPACT);
  assert.equal(classifyLayoutMode(2560, 600), MODES.LOUNGE);
  assert.equal(classifyLayoutMode(899, 1440), MODES.COMPACT);
  assert.equal(classifyLayoutMode(900, 1440), MODES.LOUNGE);
});

test("custom thresholds are monotonic even when overrides are malformed", () => {
  const thresholds = normalizeThresholds({
    compact: { minWidth: 700, minHeight: 500 },
    lounge: { minWidth: 600, minHeight: 400 },
    theater: { minWidth: -1, minHeight: Number.NaN },
    hysteresis: -20,
  });

  assert.deepEqual(thresholds.compact, { minWidth: 700, minHeight: 500 });
  assert.deepEqual(thresholds.lounge, { minWidth: 700, minHeight: 500 });
  assert.deepEqual(thresholds.theater, { minWidth: 1280, minHeight: 720 });
  assert.equal(thresholds.hysteresis, DEFAULT_MODE_THRESHOLDS.hysteresis);
});

test("unknown previous mode uses nominal thresholds without hysteresis", () => {
  assert.equal(resolveLayoutMode({ width: 1280, height: 720 }), MODES.THEATER);
  assert.equal(
    resolveLayoutMode({ width: 900, height: 600, previousMode: "unknown" }),
    MODES.LOUNGE
  );
});

test("every upward transition requires crossing both axes by hysteresis", () => {
  const h = DEFAULT_MODE_THRESHOLDS.hysteresis;
  const transitions = [
    [MODES.MINI, MODES.COMPACT],
    [MODES.COMPACT, MODES.LOUNGE],
    [MODES.LOUNGE, MODES.THEATER],
  ];

  for (const [from, to] of transitions) {
    const boundary = DEFAULT_MODE_THRESHOLDS[to];
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth + h - 1,
        height: boundary.minHeight + h,
        previousMode: from,
      }),
      from,
      `${from}->${to} waits for width`
    );
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth + h,
        height: boundary.minHeight + h - 1,
        previousMode: from,
      }),
      from,
      `${from}->${to} waits for height`
    );
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth + h,
        height: boundary.minHeight + h,
        previousMode: from,
      }),
      to,
      `${from}->${to} crosses at inclusive upper edge`
    );
  }
});

test("every downward transition retains mode through the lower hysteresis edge", () => {
  const h = DEFAULT_MODE_THRESHOLDS.hysteresis;
  const transitions = [
    [MODES.COMPACT, MODES.MINI],
    [MODES.LOUNGE, MODES.COMPACT],
    [MODES.THEATER, MODES.LOUNGE],
  ];

  for (const [from, to] of transitions) {
    const boundary = DEFAULT_MODE_THRESHOLDS[from];
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth - h,
        height: boundary.minHeight - h,
        previousMode: from,
      }),
      from,
      `${from} remains at inclusive lower edge`
    );
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth - h - 1,
        height: boundary.minHeight + h,
        previousMode: from,
      }),
      to,
      `${from}->${to} leaves on width`
    );
    assert.equal(
      resolveLayoutMode({
        width: boundary.minWidth + h,
        height: boundary.minHeight - h - 1,
        previousMode: from,
      }),
      to,
      `${from}->${to} leaves on height`
    );
  }
});

test("large geometry jumps can traverse every mode in one decision", () => {
  assert.equal(
    resolveLayoutMode({ width: 2000, height: 1200, previousMode: MODES.MINI }),
    MODES.THEATER
  );
  assert.equal(
    resolveLayoutMode({ width: 320, height: 240, previousMode: MODES.THEATER }),
    MODES.MINI
  );
});

test("hysteresis prevents repeated resize samples around all nominal boundaries", () => {
  const samples = [
    [MODES.COMPACT, 640, 480],
    [MODES.LOUNGE, 900, 600],
    [MODES.THEATER, 1280, 720],
  ];

  for (const [mode, width, height] of samples) {
    assert.equal(resolveLayoutMode({ width: width - 20, height, previousMode: mode }), mode);
    assert.equal(resolveLayoutMode({ width: width + 20, height, previousMode: mode }), mode);
    assert.equal(resolveLayoutMode({ width, height: height - 20, previousMode: mode }), mode);
    assert.equal(resolveLayoutMode({ width, height: height + 20, previousMode: mode }), mode);
  }
});

test("resolved policy exposes mode and height pressure without presentation commands", () => {
  assert.deepEqual(resolveLayoutPolicy({ width: 1400, height: 800 }), {
    mode: MODES.THEATER,
    width: 1400,
    height: 800,
    isShort: false,
    isVeryShort: false,
  });

  const mini = resolveLayoutPolicy({ width: 500, height: 500 });
  assert.equal(mini.mode, MODES.MINI);
  assert.equal(mini.isShort, true);
  assert.equal(mini.isVeryShort, true);
  assert.deepEqual(Object.keys(mini).sort(), [
    "height",
    "isShort",
    "isVeryShort",
    "mode",
    "width",
  ]);
});

test("aspect fitting honors landscape and portrait constraints exactly", () => {
  const heightLimited = fitAspectRatio(1000, 400, 16 / 9);
  approximatelyEqual(heightLimited.height, 400);
  approximatelyEqual(heightLimited.width, 400 * (16 / 9));

  const widthLimited = fitAspectRatio(400, 1000, 16 / 9);
  approximatelyEqual(widthLimited.width, 400);
  approximatelyEqual(widthLimited.height, 400 / (16 / 9));

  const portrait = fitAspectRatio(300, 300, 9 / 16);
  approximatelyEqual(portrait.height, 300);
  approximatelyEqual(portrait.width, 300 * (9 / 16));
});

test("source aspect fitting stays contained across 1080p, 4K, and ultrawide boxes", () => {
  const sourceAspects = [
    ["16:9", 16 / 9],
    ["16:10", 16 / 10],
    ["21:9", 21 / 9],
    ["32:9", 32 / 9],
    ["4:3", 4 / 3],
    ["portrait", 9 / 16],
  ];
  const containers = [
    ["1080p", 1920, 1080],
    ["4K", 3840, 2160],
    ["ultrawide", 3440, 1440],
    ["super-ultrawide", 5120, 1440],
  ];

  for (const [containerName, width, height] of containers) {
    for (const [aspectName, aspectRatio] of sourceAspects) {
      const fitted = fitAspectRatio(width, height, aspectRatio);
      const label = `${containerName} ${width}x${height}, source ${aspectName}`;
      assert.ok(fitted.width <= width + EPSILON, `${label} width`);
      assert.ok(fitted.height <= height + EPSILON, `${label} height`);
      approximatelyEqual(fitted.width / fitted.height, aspectRatio, 1e-9);
      assert.ok(
        Math.abs(fitted.width - width) <= EPSILON || Math.abs(fitted.height - height) <= EPSILON,
        `${label} must consume one constraining axis`
      );
    }
  }
});

test("aspect fitting returns safe zero geometry for unavailable space", () => {
  assert.deepEqual(fitAspectRatio(0, 100, 16 / 9), {
    width: 0,
    height: 0,
    area: 0,
    aspectRatio: 16 / 9,
  });
  assert.equal(fitAspectRatio(-10, Number.NaN, -1).area, 0);
});

test("candidate scoring accounts for gaps and incomplete final rows", () => {
  const candidate = scoreGridCandidate({
    width: 1000,
    height: 600,
    tileCount: 5,
    columns: 3,
    gap: 10,
    aspectRatio: 16 / 9,
  });

  assert.equal(candidate.valid, true);
  assert.equal(candidate.columns, 3);
  assert.equal(candidate.rows, 2);
  assert.equal(candidate.occupancy, 5 / 6);
  approximatelyEqual(candidate.cellWidth, (1000 - 20) / 3);
  approximatelyEqual(candidate.cellHeight, (600 - 10) / 2);
  assert.ok(candidate.totalWidth <= 1000 + EPSILON);
  assert.ok(candidate.totalHeight <= 600 + EPSILON);
});

test("candidate scoring rejects impossible column and space geometry", () => {
  assert.equal(scoreGridCandidate({ tileCount: 0, columns: 1 }).reason, "no-tiles");
  assert.equal(scoreGridCandidate({ tileCount: 3, columns: 0 }).reason, "invalid-columns");
  assert.equal(scoreGridCandidate({ tileCount: 3, columns: 4 }).reason, "invalid-columns");
  assert.equal(
    scoreGridCandidate({ width: 10, height: 10, tileCount: 2, columns: 2, gap: 20 }).reason,
    "insufficient-space"
  );
});

test("candidate listing is complete and ordered by column count", () => {
  const candidates = listGridCandidates({ width: 1200, height: 700, tileCount: 8 });
  assert.equal(candidates.length, 8);
  assert.deepEqual(candidates.map((candidate) => candidate.columns), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("optimal grids choose expected arrangements for representative shapes", () => {
  assert.deepEqual(
    { columns: chooseOptimalGrid({ width: 1280, height: 720, tileCount: 1 }).columns,
      rows: chooseOptimalGrid({ width: 1280, height: 720, tileCount: 1 }).rows },
    { columns: 1, rows: 1 }
  );

  const standardFour = chooseOptimalGrid({ width: 1280, height: 720, tileCount: 4 });
  assert.deepEqual({ columns: standardFour.columns, rows: standardFour.rows }, { columns: 2, rows: 2 });

  const wideFour = chooseOptimalGrid({ width: 2200, height: 360, tileCount: 4 });
  assert.deepEqual({ columns: wideFour.columns, rows: wideFour.rows }, { columns: 4, rows: 1 });

  const portraitThree = chooseOptimalGrid({ width: 500, height: 1200, tileCount: 3 });
  assert.deepEqual({ columns: portraitThree.columns, rows: portraitThree.rows }, { columns: 1, rows: 3 });
});

test("uniform per-tile aspect ratios preserve the original grid contract exactly", () => {
  const containers = [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
  ];
  const aspects = [16 / 9, 16 / 10, 21 / 9, 32 / 9, 4 / 3, 9 / 16];

  for (const container of containers) {
    for (const aspectRatio of aspects) {
      const options = { ...container, tileCount: 6, gap: 12, aspectRatio };
      assert.deepEqual(
        chooseOptimalGrid({ ...options, aspectRatios: Array(6).fill(aspectRatio) }),
        chooseOptimalGrid(options),
        `${container.width}x${container.height}, aspect=${aspectRatio}`
      );
    }
  }
});

test("mixed source aspects select and expose source-aware tile geometry", () => {
  const aspectRatios = [32 / 9, 9 / 16];
  const options = {
    width: 1920,
    height: 1080,
    tileCount: aspectRatios.length,
    gap: 12,
    aspectRatios,
  };
  const layout = chooseOptimalGrid(options);
  const uniformFallback = chooseOptimalGrid({
    width: options.width,
    height: options.height,
    tileCount: options.tileCount,
    gap: options.gap,
  });

  assert.deepEqual({ columns: uniformFallback.columns, rows: uniformFallback.rows }, { columns: 2, rows: 1 });
  assert.deepEqual(layout.aspectRatios, aspectRatios);
  assert.equal(layout.tileLayouts.length, aspectRatios.length);
  assert.equal(layout.positioned, true);
  assert.equal(layout.rowWidths.length, layout.rows);
  assert.equal(layout.rowHeights.length, layout.rows);
  assert.ok(layout.totalWidth <= options.width + EPSILON);
  assert.ok(layout.totalHeight <= options.height + EPSILON);

  layout.tileLayouts.forEach((tile, index) => {
    approximatelyEqual(tile.width / tile.height, aspectRatios[index], 1e-9);
    assert.ok(tile.x >= -EPSILON && tile.y >= -EPSILON);
    assert.ok(tile.x + tile.width <= layout.totalWidth + EPSILON);
    assert.ok(tile.y + tile.height <= layout.totalHeight + EPSILON);
    assert.ok(tile.height <= layout.rowHeights[tile.row] + EPSILON);
  });

  const candidates = listGridCandidates(options);
  assert.equal(layout.score, Math.max(...candidates.map((candidate) => candidate.score)));
});

test("mixed source grid selection is deterministic across representative display boxes", () => {
  const aspectRatios = [16 / 9, 16 / 10, 21 / 9, 32 / 9, 4 / 3, 9 / 16];
  const containers = [
    { width: 1920, height: 1080 },
    { width: 3840, height: 2160 },
    { width: 3440, height: 1440 },
    { width: 5120, height: 1440 },
  ];

  for (const container of containers) {
    const input = {
      ...container,
      tileCount: aspectRatios.length,
      gap: 12,
      aspectRatios,
    };
    const first = chooseOptimalGrid(input);
    assert.equal(first.valid, true);
    assert.equal(first.tileLayouts.length, aspectRatios.length);
    assert.ok(first.totalWidth <= container.width + EPSILON);
    assert.ok(first.totalHeight <= container.height + EPSILON);
    for (let index = 0; index < 25; index += 1) {
      assert.deepEqual(chooseOptimalGrid(input), first);
    }
  }
});

test("ultrawide and 16:9 shares align at a common height in a wide Stage", () => {
  const layout = chooseOptimalGrid({ width: 3022, height: 1121, tileCount: 2, gap: 12, aspectRatios: [1916 / 802, 16 / 9] });
  assert.equal(layout.columns, 2);
  const [wide, regular] = layout.tileLayouts;
  approximatelyEqual(wide.height, regular.height, 1e-9);
  approximatelyEqual(regular.x - (wide.x + wide.width), 12, 1e-9);
  assert.ok(wide.width > 1700, "ultrawide gets proportional width instead of a half-width cell");
  approximatelyEqual(wide.width + regular.width + 12, 3022, 1e-9);
});

test("mixed rows stay contained, uncropped, and separated as the available Stage resizes", () => {
  const aspects = [1916 / 802, 16 / 9, 9 / 16, 32 / 9, 4 / 3, 16 / 10];
  for (const width of [280, 480, 976, 1502, 3022, 5000]) {
    for (const height of [160, 479, 791, 1121, 2160]) {
      for (const count of [2, 3, 4, 5, 6]) {
        const layout = chooseOptimalGrid({ width, height, tileCount: count, gap: 12, aspectRatios: aspects.slice(0, count) });
        assert.equal(layout.valid, true);
        assert.ok(layout.totalWidth <= width + EPSILON && layout.totalHeight <= height + EPSILON);
        layout.tileLayouts.forEach((tile, index, tiles) => {
          assert.ok(tile.width > 0 && tile.height > 0);
          approximatelyEqual(tile.width / tile.height, aspects[index], 1e-9);
          assert.ok(tile.x + tile.width <= layout.totalWidth + EPSILON);
          assert.ok(tile.y + tile.height <= layout.totalHeight + EPSILON);
          for (const other of tiles.slice(index + 1)) {
            const overlapX = Math.min(tile.x + tile.width, other.x + other.width) - Math.max(tile.x, other.x);
            const overlapY = Math.min(tile.y + tile.height, other.y + other.height) - Math.max(tile.y, other.y);
            assert.ok(overlapX <= EPSILON || overlapY <= EPSILON);
          }
        });
      }
    }
  }
});

test("empty optimal grid has a stable zero-sized result", () => {
  assert.deepEqual(chooseOptimalGrid({ width: 1000, height: 600, tileCount: 0 }), {
    valid: true,
    reason: "empty",
    columns: 0,
    rows: 0,
    tileCount: 0,
    tileWidth: 0,
    tileHeight: 0,
    tileArea: 0,
    score: 0,
    totalWidth: 0,
    totalHeight: 0,
  });
});

test("grid geometry never exceeds its container across an exhaustive matrix", () => {
  const widths = [240, 320, 480, 640, 900, 1280, 1920, 2560, 3440, 3840, 5120];
  const heights = [180, 240, 360, 480, 600, 720, 1080, 1440, 2160];
  const aspects = [4 / 3, 16 / 10, 16 / 9, 21 / 9, 32 / 9, 9 / 16];
  const gaps = [0, 6, 12, 24];

  for (const width of widths) {
    for (const height of heights) {
      for (let tileCount = 1; tileCount <= 16; tileCount += 1) {
        for (const aspectRatio of aspects) {
          for (const gap of gaps) {
            const layout = chooseOptimalGrid({ width, height, tileCount, aspectRatio, gap });
            assert.equal(layout.valid, true, `${width}x${height}, n=${tileCount}`);
            assert.ok(layout.columns >= 1 && layout.columns <= tileCount);
            assert.equal(layout.rows, Math.ceil(tileCount / layout.columns));
            assert.ok(layout.columns * layout.rows >= tileCount);
            assert.ok(layout.tileWidth >= 0 && Number.isFinite(layout.tileWidth));
            assert.ok(layout.tileHeight >= 0 && Number.isFinite(layout.tileHeight));
            assert.ok(layout.score >= 0 && Number.isFinite(layout.score));
            assert.ok(layout.totalWidth <= width + EPSILON);
            assert.ok(layout.totalHeight <= height + EPSILON);
            approximatelyEqual(layout.tileWidth / layout.tileHeight, aspectRatio, 1e-6);
          }
        }
      }
    }
  }
});

test("optimal score cannot decrease when both container axes grow", () => {
  for (let tileCount = 1; tileCount <= 12; tileCount += 1) {
    const small = chooseOptimalGrid({ width: 800, height: 450, tileCount });
    const large = chooseOptimalGrid({ width: 1200, height: 675, tileCount });
    assert.ok(large.score + EPSILON >= small.score, `tileCount=${tileCount}`);
  }
});

test("grid selection is deterministic across repeated evaluations", () => {
  const input = { width: 1111, height: 777, tileCount: 11, gap: 13, aspectRatio: 16 / 10 };
  const first = chooseOptimalGrid(input);
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(chooseOptimalGrid(input), first);
  }
});
