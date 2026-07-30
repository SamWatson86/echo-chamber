(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoJamVisualizer = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_BAR_COUNT = 32;
  var DEFAULT_DPR_CAP = 1.25;
  var DEFAULT_PIXEL_BUDGET = 180000;

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function finiteOr(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeMotionLevel(value) {
    var motion = String(value || "full").trim().toLowerCase();
    if (motion === "still" || motion === "reduce" || motion === "reduced") return "still";
    if (motion === "ambient") return "ambient";
    return "full";
  }

  function frameIntervalForMotion(value) {
    var motion = normalizeMotionLevel(value);
    if (motion === "still") return Number.POSITIVE_INFINITY;
    return 1000 / (motion === "ambient" ? 12 : 24);
  }

  function computeCanvasSize(cssWidth, cssHeight, devicePixelRatio, options) {
    var config = options || {};
    var width = Math.max(0, finiteOr(cssWidth, 0));
    var height = Math.max(0, finiteOr(cssHeight, 0));
    var dprCap = Math.max(1, finiteOr(config.dprCap, DEFAULT_DPR_CAP));
    var pixelBudget = Math.max(1, finiteOr(config.pixelBudget, DEFAULT_PIXEL_BUDGET));
    var scale = clamp(finiteOr(devicePixelRatio, 1), 1, dprCap);
    var backingWidth = Math.max(0, Math.round(width * scale));
    var backingHeight = Math.max(0, Math.round(height * scale));
    var pixels = backingWidth * backingHeight;

    if (pixels > pixelBudget && backingWidth > 0 && backingHeight > 0) {
      var reduction = Math.sqrt(pixelBudget / pixels);
      backingWidth = Math.max(1, Math.floor(backingWidth * reduction));
      backingHeight = Math.max(1, Math.floor(backingHeight * reduction));
      scale = Math.min(backingWidth / width, backingHeight / height);
      pixels = backingWidth * backingHeight;
    }

    return {
      cssWidth: width,
      cssHeight: height,
      width: backingWidth,
      height: backingHeight,
      scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      pixels: pixels,
    };
  }

  function computeLogBandRanges(binCount, barCount) {
    var bins = Math.max(1, Math.floor(finiteOr(binCount, 1)));
    var count = clamp(Math.floor(finiteOr(barCount, DEFAULT_BAR_COUNT)), 1, bins);
    var ranges = [];
    var highestBin = Math.max(1, bins - 1);

    for (var index = 0; index < count; index += 1) {
      var startRatio = index / count;
      var endRatio = (index + 1) / count;
      var start = Math.floor(1 + Math.pow(startRatio, 2.15) * (highestBin - 1));
      var end = Math.floor(1 + Math.pow(endRatio, 2.15) * (highestBin - 1));
      start = clamp(start, 0, bins - 1);
      end = clamp(Math.max(start + 1, end), 1, bins);
      ranges.push({ start: start, end: end });
    }
    return ranges;
  }

  function sampleSpectrumBands(frequencyData, ranges, previousLevels, decay) {
    var data = frequencyData || [];
    var prior = Array.isArray(previousLevels) ? previousLevels : [];
    var release = clamp(finiteOr(decay, 0.84), 0, 0.99);
    return (Array.isArray(ranges) ? ranges : []).map(function (range, index) {
      var start = clamp(Math.floor(finiteOr(range && range.start, 0)), 0, data.length);
      var end = clamp(Math.floor(finiteOr(range && range.end, start + 1)), start + 1, data.length);
      var energy = 0;
      var samples = 0;
      for (var bin = start; bin < end; bin += 1) {
        var normalized = clamp(finiteOr(data[bin], 0) / 255, 0, 1);
        energy += normalized * normalized;
        samples += 1;
      }
      var level = samples ? Math.sqrt(energy / samples) : 0;
      level = clamp(Math.pow(level, 0.82) * 1.08, 0, 1);
      var previous = clamp(finiteOr(prior[index], 0), 0, 1);
      return Math.max(level, previous * release);
    });
  }

  function computeSpectrumBars(levels, cssWidth, cssHeight) {
    var values = Array.isArray(levels) && levels.length ? levels : [0];
    var width = Math.max(0, finiteOr(cssWidth, 0));
    var height = Math.max(0, finiteOr(cssHeight, 0));
    var cellWidth = values.length ? width / values.length : width;
    var barWidth = Math.max(1, cellWidth * 0.58);
    var horizon = height * 0.66;
    var maxHeight = Math.max(0, height * 0.48);

    return values.map(function (value, index) {
      var level = clamp(finiteOr(value, 0), 0, 1);
      var barHeight = Math.max(height > 0 ? 1 : 0, Math.pow(level, 1.08) * maxHeight);
      return {
        x: index * cellWidth + (cellWidth - barWidth) / 2,
        width: barWidth,
        top: horizon - barHeight,
        height: barHeight,
        reflectionTop: horizon + 2,
        reflectionHeight: Math.min(Math.max(0, height - horizon - 3), barHeight * 0.34),
        level: level,
      };
    });
  }

  function resolveVisualizerState(input) {
    var state = input && typeof input === "object" ? input : {};
    if (state.playing !== true) return "idle";
    if (state.streamReady !== true) return state.streamConnecting === true ? "connecting" : "waiting";
    if (state.analyserAvailable !== true || state.analysisFailed === true) return "unavailable";
    if (String(state.contextState || "") !== "running") return "connecting";
    if (normalizeMotionLevel(state.motion) === "still") return "still";
    return "live";
  }

  function createAnalysisGraph(audioContext) {
    var analyser = null;
    var sink = null;
    var destroyed = false;

    function disconnect(node) {
      if (!node || typeof node.disconnect !== "function") return;
      try { node.disconnect(); } catch (_error) {}
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      disconnect(analyser);
      disconnect(sink);
    }

    try {
      if (!audioContext || typeof audioContext.createAnalyser !== "function" ||
          typeof audioContext.createGain !== "function" || !audioContext.destination) {
        return { available: false, analyser: null, sink: null, destroy: destroy };
      }
      analyser = audioContext.createAnalyser();
      sink = audioContext.createGain();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      analyser.minDecibels = -92;
      analyser.maxDecibels = -20;
      sink.gain.value = 0;
      analyser.connect(sink);
      sink.connect(audioContext.destination);
      return { available: true, analyser: analyser, sink: sink, destroy: destroy };
    } catch (_error) {
      destroy();
      analyser = null;
      sink = null;
      return { available: false, analyser: null, sink: null, destroy: function () {} };
    }
  }

  function connectSource(source, playbackGain, analyser) {
    if (!source || typeof source.connect !== "function") {
      throw new Error("Jam audio source is unavailable");
    }
    source.connect(playbackGain);
    if (!analyser) return false;
    try {
      source.connect(analyser);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function createJamVisualizerController(options) {
    var config = options || {};
    var windowRef = config.window || (typeof window !== "undefined" ? window : null);
    var documentRef = config.document || (windowRef && windowRef.document) || null;
    var rootElement = config.root || (documentRef && documentRef.getElementById("jam-audio-visualizer"));
    var canvas = config.canvas || (documentRef && documentRef.getElementById("jam-audio-visualizer-canvas"));
    var statusElement = config.status || (documentRef && documentRef.getElementById("jam-audio-visualizer-status"));
    var requestFrame = config.requestAnimationFrame || (windowRef && windowRef.requestAnimationFrame && windowRef.requestAnimationFrame.bind(windowRef));
    var cancelFrame = config.cancelAnimationFrame || (windowRef && windowRef.cancelAnimationFrame && windowRef.cancelAnimationFrame.bind(windowRef));
    var context = null;
    if (canvas && typeof canvas.getContext === "function") {
      try { context = canvas.getContext("2d"); } catch (_contextError) {}
    }
    var analyser = null;
    var audioContext = null;
    var failedAnalyser = null;
    var playing = false;
    var streamReady = false;
    var streamConnecting = false;
    var frameId = null;
    var lastDrawAt = Number.NEGATIVE_INFINITY;
    var frequencyData = null;
    var timeData = null;
    var bandRanges = null;
    var levels = [];
    var currentState = "idle";
    var currentMotion = "full";
    var destroyed = false;
    var drawCount = 0;
    var resizeObserver = null;
    var motionObserver = null;

    function readMotion() {
      if (typeof config.getMotionLevel === "function") return normalizeMotionLevel(config.getMotionLevel());
      var value = documentRef && documentRef.documentElement && documentRef.documentElement.dataset
        ? documentRef.documentElement.dataset.themeMotionEffective
        : "full";
      return normalizeMotionLevel(value);
    }

    function surfaceVisible() {
      if (!rootElement || !canvas || !context || destroyed) return false;
      if (documentRef && documentRef.hidden) return false;
      if (typeof config.isVisible === "function") return config.isVisible() === true;
      var panel = documentRef && documentRef.getElementById("jam-panel");
      if (panel && (panel.hidden || (panel.classList && panel.classList.contains("hidden")) || panel.inert)) return false;
      var rect = typeof rootElement.getBoundingClientRect === "function"
        ? rootElement.getBoundingClientRect()
        : { width: rootElement.clientWidth, height: rootElement.clientHeight };
      return finiteOr(rect && rect.width, 0) > 0 && finiteOr(rect && rect.height, 0) > 0;
    }

    function cancelScheduledFrame() {
      if (frameId === null) return;
      if (cancelFrame) cancelFrame(frameId);
      frameId = null;
    }

    function ensureCanvasSize() {
      if (!rootElement || !canvas || !context) return null;
      var rect = typeof rootElement.getBoundingClientRect === "function"
        ? rootElement.getBoundingClientRect()
        : { width: rootElement.clientWidth, height: rootElement.clientHeight };
      var size = computeCanvasSize(
        rect && rect.width,
        rect && rect.height,
        windowRef && windowRef.devicePixelRatio,
        { dprCap: config.dprCap, pixelBudget: config.pixelBudget }
      );
      if (!size.width || !size.height) return null;
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      canvas.dataset.backingPixels = String(size.pixels);
      if (typeof context.setTransform === "function") context.setTransform(size.scale, 0, 0, size.scale, 0, 0);
      return size;
    }

    function palette() {
      var styles = windowRef && typeof windowRef.getComputedStyle === "function" && rootElement
        ? windowRef.getComputedStyle(rootElement)
        : null;
      function color(name, fallback) {
        var value = styles && styles.getPropertyValue ? styles.getPropertyValue(name).trim() : "";
        return value || fallback;
      }
      return {
        low: color("--jam-pulse-low", "#4cc38a"),
        middle: color("--jam-pulse-mid", "#57b1ff"),
        high: color("--jam-pulse-high", "#c0a7ff"),
        trace: color("--jam-pulse-trace", "#d9fff0"),
      };
    }

    function restingLevels() {
      var pattern = [0.08, 0.13, 0.2, 0.12, 0.27, 0.18, 0.34, 0.23, 0.17, 0.3, 0.22, 0.15, 0.25, 0.19, 0.12, 0.08];
      return Array.from({ length: DEFAULT_BAR_COUNT }, function (_unused, index) {
        return pattern[index % pattern.length];
      });
    }

    function drawSpectrum(values, waveform, reactive) {
      var size = ensureCanvasSize();
      if (!size || !context) return false;
      var width = size.cssWidth;
      var height = size.cssHeight;
      var colors = palette();
      var bars = computeSpectrumBars(values, width, height);
      context.clearRect(0, 0, width, height);

      context.save();
      context.lineWidth = 1;
      context.strokeStyle = "rgba(190, 230, 218, 0.075)";
      for (var grid = 1; grid < 4; grid += 1) {
        var gridY = Math.round((height / 4) * grid) + 0.5;
        context.beginPath();
        context.moveTo(0, gridY);
        context.lineTo(width, gridY);
        context.stroke();
      }

      var gradient = context.createLinearGradient(0, height, 0, 0);
      gradient.addColorStop(0, colors.low);
      gradient.addColorStop(0.58, colors.middle);
      gradient.addColorStop(1, colors.high);
      context.fillStyle = gradient;
      context.shadowColor = colors.middle;
      context.shadowBlur = reactive ? 7 : 0;

      bars.forEach(function (bar) {
        context.globalAlpha = reactive ? 0.3 + bar.level * 0.7 : 0.22;
        context.fillRect(bar.x, bar.top, bar.width, bar.height);
        context.globalAlpha = reactive ? 0.08 + bar.level * 0.22 : 0.06;
        context.fillRect(bar.x, bar.reflectionTop, bar.width, bar.reflectionHeight);
      });

      if (waveform && waveform.length) {
        context.globalAlpha = reactive ? 0.5 : 0.2;
        context.shadowBlur = reactive ? 5 : 0;
        context.shadowColor = colors.trace;
        context.strokeStyle = colors.trace;
        context.lineWidth = 1.1;
        context.beginPath();
        var center = height * 0.66;
        var amplitude = height * 0.13;
        for (var point = 0; point < waveform.length; point += 1) {
          var x = waveform.length <= 1 ? 0 : (point / (waveform.length - 1)) * width;
          var y = center + ((finiteOr(waveform[point], 128) - 128) / 128) * amplitude;
          if (point === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
      context.restore();
      drawCount += 1;
      return true;
    }

    function drawRestingFrame() {
      if (!surfaceVisible()) return false;
      var values = restingLevels();
      var waveform = null;
      if (currentState === "still" && analyser && failedAnalyser !== analyser) {
        try {
          var bins = Math.max(1, analyser.frequencyBinCount || 256);
          var sampled = new Uint8Array(bins);
          analyser.getByteFrequencyData(sampled);
          values = sampleSpectrumBands(sampled, computeLogBandRanges(bins, DEFAULT_BAR_COUNT), [], 0);
        } catch (_error) {
          failedAnalyser = analyser;
        }
      }
      return drawSpectrum(values, waveform, false);
    }

    function sampleAnalyser() {
      if (!analyser || failedAnalyser === analyser) return false;
      try {
        var bins = Math.max(1, analyser.frequencyBinCount || 256);
        if (!frequencyData || frequencyData.length !== bins) {
          frequencyData = new Uint8Array(bins);
          bandRanges = computeLogBandRanges(bins, DEFAULT_BAR_COUNT);
          levels = [];
        }
        var timeBins = Math.max(2, analyser.fftSize || bins * 2);
        if (!timeData || timeData.length !== timeBins) timeData = new Uint8Array(timeBins);
        analyser.getByteFrequencyData(frequencyData);
        if (typeof analyser.getByteTimeDomainData === "function") analyser.getByteTimeDomainData(timeData);
        levels = sampleSpectrumBands(frequencyData, bandRanges, levels, currentMotion === "ambient" ? 0.78 : 0.84);
        return drawSpectrum(levels, timeData, true);
      } catch (_error) {
        failedAnalyser = analyser;
        return false;
      }
    }

    function scheduleFrame() {
      if (frameId !== null || destroyed || !requestFrame || currentState === "idle" || !surfaceVisible()) return;
      frameId = requestFrame(drawFrame);
    }

    function drawFrame(timestamp) {
      frameId = null;
      if (destroyed || currentState === "idle" || !surfaceVisible()) return;
      if (currentState !== "live") {
        drawRestingFrame();
        return;
      }
      currentMotion = readMotion();
      if (currentMotion === "still") {
        applyState();
        return;
      }
      var interval = frameIntervalForMotion(currentMotion);
      if (!Number.isFinite(lastDrawAt) || timestamp - lastDrawAt >= interval - 0.5) {
        if (!sampleAnalyser()) {
          applyState();
          return;
        }
        lastDrawAt = timestamp;
      }
      scheduleFrame();
    }

    function stateCopy(state) {
      if (state === "live") return currentMotion === "ambient" ? "LIVE \u00b7 LOW MOTION" : "LIVE";
      if (state === "still") return "MOTION OFF";
      if (state === "connecting") return "SYNCING AUDIO";
      if (state === "unavailable") return "STATIC MODE";
      return "JOIN JAM TO ACTIVATE";
    }

    function applyState() {
      if (destroyed) return;
      currentMotion = readMotion();
      currentState = resolveVisualizerState({
        playing: playing,
        streamReady: streamReady,
        streamConnecting: streamConnecting,
        analyserAvailable: !!analyser,
        analysisFailed: failedAnalyser === analyser && !!analyser,
        contextState: audioContext && audioContext.state,
        motion: currentMotion,
      });
      if (rootElement) {
        rootElement.hidden = currentState === "idle";
        rootElement.dataset.state = currentState;
        rootElement.dataset.motion = currentMotion;
        rootElement.dataset.reactive = String(currentState === "live");
      }
      if (statusElement) statusElement.textContent = stateCopy(currentState);
      cancelScheduledFrame();
      lastDrawAt = Number.NEGATIVE_INFINITY;
      if (currentState === "live") scheduleFrame();
      else if (currentState !== "idle") drawRestingFrame();
      else if (canvas && context) context.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }

    function update(next) {
      if (destroyed) return;
      var input = next && typeof next === "object" ? next : {};
      if (Object.prototype.hasOwnProperty.call(input, "playing")) playing = input.playing === true;
      if (Object.prototype.hasOwnProperty.call(input, "streamReady")) streamReady = input.streamReady === true;
      if (Object.prototype.hasOwnProperty.call(input, "streamConnecting")) streamConnecting = input.streamConnecting === true;
      if (Object.prototype.hasOwnProperty.call(input, "analyser") && input.analyser !== analyser) {
        analyser = input.analyser || null;
        failedAnalyser = null;
        frequencyData = null;
        timeData = null;
        bandRanges = null;
        levels = [];
      }
      if (Object.prototype.hasOwnProperty.call(input, "audioContext")) audioContext = input.audioContext || null;
      applyState();
    }

    function pause() {
      cancelScheduledFrame();
      lastDrawAt = Number.NEGATIVE_INFINITY;
    }

    function handleVisibilityChange() {
      if (documentRef && documentRef.hidden) pause();
      else applyState();
    }

    function handleResize() {
      scheduleFrame();
    }

    function installObservers() {
      if (documentRef && typeof documentRef.addEventListener === "function") {
        documentRef.addEventListener("visibilitychange", handleVisibilityChange);
      }
      var ResizeObserverCtor = config.ResizeObserver || (windowRef && windowRef.ResizeObserver);
      if (ResizeObserverCtor && rootElement) {
        resizeObserver = new ResizeObserverCtor(handleResize);
        resizeObserver.observe(rootElement);
      }
      var MutationObserverCtor = config.MutationObserver || (windowRef && windowRef.MutationObserver);
      if (MutationObserverCtor && documentRef && documentRef.documentElement) {
        motionObserver = new MutationObserverCtor(applyState);
        motionObserver.observe(documentRef.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme-motion-effective"],
        });
        var panel = documentRef.getElementById && documentRef.getElementById("jam-panel");
        if (panel) {
          motionObserver.observe(panel, {
            attributes: true,
            attributeFilter: ["hidden", "class", "inert", "aria-hidden"],
          });
        }
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelScheduledFrame();
      if (resizeObserver) resizeObserver.disconnect();
      if (motionObserver) motionObserver.disconnect();
      if (documentRef && typeof documentRef.removeEventListener === "function") {
        documentRef.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      resizeObserver = null;
      motionObserver = null;
      analyser = null;
      audioContext = null;
      frequencyData = null;
      timeData = null;
      bandRanges = null;
      levels = [];
    }

    function snapshot() {
      return {
        state: currentState,
        motion: currentMotion,
        frameScheduled: frameId !== null,
        drawCount: drawCount,
        backingPixels: canvas && canvas.dataset ? Number(canvas.dataset.backingPixels || 0) : 0,
        destroyed: destroyed,
      };
    }

    installObservers();
    applyState();
    return Object.freeze({
      update: update,
      refresh: applyState,
      pause: pause,
      destroy: destroy,
      snapshot: snapshot,
    });
  }

  return Object.freeze({
    DEFAULT_BAR_COUNT: DEFAULT_BAR_COUNT,
    computeCanvasSize: computeCanvasSize,
    computeLogBandRanges: computeLogBandRanges,
    sampleSpectrumBands: sampleSpectrumBands,
    computeSpectrumBars: computeSpectrumBars,
    resolveVisualizerState: resolveVisualizerState,
    frameIntervalForMotion: frameIntervalForMotion,
    createAnalysisGraph: createAnalysisGraph,
    connectSource: connectSource,
    createJamVisualizerController: createJamVisualizerController,
  });
});
