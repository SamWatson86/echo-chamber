(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }

  if (root.EchoThemeEffects && root.EchoThemeEffects.__echoThemeEffectsApi) {
    return;
  }

  var api = factory();
  if (!api.__echoThemeEffectsApi) {
    Object.defineProperty(api, "__echoThemeEffectsApi", { value: true });
  }
  root.EchoThemeEffects = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var TWO_PI = Math.PI * 2;
  var MOTION_BUDGETS = Object.freeze({
    ambient: Object.freeze({
      fpsCap: 12,
      maxDpr: 1,
      maxPixels: 480000,
    }),
    full: Object.freeze({
      fpsCap: 24,
      maxDpr: 1.25,
      maxPixels: 1050000,
    }),
  });

  var EFFECT_PROFILES = Object.freeze({
    matrix: Object.freeze({
      canvasId: "matrix-rain",
      entities: Object.freeze({ ambient: 42, full: 84 }),
    }),
    "event-horizon": Object.freeze({
      canvasId: "event-horizon-field",
      entities: Object.freeze({ ambient: 44, full: 84 }),
    }),
    tempest: Object.freeze({
      canvasId: "tempest-weather",
      entities: Object.freeze({ ambient: 48, full: 88 }),
    }),
    abyss: Object.freeze({
      canvasId: "abyss-current",
      entities: Object.freeze({ ambient: 30, full: 56 }),
    }),
    "neon-wilds": Object.freeze({
      canvasId: "neon-wilds-fireflies",
      entities: Object.freeze({ ambient: 24, full: 44 }),
    }),
    "ultra-instinct": Object.freeze({
      canvasId: "ui-particles",
      entities: Object.freeze({ ambient: 30, full: 60 }),
    }),
  });

  var ANIMATED_THEME_IDS = Object.freeze(Object.keys(EFFECT_PROFILES));

  function finiteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function randomBetween(random, minimum, maximum) {
    return minimum + random() * (maximum - minimum);
  }

  function resolveEffectRequest(state) {
    if (!state || !EFFECT_PROFILES[state.globalTheme]) return null;
    if (state.effectiveMotion !== "ambient" && state.effectiveMotion !== "full") {
      return null;
    }
    var profile = EFFECT_PROFILES[state.globalTheme];
    var motionBudget = MOTION_BUDGETS[state.effectiveMotion];
    return Object.freeze({
      canvasId: profile.canvasId,
      entityCap: profile.entities[state.effectiveMotion],
      fpsCap: motionBudget.fpsCap,
      kind: state.globalTheme,
      maxDpr: motionBudget.maxDpr,
      maxPixels: motionBudget.maxPixels,
      motion: state.effectiveMotion,
    });
  }

  function computeCanvasSize(viewportWidth, viewportHeight, devicePixelRatio, budget) {
    var cssWidth = Math.max(1, Math.floor(finiteNumber(viewportWidth, 1)));
    var cssHeight = Math.max(1, Math.floor(finiteNumber(viewportHeight, 1)));
    var maxDpr = Math.max(0.25, finiteNumber(budget && budget.maxDpr, 1));
    var maxPixels = Math.max(1, Math.floor(finiteNumber(
      budget && budget.maxPixels,
      MOTION_BUDGETS.full.maxPixels
    )));
    var requestedDpr = clamp(finiteNumber(devicePixelRatio, 1), 0.25, maxDpr);
    var requestedPixels = cssWidth * cssHeight * requestedDpr * requestedDpr;
    var scale = requestedDpr;
    if (requestedPixels > maxPixels) {
      scale *= Math.sqrt(maxPixels / requestedPixels);
    }
    var width = Math.max(1, Math.floor(cssWidth * scale));
    var height = Math.max(1, Math.floor(cssHeight * scale));
    while (width * height > maxPixels && height > 1) height -= 1;
    return Object.freeze({
      cssHeight: cssHeight,
      cssWidth: cssWidth,
      height: height,
      pixels: width * height,
      scale: scale,
      width: width,
    });
  }

  function createMatrixRenderer(context, budget, random) {
    var count = budget.entityCap;
    var drops = new Float32Array(count);
    var speeds = new Float32Array(count);
    var width = 1;
    var height = 1;
    var activeCount = count;
    var fontSize = 13;
    var glyphs = "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789ABCDEF";

    function reset(index, initial) {
      drops[index] = initial ? randomBetween(random, -height, height) : randomBetween(random, -height * 0.35, 0);
      speeds[index] = randomBetween(random, 24, 68);
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        fontSize = Math.max(10, Math.round(width / Math.max(36, count)));
        activeCount = Math.min(count, Math.max(1, Math.floor(width / fontSize)));
        for (var index = 0; index < count; index += 1) reset(index, true);
        context.fillStyle = "rgb(0 5 1)";
        context.fillRect(0, 0, width, height);
      },
      draw: function (_now, deltaSeconds) {
        context.fillStyle = budget.motion === "ambient"
          ? "rgb(0 6 2 / 0.2)"
          : "rgb(0 5 1 / 0.13)";
        context.fillRect(0, 0, width, height);
        context.fillStyle = budget.motion === "ambient" ? "#20b956" : "#35f071";
        context.font = fontSize + "px ui-monospace, SFMono-Regular, Consolas, monospace";
        for (var index = 0; index < activeCount; index += 1) {
          var x = index * fontSize;
          var y = drops[index];
          context.globalAlpha = budget.motion === "ambient"
            ? 0.42 + ((index % 4) * 0.08)
            : 0.68 + ((index % 4) * 0.08);
          context.fillText(glyphs.charAt((index * 13 + Math.floor(y / fontSize)) % glyphs.length), x, y);
          drops[index] += speeds[index] * deltaSeconds;
          if (y > height + fontSize) reset(index, false);
        }
        context.globalAlpha = 1;
      },
    };
  }

  function createEventHorizonRenderer(context, budget, random) {
    var count = budget.entityCap;
    var values = new Float32Array(count * 4);
    var width = 1;
    var height = 1;
    var cometProgress = -1;
    var nextCometAt = randomBetween(random, 12000, 20000);

    function reset(index, initial) {
      var offset = index * 4;
      values[offset] = random() * width;
      values[offset + 1] = random() * height;
      values[offset + 2] = randomBetween(random, 0.35, 1);
      values[offset + 3] = initial ? random() * TWO_PI : 0;
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        for (var index = 0; index < count; index += 1) reset(index, true);
      },
      draw: function (now, deltaSeconds) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#dce8ff";
        for (var index = 0; index < count; index += 1) {
          var offset = index * 4;
          var depth = values[offset + 2];
          values[offset + 1] += (2 + depth * 6) * deltaSeconds;
          values[offset] += Math.sin(now * 0.00012 + values[offset + 3]) * depth * 0.08;
          if (values[offset + 1] > height + 2) {
            values[offset + 1] = -2;
            values[offset] = random() * width;
          }
          context.globalAlpha = (budget.motion === "ambient" ? 0.25 : 0.42) + depth * 0.36;
          var radius = depth > 0.78 ? 1.5 : 0.8;
          context.fillRect(values[offset], values[offset + 1], radius, radius);
        }
        context.globalAlpha = 1;

        if (budget.motion === "full" && cometProgress < 0 && now >= nextCometAt) {
          cometProgress = 0;
        }
        if (cometProgress >= 0) {
          cometProgress += deltaSeconds * 0.34;
          var cometX = width * (0.88 - cometProgress * 1.05);
          var cometY = height * (0.12 + cometProgress * 0.48);
          context.strokeStyle = "rgb(136 229 255 / " + Math.max(0, 0.8 - cometProgress) + ")";
          context.lineWidth = 1.4;
          context.beginPath();
          context.moveTo(cometX, cometY);
          context.lineTo(cometX + width * 0.08, cometY - height * 0.035);
          context.stroke();
          if (cometProgress > 1) {
            cometProgress = -1;
            nextCometAt = now + randomBetween(random, 12000, 20000);
          }
        }
      },
    };
  }

  function createTempestRenderer(context, budget, random) {
    var count = budget.entityCap;
    var values = new Float32Array(count * 4);
    var width = 1;
    var height = 1;
    var flash = 0;
    var nextFlashAt = randomBetween(random, 10000, 18000);

    function reset(index, initial) {
      var offset = index * 4;
      values[offset] = random() * width;
      values[offset + 1] = initial ? random() * height : randomBetween(random, -height * 0.25, 0);
      values[offset + 2] = randomBetween(random, 9, 24);
      values[offset + 3] = randomBetween(random, 120, 260);
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        for (var index = 0; index < count; index += 1) reset(index, true);
      },
      draw: function (now, deltaSeconds) {
        context.clearRect(0, 0, width, height);
        context.strokeStyle = budget.motion === "ambient"
          ? "rgb(139 203 225 / 0.16)"
          : "rgb(153 220 244 / 0.32)";
        context.lineWidth = 0.8;
        context.beginPath();
        for (var index = 0; index < count; index += 1) {
          var offset = index * 4;
          var x = values[offset];
          var y = values[offset + 1];
          context.moveTo(x, y);
          context.lineTo(x - values[offset + 2] * 0.32, y + values[offset + 2]);
          values[offset] -= values[offset + 3] * deltaSeconds * 0.16;
          values[offset + 1] += values[offset + 3] * deltaSeconds;
          if (values[offset + 1] > height + 30 || values[offset] < -30) reset(index, false);
        }
        context.stroke();

        if (budget.motion === "full" && flash <= 0 && now >= nextFlashAt) {
          flash = 0.18;
          nextFlashAt = now + randomBetween(random, 10000, 18000);
        }
        if (flash > 0) {
          context.fillStyle = "rgb(222 246 255 / " + flash + ")";
          context.fillRect(0, 0, width, height);
          flash = Math.max(0, flash - deltaSeconds * 1.8);
        }
      },
    };
  }

  function createAbyssRenderer(context, budget, random) {
    var count = budget.entityCap;
    var values = new Float32Array(count * 5);
    var width = 1;
    var height = 1;

    function reset(index, initial) {
      var offset = index * 5;
      values[offset] = random() * width;
      values[offset + 1] = initial ? random() * height : height + randomBetween(random, 5, 35);
      values[offset + 2] = randomBetween(random, 0.8, 3.4);
      values[offset + 3] = randomBetween(random, 5, 18);
      values[offset + 4] = random() * TWO_PI;
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        for (var index = 0; index < count; index += 1) reset(index, true);
      },
      draw: function (now, deltaSeconds) {
        context.clearRect(0, 0, width, height);
        context.strokeStyle = budget.motion === "ambient"
          ? "rgb(114 242 230 / 0.18)"
          : "rgb(134 255 243 / 0.32)";
        context.fillStyle = budget.motion === "ambient"
          ? "rgb(70 209 213 / 0.2)"
          : "rgb(80 238 222 / 0.38)";
        context.lineWidth = 0.8;
        context.beginPath();
        for (var index = 0; index < count; index += 1) {
          var offset = index * 5;
          values[offset + 1] -= values[offset + 3] * deltaSeconds;
          values[offset] += Math.sin(now * 0.00045 + values[offset + 4]) * deltaSeconds * 3;
          if (values[offset + 1] < -8) reset(index, false);
          var radius = values[offset + 2];
          context.moveTo(values[offset] + radius, values[offset + 1]);
          context.arc(values[offset], values[offset + 1], radius, 0, TWO_PI);
        }
        context.stroke();
        context.globalAlpha = budget.motion === "ambient" ? 0.28 : 0.48;
        context.fill();
        context.globalAlpha = 1;
      },
    };
  }

  function createNeonWildsRenderer(context, budget, random) {
    var count = budget.entityCap;
    var values = new Float32Array(count * 6);
    var width = 1;
    var height = 1;

    function reset(index) {
      var offset = index * 6;
      values[offset] = random() * width;
      values[offset + 1] = random() * height;
      values[offset + 2] = randomBetween(random, -3, 3);
      values[offset + 3] = randomBetween(random, -2, 2);
      values[offset + 4] = randomBetween(random, 0.8, 2);
      values[offset + 5] = random() * TWO_PI;
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        for (var index = 0; index < count; index += 1) reset(index);
      },
      draw: function (now, deltaSeconds) {
        context.clearRect(0, 0, width, height);
        context.fillStyle = "#d9ff73";
        for (var index = 0; index < count; index += 1) {
          var offset = index * 6;
          values[offset] += values[offset + 2] * deltaSeconds;
          values[offset + 1] += values[offset + 3] * deltaSeconds;
          if (values[offset] < -4) values[offset] = width + 4;
          if (values[offset] > width + 4) values[offset] = -4;
          if (values[offset + 1] < -4) values[offset + 1] = height + 4;
          if (values[offset + 1] > height + 4) values[offset + 1] = -4;
          context.globalAlpha = (budget.motion === "ambient" ? 0.18 : 0.3) +
            ((Math.sin(now * 0.0018 + values[offset + 5]) + 1) * 0.22);
          context.beginPath();
          context.arc(values[offset], values[offset + 1], values[offset + 4], 0, TWO_PI);
          context.fill();
        }
        context.globalAlpha = 1;
      },
    };
  }

  function createUltraInstinctRenderer(context, budget, random) {
    var count = budget.entityCap;
    var values = new Float32Array(count * 6);
    var width = 1;
    var height = 1;

    function reset(index, initial) {
      var offset = index * 6;
      values[offset] = random() * width;
      values[offset + 1] = initial ? random() * height : height + randomBetween(random, 5, 45);
      values[offset + 2] = randomBetween(random, -5, 5);
      values[offset + 3] = randomBetween(random, -26, -9);
      values[offset + 4] = randomBetween(random, 0.8, 2.6);
      values[offset + 5] = index % 3;
    }

    return {
      resize: function (nextWidth, nextHeight) {
        width = nextWidth;
        height = nextHeight;
        for (var index = 0; index < count; index += 1) reset(index, true);
      },
      draw: function (_now, deltaSeconds) {
        context.clearRect(0, 0, width, height);
        for (var index = 0; index < count; index += 1) {
          var offset = index * 6;
          values[offset] += values[offset + 2] * deltaSeconds;
          values[offset + 1] += values[offset + 3] * deltaSeconds;
          if (values[offset + 1] < -10) reset(index, false);
          var type = values[offset + 5];
          context.fillStyle = type === 0
            ? "rgb(255 255 255 / 0.72)"
            : type === 1
              ? "rgb(177 211 255 / 0.48)"
              : "rgb(111 168 255 / 0.38)";
          context.beginPath();
          context.arc(
            values[offset],
            values[offset + 1],
            values[offset + 4] * (type === 2 ? 1.8 : 1),
            0,
            TWO_PI
          );
          context.fill();
        }
      },
    };
  }

  var RENDERER_FACTORIES = Object.freeze({
    matrix: createMatrixRenderer,
    "event-horizon": createEventHorizonRenderer,
    tempest: createTempestRenderer,
    abyss: createAbyssRenderer,
    "neon-wilds": createNeonWildsRenderer,
    "ultra-instinct": createUltraInstinctRenderer,
  });

  function createThemeEffectController(options) {
    var input = options || {};
    var windowRef = input.window || (typeof window !== "undefined" ? window : null);
    var documentRef = input.document || (windowRef && windowRef.document);
    if (!windowRef || !documentRef) {
      throw new Error("Echo theme effects require a window and document");
    }

    var requestFrame = input.requestAnimationFrame ||
      windowRef.requestAnimationFrame.bind(windowRef);
    var cancelFrame = input.cancelAnimationFrame ||
      windowRef.cancelAnimationFrame.bind(windowRef);
    var setTimer = input.setTimeout ||
      windowRef.setTimeout.bind(windowRef);
    var clearTimer = input.clearTimeout ||
      windowRef.clearTimeout.bind(windowRef);
    var now = input.now || function () {
      return windowRef.performance && typeof windowRef.performance.now === "function"
        ? windowRef.performance.now()
        : Date.now();
    };
    var random = input.random || Math.random;
    var canvas = null;
    var context = null;
    var renderer = null;
    var activeRequest = null;
    var frameId = null;
    var timerId = null;
    var resizePending = false;
    var listenersInstalled = false;
    var destroyed = false;
    var lastDrawAt = Number.NEGATIVE_INFINITY;
    var drawCount = 0;
    var frameCallbackCount = 0;
    var generation = 0;
    var durations = new Float32Array(120);
    var durationCount = 0;
    var durationCursor = 0;

    function ensureCanvas() {
      if (!canvas) {
        canvas = documentRef.createElement("canvas");
        canvas.className = "theme-world-effect";
        canvas.setAttribute("aria-hidden", "true");
        context = canvas.getContext("2d", { alpha: true });
      }
      if (!canvas.isConnected && documentRef.body) {
        documentRef.body.prepend(canvas);
      }
      return canvas;
    }

    function cancelScheduledWork() {
      if (frameId !== null) {
        cancelFrame(frameId);
        frameId = null;
      }
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
      }
    }

    function scheduleFrame() {
      if (
        destroyed ||
        !activeRequest ||
        documentRef.hidden ||
        frameId !== null ||
        timerId !== null
      ) {
        return;
      }
      var interval = 1000 / activeRequest.fpsCap;
      var remaining = Number.isFinite(lastDrawAt)
        ? interval - (now() - lastDrawAt)
        : 0;
      if (remaining > 1) {
        timerId = setTimer(function () {
          timerId = null;
          scheduleFrame();
        }, remaining);
        return;
      }
      frameId = requestFrame(drawFrame);
    }

    function applyCanvasSize() {
      if (!canvas || !activeRequest || !renderer) return;
      var size = computeCanvasSize(
        windowRef.innerWidth,
        windowRef.innerHeight,
        windowRef.devicePixelRatio,
        activeRequest
      );
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      canvas.style.width = size.cssWidth + "px";
      canvas.style.height = size.cssHeight + "px";
      canvas.dataset.effectBackingPixels = String(size.pixels);
      renderer.resize(size.width, size.height);
      resizePending = false;
    }

    function recordDuration(value) {
      durations[durationCursor] = Math.max(0, value);
      durationCursor = (durationCursor + 1) % durations.length;
      durationCount = Math.min(durationCount + 1, durations.length);
    }

    function drawFrame(timestamp) {
      frameId = null;
      frameCallbackCount += 1;
      if (destroyed || !activeRequest || documentRef.hidden || !renderer) return;
      if (resizePending) applyCanvasSize();
      var interval = 1000 / activeRequest.fpsCap;
      if (timestamp - lastDrawAt >= interval - 0.5) {
        var deltaSeconds = Number.isFinite(lastDrawAt)
          ? clamp((timestamp - lastDrawAt) / 1000, 0, 0.1)
          : interval / 1000;
        var startedAt = now();
        renderer.draw(timestamp, deltaSeconds);
        recordDuration(now() - startedAt);
        lastDrawAt = timestamp;
        drawCount += 1;
      }
      scheduleFrame();
    }

    function handleResize() {
      resizePending = true;
      scheduleFrame();
    }

    function handleVisibilityChange() {
      if (documentRef.hidden) {
        cancelScheduledWork();
        return;
      }
      lastDrawAt = Number.NEGATIVE_INFINITY;
      resizePending = true;
      scheduleFrame();
    }

    function installListeners() {
      if (listenersInstalled) return;
      windowRef.addEventListener("resize", handleResize);
      documentRef.addEventListener("visibilitychange", handleVisibilityChange);
      listenersInstalled = true;
    }

    function removeListeners() {
      if (!listenersInstalled) return;
      windowRef.removeEventListener("resize", handleResize);
      documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
      listenersInstalled = false;
    }

    function stop() {
      generation += 1;
      cancelScheduledWork();
      removeListeners();
      renderer = null;
      activeRequest = null;
      resizePending = false;
      lastDrawAt = Number.NEGATIVE_INFINITY;
      if (canvas && canvas.isConnected) canvas.remove();
    }

    function activate(request) {
      if (
        activeRequest &&
        activeRequest.kind === request.kind &&
        activeRequest.motion === request.motion &&
        canvas &&
        canvas.isConnected
      ) {
        return false;
      }

      cancelScheduledWork();
      generation += 1;
      activeRequest = request;
      var activeCanvas = ensureCanvas();
      if (!context) {
        stop();
        return false;
      }
      activeCanvas.id = request.canvasId;
      activeCanvas.dataset.themeEffect = request.kind;
      activeCanvas.dataset.effectMotion = request.motion;
      activeCanvas.dataset.effectFpsCap = String(request.fpsCap);
      activeCanvas.dataset.effectMaxDpr = String(request.maxDpr);
      activeCanvas.dataset.effectMaxPixels = String(request.maxPixels);
      activeCanvas.dataset.effectEntityCap = String(request.entityCap);
      renderer = RENDERER_FACTORIES[request.kind](context, request, random);
      resizePending = true;
      lastDrawAt = Number.NEGATIVE_INFINITY;
      installListeners();
      applyCanvasSize();
      scheduleFrame();
      return true;
    }

    function sync(state) {
      if (destroyed) return false;
      var request = resolveEffectRequest(state);
      if (!request) {
        if (activeRequest || (canvas && canvas.isConnected)) stop();
        return false;
      }
      return activate(request);
    }

    function getMetrics() {
      var samples = Array.prototype.slice.call(durations, 0, durationCount);
      samples.sort(function (left, right) { return left - right; });
      var total = samples.reduce(function (sum, value) { return sum + value; }, 0);
      var p95Index = samples.length
        ? Math.min(samples.length - 1, Math.floor(samples.length * 0.95))
        : 0;
      return Object.freeze({
        active: !!activeRequest,
        averageDrawMs: samples.length ? total / samples.length : 0,
        backingPixels: canvas && canvas.dataset.effectBackingPixels
          ? Number(canvas.dataset.effectBackingPixels)
          : 0,
        canvasConnected: !!(canvas && canvas.isConnected),
        drawCount: drawCount,
        entityCap: activeRequest ? activeRequest.entityCap : 0,
        frameCallbackCount: frameCallbackCount,
        fpsCap: activeRequest ? activeRequest.fpsCap : 0,
        generation: generation,
        kind: activeRequest ? activeRequest.kind : null,
        maxDpr: activeRequest ? activeRequest.maxDpr : 0,
        maxPixels: activeRequest ? activeRequest.maxPixels : 0,
        motion: activeRequest ? activeRequest.motion : null,
        p95DrawMs: samples.length ? samples[p95Index] : 0,
        paused: !!(activeRequest && documentRef.hidden),
      });
    }

    function destroy() {
      if (destroyed) return;
      stop();
      if (canvas) canvas.remove();
      canvas = null;
      context = null;
      destroyed = true;
    }

    return Object.freeze({
      destroy: destroy,
      getMetrics: getMetrics,
      stop: stop,
      sync: sync,
    });
  }

  var exportedApi = {
    ANIMATED_THEME_IDS: ANIMATED_THEME_IDS,
    EFFECT_PROFILES: EFFECT_PROFILES,
    MOTION_BUDGETS: MOTION_BUDGETS,
    computeCanvasSize: computeCanvasSize,
    createThemeEffectController: createThemeEffectController,
    resolveEffectRequest: resolveEffectRequest,
  };
  Object.defineProperty(exportedApi, "__echoThemeEffectsApi", { value: true });
  return Object.freeze(exportedApi);
});
