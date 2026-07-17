(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoLayoutPolicy = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MODES = Object.freeze({
    MINI: "mini",
    COMPACT: "compact",
    LOUNGE: "lounge",
    THEATER: "theater",
  });

  const MODE_ORDER = Object.freeze([
    MODES.MINI,
    MODES.COMPACT,
    MODES.LOUNGE,
    MODES.THEATER,
  ]);

  const DEFAULT_MODE_THRESHOLDS = Object.freeze({
    mini: Object.freeze({ minWidth: 0, minHeight: 0 }),
    compact: Object.freeze({ minWidth: 640, minHeight: 480 }),
    lounge: Object.freeze({ minWidth: 900, minHeight: 600 }),
    theater: Object.freeze({ minWidth: 1280, minHeight: 720 }),
    hysteresis: 48,
  });

  const DEFAULT_TILE_ASPECT_RATIO = 16 / 9;
  const DEFAULT_GRID_GAP = 12;
  const GRID_SCORE_WEIGHTS = Object.freeze({
    area: 0.72,
    balance: 0.2,
    occupancy: 0.08,
  });

  function finiteNonNegative(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function finitePositive(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function normalizeGeometry(width, height) {
    return {
      width: finiteNonNegative(width, 0),
      height: finiteNonNegative(height, 0),
    };
  }

  function isMode(mode) {
    return MODE_ORDER.indexOf(mode) !== -1;
  }

  function normalizeThresholds(overrides) {
    const source = overrides || {};
    const normalized = {
      hysteresis: finiteNonNegative(
        source.hysteresis,
        DEFAULT_MODE_THRESHOLDS.hysteresis
      ),
    };

    let previousWidth = 0;
    let previousHeight = 0;
    for (let index = 0; index < MODE_ORDER.length; index += 1) {
      const mode = MODE_ORDER[index];
      const defaults = DEFAULT_MODE_THRESHOLDS[mode];
      const candidate = source[mode] || {};
      const minWidth = Math.max(
        previousWidth,
        finiteNonNegative(candidate.minWidth, defaults.minWidth)
      );
      const minHeight = Math.max(
        previousHeight,
        finiteNonNegative(candidate.minHeight, defaults.minHeight)
      );
      normalized[mode] = { minWidth, minHeight };
      previousWidth = minWidth;
      previousHeight = minHeight;
    }

    return normalized;
  }

  function classifyLayoutMode(width, height, thresholdOverrides) {
    const geometry = normalizeGeometry(width, height);
    const thresholds = normalizeThresholds(thresholdOverrides);
    let mode = MODES.MINI;

    for (let index = 1; index < MODE_ORDER.length; index += 1) {
      const candidateMode = MODE_ORDER[index];
      const minimums = thresholds[candidateMode];
      if (
        geometry.width >= minimums.minWidth &&
        geometry.height >= minimums.minHeight
      ) {
        mode = candidateMode;
      } else {
        break;
      }
    }

    return mode;
  }

  /**
   * Resolve the responsive mode while retaining the previous mode inside a
   * symmetric dead band. Upgrades require crossing a boundary by the full
   * hysteresis distance; downgrades require crossing it in the other direction.
   * This keeps slow window drags from bouncing between adjacent layouts.
   */
  function resolveLayoutMode(options) {
    const input = options || {};
    const geometry = normalizeGeometry(input.width, input.height);
    const thresholds = normalizeThresholds(input.thresholds);
    const previousMode = input.previousMode;

    if (!isMode(previousMode)) {
      return classifyLayoutMode(geometry.width, geometry.height, thresholds);
    }

    const hysteresis = thresholds.hysteresis;
    let index = MODE_ORDER.indexOf(previousMode);

    // A large resize may cross more than one boundary in a single observation.
    while (index < MODE_ORDER.length - 1) {
      const nextMode = MODE_ORDER[index + 1];
      const nextMinimums = thresholds[nextMode];
      if (
        geometry.width >= nextMinimums.minWidth + hysteresis &&
        geometry.height >= nextMinimums.minHeight + hysteresis
      ) {
        index += 1;
      } else {
        break;
      }
    }

    while (index > 0) {
      const currentMode = MODE_ORDER[index];
      const currentMinimums = thresholds[currentMode];
      if (
        geometry.width < Math.max(0, currentMinimums.minWidth - hysteresis) ||
        geometry.height < Math.max(0, currentMinimums.minHeight - hysteresis)
      ) {
        index -= 1;
      } else {
        break;
      }
    }

    return MODE_ORDER[index];
  }

  function resolveLayoutPolicy(options) {
    const input = options || {};
    const geometry = normalizeGeometry(input.width, input.height);
    const mode = resolveLayoutMode(input);

    return {
      mode,
      width: geometry.width,
      height: geometry.height,
      isShort: geometry.height < 650,
      isVeryShort: geometry.height < 520,
    };
  }

  function fitAspectRatio(maxWidth, maxHeight, aspectRatio) {
    const width = finiteNonNegative(maxWidth, 0);
    const height = finiteNonNegative(maxHeight, 0);
    const aspect = finitePositive(aspectRatio, DEFAULT_TILE_ASPECT_RATIO);

    if (width === 0 || height === 0) {
      return { width: 0, height: 0, area: 0, aspectRatio: aspect };
    }

    let fittedWidth;
    let fittedHeight;
    if (width / height > aspect) {
      fittedHeight = height;
      fittedWidth = height * aspect;
    } else {
      fittedWidth = width;
      fittedHeight = width / aspect;
    }

    return {
      width: fittedWidth,
      height: fittedHeight,
      area: fittedWidth * fittedHeight,
      aspectRatio: aspect,
    };
  }

  function normalizeGridOptions(options) {
    const input = options || {};
    return {
      width: finiteNonNegative(input.width, 0),
      height: finiteNonNegative(input.height, 0),
      tileCount: Math.max(0, Math.floor(finiteNonNegative(input.tileCount, 0))),
      gap: finiteNonNegative(input.gap, DEFAULT_GRID_GAP),
      aspectRatio: finitePositive(input.aspectRatio, DEFAULT_TILE_ASPECT_RATIO),
    };
  }

  function invalidGridCandidate(input, columns, reason) {
    return {
      valid: false,
      reason,
      columns,
      rows: 0,
      tileCount: input.tileCount,
      score: Number.NEGATIVE_INFINITY,
    };
  }

  function scoreGridCandidate(options) {
    const input = normalizeGridOptions(options);
    const columns = Math.floor(finiteNonNegative(options && options.columns, 0));

    if (input.tileCount === 0) {
      return invalidGridCandidate(input, columns, "no-tiles");
    }
    if (columns < 1 || columns > input.tileCount) {
      return invalidGridCandidate(input, columns, "invalid-columns");
    }

    const rows = Math.ceil(input.tileCount / columns);
    const availableWidth = input.width - input.gap * (columns - 1);
    const availableHeight = input.height - input.gap * (rows - 1);
    if (availableWidth <= 0 || availableHeight <= 0) {
      return invalidGridCandidate(input, columns, "insufficient-space");
    }

    const cellWidth = availableWidth / columns;
    const cellHeight = availableHeight / rows;
    const fitted = fitAspectRatio(cellWidth, cellHeight, input.aspectRatio);
    const balance = Math.min(columns, rows) / Math.max(columns, rows);
    const occupancy = input.tileCount / (columns * rows);
    const quality =
      GRID_SCORE_WEIGHTS.area +
      GRID_SCORE_WEIGHTS.balance * balance +
      GRID_SCORE_WEIGHTS.occupancy * occupancy;
    const score = fitted.area * quality;
    const totalWidth = fitted.width * columns + input.gap * (columns - 1);
    const totalHeight = fitted.height * rows + input.gap * (rows - 1);

    return {
      valid: true,
      reason: null,
      columns,
      rows,
      tileCount: input.tileCount,
      gap: input.gap,
      aspectRatio: input.aspectRatio,
      cellWidth,
      cellHeight,
      tileWidth: fitted.width,
      tileHeight: fitted.height,
      tileArea: fitted.area,
      balance,
      occupancy,
      score,
      totalWidth,
      totalHeight,
      unusedWidth: Math.max(0, input.width - totalWidth),
      unusedHeight: Math.max(0, input.height - totalHeight),
    };
  }

  function listGridCandidates(options) {
    const input = normalizeGridOptions(options);
    const candidates = [];
    for (let columns = 1; columns <= input.tileCount; columns += 1) {
      candidates.push(scoreGridCandidate({
        width: input.width,
        height: input.height,
        tileCount: input.tileCount,
        gap: input.gap,
        aspectRatio: input.aspectRatio,
        columns,
      }));
    }
    return candidates;
  }

  function candidateIsBetter(candidate, best) {
    if (!candidate.valid) return false;
    if (!best || !best.valid) return true;

    const epsilon = 1e-9;
    if (candidate.score > best.score + epsilon) return true;
    if (candidate.score < best.score - epsilon) return false;
    if (candidate.tileArea > best.tileArea + epsilon) return true;
    if (candidate.tileArea < best.tileArea - epsilon) return false;
    if (candidate.occupancy > best.occupancy + epsilon) return true;
    if (candidate.occupancy < best.occupancy - epsilon) return false;
    if (candidate.balance > best.balance + epsilon) return true;
    if (candidate.balance < best.balance - epsilon) return false;

    // Stable final tie-breaker: fewer columns makes repeated calls deterministic.
    return candidate.columns < best.columns;
  }

  function chooseOptimalGrid(options) {
    const input = normalizeGridOptions(options);
    if (input.tileCount === 0) {
      return {
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
      };
    }

    const candidates = listGridCandidates(input);
    let best = null;
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidateIsBetter(candidates[index], best)) {
        best = candidates[index];
      }
    }

    return best || invalidGridCandidate(input, 0, "insufficient-space");
  }

  return {
    DEFAULT_GRID_GAP,
    DEFAULT_MODE_THRESHOLDS,
    DEFAULT_TILE_ASPECT_RATIO,
    GRID_SCORE_WEIGHTS,
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
  };
});
