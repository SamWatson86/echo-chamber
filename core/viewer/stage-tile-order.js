// Viewer-local Stage ordering. Never move live media nodes or subscriptions.
(function () {
  "use strict";

  function create(options) {
    var grid = options.grid;
    var order = [];
    var drag = null;
    var status = document.createElement("div");
    status.className = "tile-order-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    document.body.appendChild(status);

    function visible(tile) {
      return tile.parentElement === grid && tile.offsetParent !== null &&
        getComputedStyle(tile).visibility !== "hidden";
    }

    function enabled() {
      return document.documentElement.dataset.uiShell === "v2" &&
        !grid.classList.contains("is-focused") && !document.fullscreenElement &&
        !grid.closest(".room-main.stage-module-open");
    }

    function name(tile) {
      return tile.querySelector("h3")?.textContent || "Stream";
    }

    function cancelDrag() {
      if (!drag) return;
      var previous = drag;
      drag = null;
      previous.tile.classList.remove("is-reordering");
      if (previous.target) previous.target.classList.remove("is-reorder-target");
      grid.classList.remove("is-reordering");
      if (previous.handle.hasPointerCapture(previous.pointerId)) {
        previous.handle.releasePointerCapture(previous.pointerId);
      }
    }

    function swap(first, second) {
      var firstIndex = order.indexOf(first), secondIndex = order.indexOf(second);
      if (!enabled() || first === second || firstIndex < 0 || secondIndex < 0 ||
          !visible(first) || !visible(second)) return;
      order[firstIndex] = second;
      order[secondIndex] = first;
      options.onChange();
      var position = order.filter(visible).indexOf(first) + 1;
      status.textContent = name(first) + " moved to position " + position + ". Your Stage only.";
    }

    function installHandle(tile) {
      var handle = tile.querySelector(":scope > .tile-reorder-handle");
      if (handle) return handle;
      handle = document.createElement("button");
      handle.type = "button";
      handle.className = "tile-reorder-handle";
      handle.textContent = "\u283f";
      handle.title = "Drag onto another tile to swap places. Arrow keys move this tile.";
      handle.setAttribute("aria-label", "Rearrange this stream");
      handle.setAttribute("aria-description", "Drag onto another tile to swap places, or use the arrow keys. This changes only your Stage.");
      handle.addEventListener("click", function (event) { event.stopPropagation(); });
      handle.addEventListener("pointerdown", function (event) {
        event.stopPropagation();
        if (event.button !== 0 || !event.isPrimary || !enabled()) return;
        cancelDrag();
        handle.focus({ preventScroll: true });
        drag = {
          tile: tile, handle: handle, pointerId: event.pointerId,
          x: event.clientX, y: event.clientY, active: false, target: null,
          tiles: order.filter(visible),
        };
        handle.setPointerCapture(event.pointerId);
        event.preventDefault();
      });
      handle.addEventListener("keydown", function (event) {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(event.key)) return;
        event.stopPropagation();
        event.preventDefault();
        if (event.key === "Escape") { cancelDrag(); return; }
        if (!enabled()) return;
        cancelDrag();
        var tiles = order.filter(visible);
        var direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        var target = tiles[tiles.indexOf(tile) + direction];
        if (target) swap(tile, target);
      });
      tile.appendChild(handle);
      return handle;
    }

    function getTiles() {
      var tiles = Array.from(grid.querySelectorAll(":scope > .tile"));
      order = order.filter(function (tile) { return tiles.includes(tile); });
      tiles.forEach(function (tile) { if (!order.includes(tile)) order.push(tile); });
      var current = order.filter(visible);
      var canReorder = enabled() && current.length > 1;
      if (drag && (!canReorder || current.length !== drag.tiles.length ||
          current.some(function (tile, index) { return tile !== drag.tiles[index]; }))) cancelDrag();
      order.forEach(function (tile, index) {
        var handle = installHandle(tile);
        handle.hidden = !canReorder || tile.clientWidth < 96 || tile.clientHeight < 60;
        var value = document.documentElement.dataset.uiShell === "v2" ? String(index) : "";
        if (tile.style.order !== value) tile.style.order = value;
      });
      return order.slice();
    }

    function updateDropTarget(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.tile.classList.add("is-reordering");
      grid.classList.add("is-reordering");
      var hit = document.elementFromPoint(event.clientX, event.clientY);
      var target = hit && hit.closest(".tile");
      if (!target || target === drag.tile || !visible(target)) target = null;
      if (target === drag.target) return;
      if (drag.target) drag.target.classList.remove("is-reorder-target");
      drag.target = target;
      if (target) target.classList.add("is-reorder-target");
    }

    grid.addEventListener("pointermove", updateDropTarget);
    grid.addEventListener("pointerup", function (event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      event.stopPropagation();
      updateDropTarget(event);
      var first = drag.tile, second = drag.active ? drag.target : null;
      cancelDrag();
      if (second) swap(first, second);
    });
    grid.addEventListener("pointercancel", cancelDrag);
    grid.addEventListener("lostpointercapture", cancelDrag);
    window.addEventListener("blur", cancelDrag);
    window.addEventListener("resize", cancelDrag);
    document.addEventListener("fullscreenchange", function () {
      cancelDrag();
      options.onChange();
    });
    return { getTiles: getTiles };
  }

  window.EchoStageTileOrder = { create: create };
})();
