// ─── Optimal Screen Grid Layout Engine ───
// Calculates the best column/row arrangement to maximize tile size
// while filling available space. Uses both width AND height to decide.

(function () {
  "use strict";

  var ASPECT = 16 / 9;
  var GAP = 12; // matches CSS gap
  var _resizeObserver = null;
  var _rafPending = false;

  /**
   * Given a container and N tiles, find the column count (1..N)
   * that maximizes the tile area, biased toward balanced (square-ish)
   * grids. The bias prevents the visually-bad case where 3 tiles end up
   * in a single horizontal row just because the container is wide and
   * short — with the bias, 3 tiles default to 2x2 (2 top + 1 bottom)
   * like every modern video conferencing app does.
   */
  function computeOptimalColumns(containerW, containerH, tileCount) {
    if (tileCount <= 0) return 1;
    if (tileCount === 1) return 1;

    var bestCols = 1;
    var bestScore = 0;

    for (var cols = 1; cols <= tileCount; cols++) {
      var rows = Math.ceil(tileCount / cols);

      // Available space after gaps
      var availW = containerW - GAP * (cols - 1);
      var availH = containerH - GAP * (rows - 1);
      if (availW <= 0 || availH <= 0) continue;

      // Max tile dimensions constrained by both axes
      var tileW = availW / cols;
      var tileH = availH / rows;

      // Constrain to 16:9 aspect ratio
      var fitW, fitH;
      if (tileW / tileH > ASPECT) {
        // Container cell is wider than 16:9 — height is the constraint
        fitH = tileH;
        fitW = fitH * ASPECT;
      } else {
        // Container cell is taller than 16:9 — width is the constraint
        fitW = tileW;
        fitH = fitW / ASPECT;
      }

      var area = fitW * fitH;
      // Balance bias: prefer near-square grids when areas are comparable.
      // For 2x2 (3 tiles): aspectBalance = 1.0 → multiplier = 1.0
      // For 3x1 (3 tiles): aspectBalance = 0.333 → multiplier = 0.8
      // Area still dominates but balanced grids win ties and near-ties.
      var aspectBalance = Math.min(cols, rows) / Math.max(cols, rows);
      var score = area * (0.7 + 0.3 * aspectBalance);

      if (score > bestScore) {
        bestScore = score;
        bestCols = cols;
      }
    }

    return bestCols;
  }

  function updateGridLayout() {
    var grid = document.getElementById("screen-grid");
    if (!grid) return;

    // Don't override focused mode — it has its own layout
    if (grid.classList.contains("is-focused")) return;

    // Count visible tiles
    var tiles = grid.querySelectorAll(".tile");
    var visibleCount = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (tiles[i].offsetParent !== null) visibleCount++;
    }

    if (visibleCount === 0) {
      grid.style.gridTemplateColumns = "";
      grid.style.gridTemplateRows = "";
      return;
    }

    var containerW = grid.clientWidth;
    var containerH = grid.clientHeight;

    // If container isn't measured yet, bail and retry
    if (containerW < 10 || containerH < 10) return;

    var cols = computeOptimalColumns(containerW, containerH, visibleCount);
    var rows = Math.ceil(visibleCount / cols);

    grid.style.gridTemplateColumns = "repeat(" + cols + ", 1fr)";
    grid.style.gridTemplateRows = "repeat(" + rows + ", 1fr)";
  }

  function scheduleUpdate() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(function () {
      _rafPending = false;
      updateGridLayout();
    });
  }

  // Watch the grid container for size changes
  function initGridObserver() {
    var grid = document.getElementById("screen-grid");
    if (!grid || _resizeObserver) return;

    _resizeObserver = new ResizeObserver(function () {
      scheduleUpdate();
    });
    _resizeObserver.observe(grid);

    // Also watch for child additions/removals (tiles being added/removed).
    // Some tiles are added invisibly (e.g. before subscription completes)
    // and become visible later without firing a mutation. We schedule
    // delayed recalcs as well to catch the deferred-visibility case.
    var mutObs = new MutationObserver(function () {
      scheduleUpdate();
      setTimeout(scheduleUpdate, 250);
      setTimeout(scheduleUpdate, 1000);
    });
    mutObs.observe(grid, { childList: true, subtree: false });

    // Initial layout
    scheduleUpdate();
  }

  // Expose for external triggers (focus/unfocus, window resize, etc.)
  window._echoRecalcGrid = scheduleUpdate;

  // Init on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGridObserver);
  } else {
    initGridObserver();
  }
})();
