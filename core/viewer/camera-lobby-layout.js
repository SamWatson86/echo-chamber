// Responsive Camera Lobby layout wiring.
//
// EchoLayoutPolicy owns the grid choice. This module only measures the live
// lobby and applies presentation geometry to its existing tiles; it never
// replaces, reparents, or reattaches camera media elements.
(function () {
  "use strict";

  var _resizeObserver = null;
  var _gridObserver = null;
  var _panelObserver = null;
  var _rafPending = false;
  var _managedTiles = new Set();

  function setStyleValue(element, property, value) {
    if (!element || element.style[property] === value) return;
    element.style[property] = value;
  }

  function directVisibleTiles(grid) {
    return Array.from(grid.querySelectorAll(":scope > .camera-lobby-tile")).filter(function (tile) {
      var style = getComputedStyle(tile);
      return tile.offsetParent !== null && style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function numericStyle(style, property) {
    var value = Number.parseFloat(style[property]);
    return Number.isFinite(value) ? value : 0;
  }

  function contentGeometry(grid) {
    var style = getComputedStyle(grid);
    return {
      width: Math.max(
        0,
        grid.clientWidth - numericStyle(style, "paddingLeft") - numericStyle(style, "paddingRight")
      ),
      height: Math.max(
        0,
        grid.clientHeight - numericStyle(style, "paddingTop") - numericStyle(style, "paddingBottom")
      ),
      gap: Math.max(
        numericStyle(style, "columnGap"),
        numericStyle(style, "rowGap")
      ),
    };
  }

  function pixelTrack(value) {
    return Math.max(0, Number(value) || 0).toFixed(3).replace(/\.?0+$/, "") + "px";
  }

  function clearManagedTileSizing() {
    _managedTiles.forEach(function (tile) {
      setStyleValue(tile, "width", "");
      setStyleValue(tile, "height", "");
    });
    _managedTiles.clear();
  }

  function clearManagedGridSizing(grid) {
    if (!grid) return;
    setStyleValue(grid, "gridTemplateColumns", "");
    setStyleValue(grid, "gridTemplateRows", "");
    grid.removeAttribute("data-layout-columns");
    grid.removeAttribute("data-layout-rows");
    grid.removeAttribute("data-layout-count");
    clearManagedTileSizing();
  }

  function updateCameraLobbyLayout() {
    var panel = document.getElementById("camera-lobby");
    var grid = document.getElementById("camera-lobby-grid");
    if (!panel || !grid) return;

    if (
      document.documentElement.dataset.uiShell !== "v2" ||
      panel.classList.contains("hidden")
    ) {
      clearManagedGridSizing(grid);
      return;
    }

    var tiles = directVisibleTiles(grid);
    var geometry = contentGeometry(grid);
    var policy = window.EchoLayoutPolicy;
    if (
      tiles.length === 0 ||
      geometry.width < 10 ||
      geometry.height < 10 ||
      !policy ||
      typeof policy.chooseOptimalGrid !== "function"
    ) {
      clearManagedGridSizing(grid);
      return;
    }

    var layout = policy.chooseOptimalGrid({
      width: geometry.width,
      height: geometry.height,
      tileCount: tiles.length,
      gap: geometry.gap,
      aspectRatio: policy.DEFAULT_TILE_ASPECT_RATIO,
    });
    if (
      !layout ||
      !layout.valid ||
      layout.columns < 1 ||
      layout.rows < 1 ||
      layout.tileWidth <= 0 ||
      layout.tileHeight <= 0
    ) {
      clearManagedGridSizing(grid);
      return;
    }

    setStyleValue(
      grid,
      "gridTemplateColumns",
      "repeat(" + layout.columns + ", " + pixelTrack(layout.tileWidth) + ")"
    );
    setStyleValue(
      grid,
      "gridTemplateRows",
      "repeat(" + layout.rows + ", " + pixelTrack(layout.tileHeight) + ")"
    );
    grid.dataset.layoutColumns = String(layout.columns);
    grid.dataset.layoutRows = String(layout.rows);
    grid.dataset.layoutCount = String(tiles.length);

    var visibleSet = new Set(tiles);
    _managedTiles.forEach(function (tile) {
      if (!visibleSet.has(tile)) {
        setStyleValue(tile, "width", "");
        setStyleValue(tile, "height", "");
        _managedTiles.delete(tile);
      }
    });
    tiles.forEach(function (tile) {
      setStyleValue(tile, "width", "100%");
      setStyleValue(tile, "height", "100%");
      _managedTiles.add(tile);
    });
  }

  function scheduleCameraLobbyLayout() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(function () {
      _rafPending = false;
      updateCameraLobbyLayout();
    });
  }

  function initCameraLobbyLayout() {
    var panel = document.getElementById("camera-lobby");
    var grid = document.getElementById("camera-lobby-grid");
    if (!panel || !grid || _resizeObserver) return;

    if (typeof ResizeObserver === "function") {
      _resizeObserver = new ResizeObserver(scheduleCameraLobbyLayout);
      _resizeObserver.observe(panel);
      _resizeObserver.observe(grid);
    } else {
      _resizeObserver = { disconnect: function () {} };
      window.addEventListener("resize", scheduleCameraLobbyLayout, { passive: true });
    }

    if (typeof MutationObserver === "function") {
      _gridObserver = new MutationObserver(scheduleCameraLobbyLayout);
      _gridObserver.observe(grid, { childList: true });

      _panelObserver = new MutationObserver(scheduleCameraLobbyLayout);
      _panelObserver.observe(panel, { attributes: true, attributeFilter: ["class"] });
    }

    window.addEventListener("echo:ui-shell-change", scheduleCameraLobbyLayout);
    scheduleCameraLobbyLayout();
  }

  window._echoRecalcCameraLobby = scheduleCameraLobbyLayout;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initCameraLobbyLayout, { once: true });
  } else {
    initCameraLobbyLayout();
  }
})();
