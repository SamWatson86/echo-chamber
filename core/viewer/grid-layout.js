// Production screen-grid layout wiring.
// EchoLayoutPolicy owns the grid-selection algorithm; this module only measures
// the rendered grid, applies the selected multi-share geometry, and keeps it in
// sync as the viewer changes size or visible screen tiles change.

(function () {
  "use strict";

  var _resizeObserver = null;
  var _mutationObserver = null;
  var _rafPending = false;
  var _managedTiles = new Set();

  function setStyleValue(element, property, value) {
    if (!element || element.style[property] === value) return;
    element.style[property] = value;
  }

  function clearManagedTileSizing() {
    _managedTiles.forEach(function (tile) {
      clearTileSizing(tile);
    });
    _managedTiles.clear();
  }

  function clearTileSizing(tile) {
    ["width", "height", "position", "left", "top"].forEach(function (property) {
      setStyleValue(tile, property, "");
    });
  }

  function clearManagedGridSizing(grid) {
    setStyleValue(grid, "gridTemplateColumns", "");
    setStyleValue(grid, "gridTemplateRows", "");
    clearManagedTileSizing();
  }

  function directTiles(grid) {
    return Array.from(grid.querySelectorAll(":scope > .tile"));
  }

  function visibleTiles(grid) {
    return directTiles(grid).filter(function (tile) {
      return tile.offsetParent !== null && getComputedStyle(tile).visibility !== "hidden";
    });
  }

  function clearVisibleTileState(grid) {
    grid.removeAttribute("data-visible-tiles");
    directTiles(grid).forEach(function (tile) {
      tile.removeAttribute("data-grid-visible");
    });
  }

  function publishVisibleTileState(grid, tiles) {
    var count = String(tiles.length);
    if (grid.getAttribute("data-visible-tiles") !== count) {
      grid.setAttribute("data-visible-tiles", count);
    }

    var visibleSet = new Set(tiles);
    directTiles(grid).forEach(function (tile) {
      var isVisible = visibleSet.has(tile);
      if (isVisible && !tile.hasAttribute("data-grid-visible")) {
        tile.setAttribute("data-grid-visible", "");
      } else if (!isVisible && tile.hasAttribute("data-grid-visible")) {
        tile.removeAttribute("data-grid-visible");
      }
    });
  }

  function numericGap(grid, policy) {
    var style = getComputedStyle(grid);
    var measured = Number.parseFloat(style.columnGap || style.gap);
    if (Number.isFinite(measured) && measured >= 0) return measured;
    return Number(policy.DEFAULT_GRID_GAP) || 12;
  }

  function pixelTrack(value) {
    return Math.max(0, Number(value) || 0).toFixed(3).replace(/\.?0+$/, "") + "px";
  }

  function tileAspectRatio(tile, fallback) {
    var video = tile && tile.querySelector("video.screen-video-surface");
    var videoWidth = Number(video && video.videoWidth);
    var videoHeight = Number(video && video.videoHeight);
    if (Number.isFinite(videoWidth) && videoWidth > 0 &&
        Number.isFinite(videoHeight) && videoHeight > 0) {
      return videoWidth / videoHeight;
    }

    var published = Number.parseFloat(
      tile && tile.style.getPropertyValue("--screen-source-aspect-ratio")
    );
    if (Number.isFinite(published) && published > 0) return published;

    var tagged = Number.parseFloat(tile && tile.dataset.aspectRatio);
    if (Number.isFinite(tagged) && tagged > 0) return tagged;
    var fallbackAspect = Number(fallback);
    return Number.isFinite(fallbackAspect) && fallbackAspect > 0 ? fallbackAspect : (16 / 9);
  }

  function updateGridLayout() {
    var grid = document.getElementById("screen-grid");
    if (!grid) return;

    // Phase 2 must remain a live presentation-only variant. Rolling back to
    // legacy removes every inline grid decision made here.
    if (document.documentElement.dataset.uiShell !== "v2") {
      clearVisibleTileState(grid);
      clearManagedGridSizing(grid);
      return;
    }

    // Stage modules visually replace (but never tear down) the screen grid.
    // Preserve the last visible-tile count and geometry while it is hidden so
    // mutations cannot publish a false zero-tile layout before Back to Stage.
    if (grid.closest(".room-main.stage-module-open")) return;

    // Single-share immersion and focused mode have purpose-built CSS layouts.
    // Remove our multi-share inline geometry so those rules retain ownership.
    var tiles = visibleTiles(grid);
    publishVisibleTileState(grid, tiles);
    if (grid.classList.contains("is-focused") || tiles.length <= 1) {
      clearManagedGridSizing(grid);
      return;
    }

    var policy = window.EchoLayoutPolicy;
    if (!policy || typeof policy.chooseOptimalGrid !== "function") {
      clearManagedGridSizing(grid);
      return;
    }

    var width = grid.clientWidth;
    var height = grid.clientHeight;
    if (width < 10 || height < 10) return;

    var layout = policy.chooseOptimalGrid({
      width: width,
      height: height,
      tileCount: tiles.length,
      gap: numericGap(grid, policy),
      aspectRatio: policy.DEFAULT_TILE_ASPECT_RATIO,
      aspectRatios: tiles.map(function (tile) {
        return tileAspectRatio(tile, policy.DEFAULT_TILE_ASPECT_RATIO);
      }),
    });
    if (!layout || !layout.valid || layout.columns < 1 || layout.rows < 1 ||
        layout.tileWidth <= 0 || layout.tileHeight <= 0) {
      clearManagedGridSizing(grid);
      return;
    }

    var sourceAware = layout.positioned && Array.isArray(layout.tileLayouts) &&
      layout.tileLayouts.length === tiles.length;
    setStyleValue(
      grid,
      "gridTemplateColumns",
      sourceAware
        ? "minmax(0, 1fr)"
        : "repeat(" + layout.columns + ", " + pixelTrack(layout.tileWidth) + ")"
    );
    setStyleValue(
      grid,
      "gridTemplateRows",
      sourceAware
        ? "minmax(0, 1fr)"
        : "repeat(" + layout.rows + ", " + pixelTrack(layout.tileHeight) + ")"
    );

    // Uniform sources fill grid cells; mixed sources use centered justified
    // rows without reparenting any live video or changing its subscription.
    var visibleSet = new Set(tiles);
    _managedTiles.forEach(function (tile) {
      if (!visibleSet.has(tile)) {
        clearTileSizing(tile);
        _managedTiles.delete(tile);
      }
    });
    tiles.forEach(function (tile, index) {
      var tileLayout = sourceAware ? layout.tileLayouts[index] : null;
      setStyleValue(tile, "width", tileLayout ? pixelTrack(tileLayout.width) : "100%");
      setStyleValue(tile, "height", tileLayout ? pixelTrack(tileLayout.height) : "100%");
      setStyleValue(tile, "position", tileLayout ? "absolute" : "");
      setStyleValue(tile, "left", tileLayout ? pixelTrack((width - layout.totalWidth) / 2 + tileLayout.x) : "");
      setStyleValue(tile, "top", tileLayout ? pixelTrack((height - layout.totalHeight) / 2 + tileLayout.y) : "");
      _managedTiles.add(tile);
    });
  }

  function scheduleUpdate() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(function () {
      _rafPending = false;
      updateGridLayout();
    });
  }

  function initGridObserver() {
    var grid = document.getElementById("screen-grid");
    if (!grid || _resizeObserver) return;

    if (typeof ResizeObserver === "function") {
      _resizeObserver = new ResizeObserver(scheduleUpdate);
      _resizeObserver.observe(grid);
    } else {
      _resizeObserver = { disconnect: function () {} };
      window.addEventListener("resize", scheduleUpdate, { passive: true });
    }

    if (typeof MutationObserver === "function") {
      _mutationObserver = new MutationObserver(function (records) {
        var childListChanged = false;
        var relevant = records.some(function (record) {
          if (record.type === "childList" && record.target === grid) {
            childListChanged = true;
            return true;
          }
          return record.type === "attributes" &&
            (record.target === grid || record.target.parentElement === grid);
        });
        if (!relevant) return;
        scheduleUpdate();
        if (childListChanged) {
          // A tile can be inserted before its subscription becomes visible.
          setTimeout(scheduleUpdate, 250);
          setTimeout(scheduleUpdate, 1000);
        }
      });
      _mutationObserver.observe(grid, {
        attributes: true,
        attributeFilter: ["class", "data-aspect-ratio", "hidden", "style"],
        childList: true,
        subtree: true,
      });
    }

    window.addEventListener("echo:ui-shell-change", scheduleUpdate);
    scheduleUpdate();
  }

  window._echoRecalcGrid = scheduleUpdate;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initGridObserver, { once: true });
  } else {
    initGridObserver();
  }
})();
