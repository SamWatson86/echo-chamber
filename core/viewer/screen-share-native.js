/* =========================================================
   SCREEN SHARE — Capture pipeline + WASAPI native audio
   Start/stop screen sharing (native Tauri + browser paths)
   and per-process audio capture via WASAPI.
   ========================================================= */

async function startScreenShareManual() {
  const LK = getLiveKitClient();

  // ── Native client path: custom picker → Tauri IPC ──
  var isNativeClient = !!window.__ECHO_NATIVE__;

  if (isNativeClient) {
    var source = await showCapturePicker();
    if (!source) return;

    // Step 1: get control URL
    var controlUrl = _echoServerUrl;
    if (!controlUrl) { showToast('No server URL configured', 8000); return; }

    // Step 2: get $screen token using existing auth flow
    var screenToken = null;
    var identity = room.localParticipant.identity;
    var roomName = currentRoomName || 'main';
    // Rust SDK must go through the control plane's WebSocket proxy (same host:port as
    // control URL, just wss://). Direct ws://localhost:7880 bypasses the proxy so the
    // viewer never sees the $screen tracks. The domain URL has valid Let's Encrypt certs
    // so the Rust TLS stack accepts it without issues.
    var sfuUrl = controlUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

    try {
      screenToken = await fetchRoomToken(
        controlUrl, adminToken, roomName,
        identity + '$screen',
        (room.localParticipant.name || identity) + "'s screen"
      );
    } catch (err) {
      showToast('Token fetch failed: ' + (err.message || err), 8000);
      return;
    }

    if (!screenToken) { showToast('No token received from server', 8000); return; }

    // Detect OS build number for WGC availability (24H2+ = build 26100+)
    // If the IPC command doesn't exist (older client binary), assume WGC is supported
    // and let it fail naturally in the fallback chain rather than skipping it.
    var osBuild = 99999;
    try {
      osBuild = await tauriInvoke('get_os_build_number');
      debugLog('[os] Windows build: ' + osBuild);
    } catch (e) {
      debugLog('[os] build detection unavailable (older client), assuming WGC supported');
    }
    var wgcSupported = osBuild >= 26100;

    // Step 3: start capture
    try {
      if (source.sourceType === 'game') {
        // Capture fallback chain: WGC (24H2+) → DXGI DD
        // WGC = Windows.Graphics.Capture, 30-60fps (MPO-aware, Win11 24H2+ only)
        // DXGI DD = DWM compositor, 4-35fps (universal fallback)
        var captureStarted = false;

        // 1. Try WGC window capture (MPO-aware, works at game's native FPS — requires Win11 24H2+)
        if (!captureStarted && wgcSupported) {
          try {
            debugLog('[wgc] trying WGC window capture for HWND ' + source.id + ' (build ' + osBuild + ')');
            await tauriInvoke('start_screen_share', {
              sourceId: source.id,
              sfuUrl: sfuUrl,
              token: screenToken,
            });
            window._echoNativeCaptureMode = 'wgc';
            captureStarted = true;
          } catch (wgcErr) {
            debugLog('[wgc] start failed: ' + (wgcErr.message || wgcErr));
          }
        } else if (!captureStarted && !wgcSupported) {
          debugLog('[wgc] skipped — requires Win11 24H2+ (build 26100+), current: ' + osBuild);
        }

        // 2. Fall back to DXGI Desktop Duplication (compositor capture)
        if (!captureStarted) {
          try {
            var ddResult = await tauriInvoke('check_desktop_capture_available');
            if (ddResult && ddResult[0]) {
              debugLog('[desktop-dd] available: ' + ddResult[1]);
              await tauriInvoke('start_desktop_capture', {
                hwnd: source.id,
                fullscreen: source.isMonitor || false,
                sfuUrl: sfuUrl,
                token: screenToken,
              });
              window._echoNativeCaptureMode = 'desktop-dd';
              captureStarted = true;
            } else {
              debugLog('[desktop-dd] not available: ' + (ddResult ? ddResult[1] : 'unknown'));
            }
          } catch (ddErr) {
            debugLog('[desktop-dd] check/start failed: ' + (ddErr.message || ddErr));
          }
        }
      } else {
        // Window/monitor capture
        // Monitors ALWAYS use DXGI DD (WGC can't capture HMONITOR handles)
        // Windows use WGC on 24H2+, error on older
        if (source.sourceType === 'monitor') {
          debugLog('[monitor] using DXGI DD for monitor capture');
          var ddResult = await tauriInvoke('check_desktop_capture_available');
          if (ddResult && ddResult[0]) {
            await tauriInvoke('start_desktop_capture', {
              hwnd: source.id,
              fullscreen: true,
              sfuUrl: sfuUrl,
              token: screenToken,
            });
            window._echoNativeCaptureMode = 'desktop-dd';
          } else {
            throw new Error('Desktop capture not available: ' + (ddResult ? ddResult[1] : 'unknown'));
          }
        } else if (wgcSupported) {
          await tauriInvoke('start_screen_share', {
            sourceId: source.id,
            sfuUrl: sfuUrl,
            token: screenToken,
          });
          window._echoNativeCaptureMode = 'wgc';
        } else {
          throw new Error('Window capture requires Windows 11 24H2+ (current build: ' + osBuild + ')');
        }
      }
      screenEnabled = true;
      window._echoNativeCaptureActive = true;
      _startQualityWarnListener();
      renderPublishButtons();
      var modeLabel = window._echoNativeCaptureMode === 'desktop-dd' ? 'Desktop Duplication' : 'Window Capture';
      showToast('Screen sharing started (' + modeLabel + ')', 4000);

      // Immediately start WASAPI per-process audio + publish pipeline using picker's PID
      if (source.sourceType === 'game' && source.pid && source.pid > 0) {
        debugLog('[audio] auto-starting native audio capture+publish for PID ' + source.pid);
        startNativeAudioCapture(source.pid).then(function() {
          debugLog('[audio] native audio pipeline started for PID ' + source.pid);
          showToast('Game audio streaming', 3000);
        }).catch(function(e) {
          debugLog('[audio] native audio failed: ' + e);
          showToast('Game audio failed: ' + e, 8000);
        });
      } else {
        debugLog('[audio] skipped — type=' + source.sourceType + ' pid=' + (source.pid || 'none'));
      }

      // Listen for Rust-side auto-stop (e.g. game exited, timeouts)
      if (typeof tauriListen === 'function') {
        tauriListen('desktop-capture-stopped', function() {
          debugLog('[desktop-dd] stopped by Rust');
          window._echoNativeCaptureActive = false;
          window._echoNativeCaptureMode = null;
          screenEnabled = false;
          _stopQualityWarnListener();
          renderPublishButtons();
          showToast('Desktop capture ended', 3000);
        }).catch(function() {});
        // NOTE: WASAPI audio auto-start is handled by the immediate startNativeAudioCapture()
        // call above using the picker's PID. No event-based listeners needed — they would
        // double-start and kill the first capture.
      }
    } catch (err) {
      showToast('Capture failed: ' + (err.message || err), 8000);
      // If game capture failed, try WGC fallback (only on 24H2+)
      if (source.sourceType === 'game' && screenToken && wgcSupported) {
        try {
          await tauriInvoke('start_screen_share', {
            sourceId: source.id,
            sfuUrl: sfuUrl,
            token: screenToken,
          });
          window._echoNativeCaptureMode = 'wgc';
          screenEnabled = true;
          window._echoNativeCaptureActive = true;
          renderPublishButtons();
          showToast('Using standard capture (game hook unavailable)', 5000);
        } catch (e2) {
          showToast('Fallback capture also failed: ' + (e2.message || e2), 8000);
        }
      }
    }
    return;
  }

  // ── Browser path (getDisplayMedia) ──
  var gdmConstraints = {
    video: {
      // Capture at native resolution — NVENC handles 4K with zero CPU cost.
      // No width/height cap so 4K monitors capture at 3840x2160.
      frameRate: { ideal: 60 },
      // Don't resize window captures to monitor resolution — preserve native window size.
      // Without this, sharing a small window on an ultrawide captures at 3432x1440 and stretches.
      resizeMode: "none",
    },
    surfaceSwitching: "exclude",
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
  };
  // Always request audio from getDisplayMedia — works as baseline for all clients
  // Native client will additionally try WASAPI per-process capture for better quality
  gdmConstraints.audio = {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
  };
  gdmConstraints.systemAudio = "include";
  const stream = await navigator.mediaDevices.getDisplayMedia(gdmConstraints);

  // Log the actual capture frame rate
  const videoMst = stream.getVideoTracks()[0];
  if (videoMst) {
    const settings = videoMst.getSettings();
    debugLog("Screen capture actual FPS: " + (settings.frameRate || "unknown") +
      ", resolution: " + settings.width + "x" + settings.height);

    // Set content hint for smooth motion (gaming/video)
    videoMst.contentHint = "motion";

    // ── Canvas pipeline: strip screen-capture tag for 60fps H264 encoding ──
    // Chromium caps getDisplayMedia tracks at 30fps for H264 encoding (screen-capture flag).
    // Drawing through a canvas creates a new track without this flag, unlocking 60fps.
    // With NVENC hardware encoding, the canvas drawImage overhead is trivial (GPU-composited).
    // A Web Worker timer drives requestFrame() to avoid setTimeout throttling when occluded.
    let publishMst;
    let canvasW = settings.width || 1920;
    let canvasH = settings.height || 1080;
    // ── Smart downscaling for ultrawide/4K captures ──
    // At 15Mbps/60fps, standard 1080p (2.07M px) gets 0.12 bits/pixel — good.
    // A 3440x1440 ultrawide (4.95M px) gets only 0.05 bpp — causes encoder stalls.
    // Cap at MAX_CANVAS_WIDTH to keep bits/pixel healthy while preserving aspect ratio.
    // 2560px wide covers the largest viewer tile with room to spare.
    var MAX_CANVAS_WIDTH = 1920;
    var MAX_CANVAS_PIXELS = 2_100_000; // ~1920x1094
    // Helper: cap resolution for ultrawide/4K while preserving aspect ratio
    function capCanvasRes(w, h, label) {
      var px = w * h;
      if (w > MAX_CANVAS_WIDTH || px > MAX_CANVAS_PIXELS) {
        var sc = Math.min(MAX_CANVAS_WIDTH / w, Math.sqrt(MAX_CANVAS_PIXELS / px));
        var nw = Math.round(w * sc); var nh = Math.round(h * sc);
        nw = nw - (nw % 2); nh = nh - (nh % 2); // H.264 needs even dims
        debugLog("[canvas-pipe] " + label + " downscale: " + w + "x" + h +
          " (" + (px / 1e6).toFixed(1) + "M px) -> " + nw + "x" + nh +
          " (" + (nw * nh / 1e6).toFixed(1) + "M px), scale=" + sc.toFixed(2));
        return { w: nw, h: nh };
      }
      return null; // no cap needed
    }
    var capped = capCanvasRes(canvasW, canvasH, "initial");
    if (capped) { canvasW = capped.w; canvasH = capped.h; }
    // Use a regular (DOM) canvas — OffscreenCanvas doesn't support captureStream
    var pipeCanvas = document.createElement("canvas");
    pipeCanvas.width = canvasW;
    pipeCanvas.height = canvasH;
    pipeCanvas.style.display = "none";
    document.body.appendChild(pipeCanvas);
    var ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
    var offVideo = document.createElement("video");
    offVideo.srcObject = new MediaStream([videoMst]);
    offVideo.muted = true;
    offVideo.playsInline = true;
    window._canvasOffVideo = offVideo;
    window._canvasPipeEl = pipeCanvas;
    // captureStream(60) = auto-capture at 60fps �� browser drives frame timing
    // This is more reliable than captureStream(0) + requestFrame() in WebView2
    var canvasStream = pipeCanvas.captureStream(60);
    publishMst = canvasStream.getVideoTracks()[0];
    publishMst.contentHint = "motion";
    debugLog("[canvas-pipe] canvasStream created, track: readyState=" + publishMst.readyState + " id=" + publishMst.id);
    // Draw loop: rAF + Worker fallback to keep canvas fed with fresh frames
    var _canvasFrameCount = 0;
    var _canvasDrawActive = false;
    function canvasDraw() {
      if (!offVideo || !_canvasDrawActive) return;
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        // Fallback resize check (primary is the 'resize' event on offVideo)
        if (_canvasFrameCount > 0 && _canvasFrameCount % 30 === 0) {
          var srcW = offVideo.videoWidth;
          var srcH = offVideo.videoHeight;
          if (srcW > 0 && srcH > 0) {
            // Apply ultrawide cap to the source dimensions
            var rc = capCanvasRes(srcW, srcH, "fallback-resize");
            var targetW = rc ? rc.w : srcW;
            var targetH = rc ? rc.h : srcH;
            if (targetW !== canvasW || targetH !== canvasH) {
              debugLog("[canvas-pipe] source resized: " + canvasW + "x" + canvasH + " -> " + targetW + "x" + targetH + " (raw=" + srcW + "x" + srcH + ")");
              canvasW = targetW;
              canvasH = targetH;
              pipeCanvas.width = canvasW;
              pipeCanvas.height = canvasH;
              // Re-acquire context after canvas resize (spec says old context is lost)
              ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
            }
          }
        }
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
        if (_canvasFrameCount === 1) {
          debugLog("[canvas-pipe] FIRST FRAME drawn! offVideo: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
        } else if (_canvasFrameCount === 60) {
          debugLog("[canvas-pipe] 60 frames drawn — pipeline confirmed working");
        } else if (_canvasFrameCount === 300) {
          debugLog("[canvas-pipe] 300 frames drawn (5 seconds of 60fps)");
        }
      }
      window._canvasRafId = requestAnimationFrame(canvasDraw);
    }
    // Worker timer: backup draw loop for when rAF is throttled (page behind shared screen)
    var workerBlob = new Blob([
      "var iv; onmessage = function(e) { if (e.data === 'stop') { clearInterval(iv); return; } iv = setInterval(function() { postMessage('t'); }, e.data); };"
    ], { type: "application/javascript" });
    var worker = new Worker(URL.createObjectURL(workerBlob));
    worker.onmessage = function() {
      if (!offVideo || !_canvasDrawActive) return;
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
      }
    };
    window._canvasFrameWorker = worker;
    // Start drawing once video has data
    function startCanvasDraw() {
      if (_canvasDrawActive) return;
      _canvasDrawActive = true;
      debugLog("[canvas-pipe] starting draw loops — offVideo: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
      // Start rAF loop
      window._canvasRafId = requestAnimationFrame(canvasDraw);
      // Start worker backup at 60fps
      worker.postMessage(Math.floor(1000 / 60));
      // Draw first frame immediately
      if (offVideo.readyState >= 2 && offVideo.videoWidth > 0) {
        ctx2d.drawImage(offVideo, 0, 0, canvasW, canvasH);
        _canvasFrameCount++;
        debugLog("[canvas-pipe] drew initial frame synchronously");
      }
    }
    offVideo.addEventListener("loadeddata", function() {
      debugLog("[canvas-pipe] loadeddata fired: " + offVideo.videoWidth + "x" + offVideo.videoHeight + " readyState=" + offVideo.readyState);
      startCanvasDraw();
    });
    // Resize canvas immediately when captured window changes size (e.g. user resizes Chrome window).
    // Without this, drawImage stretches the smaller source to fill the old larger canvas — causing
    // distortion AND wasting encoder bandwidth (encoding 3840x2088 when source is only 1600x900).
    offVideo.addEventListener("resize", function() {
      var srcW = offVideo.videoWidth;
      var srcH = offVideo.videoHeight;
      if (srcW > 0 && srcH > 0) {
        // Apply ultrawide cap to the new source dimensions
        var rc = capCanvasRes(srcW, srcH, "resize-event");
        var targetW = rc ? rc.w : srcW;
        var targetH = rc ? rc.h : srcH;
        if (targetW !== canvasW || targetH !== canvasH) {
          debugLog("[canvas-pipe] source window resized: " + canvasW + "x" + canvasH + " -> " + targetW + "x" + targetH + " (raw=" + srcW + "x" + srcH + ")");
          canvasW = targetW;
          canvasH = targetH;
          pipeCanvas.width = canvasW;
          pipeCanvas.height = canvasH;
          ctx2d = pipeCanvas.getContext("2d", { alpha: false, desynchronized: true });
        }
      }
    });
    // Safety: if already has data
    if (offVideo.readyState >= 2) {
      debugLog("[canvas-pipe] offVideo already has data (readyState=" + offVideo.readyState + ")");
      startCanvasDraw();
    }
    // Safety timeout
    setTimeout(function() {
      if (!_canvasDrawActive) {
        debugLog("[canvas-pipe] WARNING: no data after 2s — force-starting (readyState=" + offVideo.readyState + " videoWidth=" + offVideo.videoWidth + ")");
        startCanvasDraw();
      }
    }, 2000);
    // Play the video
    offVideo.play().then(function() {
      debugLog("[canvas-pipe] offVideo.play() resolved, readyState=" + offVideo.readyState);
      // Trigger start if loadeddata was missed
      if (!_canvasDrawActive && offVideo.readyState >= 2) startCanvasDraw();
    }).catch(function(e) {
      debugLog("[canvas-pipe] offVideo.play() FAILED: " + e.message);
    });
    debugLog("Screen capture: canvas pipeline active (" + canvasW + "x" + canvasH + " @60fps captureStream(60), NVENC H264)");
    logEvent("screen-share-start", canvasW + "x" + canvasH + " @60fps canvas+NVENC");

    // ── Resource shedding: tear down pre-warmed room connections ──
    // Each pre-warmed room holds a WebRTC peer connection (ICE, DTLS, STUN keepalives).
    // During screen share, every CPU/GPU cycle counts — free these resources.
    if (prewarmedRooms.size > 0) {
      debugLog("Screen share: closing " + prewarmedRooms.size + " pre-warmed connections to free resources");
      prewarmedRooms.forEach(function(entry) { try { entry.room.disconnect(); } catch (e) {} });
      prewarmedRooms.clear();
    }

    // Ghost subscriber REMOVED — was causing DTLS timeouts and encoder death.
    // SDP bandwidth munging (b=AS:25000 + b=TIAS:25000000) handles BWE priming for simulcast.

    // Create LiveKit LocalVideoTrack and publish
    _screenShareVideoTrack = new LK.LocalVideoTrack(publishMst, undefined, false);
    await room.localParticipant.publishTrack(_screenShareVideoTrack, {
      source: LK.Track.Source.ScreenShare,
      ...getScreenSharePublishOptions(canvasW, canvasH),
    });

    // Set initial sender parameters for simulcast screen share.
    // 3 layers: HIGH (4K@60), MEDIUM (1080p@60), LOW (720p@30).
    // Each layer gets explicit bitrate, framerate, and scale factor.
    const sender = _screenShareVideoTrack?.sender;
    debugLog("Screen share sender: " + (sender ? "found" : "NULL") +
      " track.sender=" + (typeof _screenShareVideoTrack?.sender) +
      " mediaStreamTrack=" + (publishMst ? publishMst.readyState + " " + publishMst.getSettings().width + "x" + publishMst.getSettings().height : "null"));
    if (sender) {
      try {
        const params = sender.getParameters();
        debugLog("Screen share encodings BEFORE override: " + JSON.stringify(params.encodings));
        // Note: degradationPreference cannot be set via setParameters (Chromium rejects it).
        // It's already set via addTransceiver init options.
        if (params.encodings) {
          for (const enc of params.encodings) {
            // Note: priority/networkPriority cannot be set via setParameters in Chromium
            // (throws "unimplemented parameter"). They are already set via addTransceiver init.
            if (enc.rid === "f" || (!enc.rid && params.encodings.length === 1)) {
              // HIGH layer: native resolution @60fps, 15 Mbps
              // 12 Mbps wasn't enough for 4K@60 during high-motion gaming — encoder starved.
              enc.maxFramerate = 60;
              enc.maxBitrate = 15_000_000;
              enc.scaleResolutionDownBy = 1;
            } else if (enc.rid === "h") {
              // MEDIUM layer: 1080p @60fps, 5 Mbps
              enc.maxFramerate = 60;
              enc.maxBitrate = 5_000_000;
              enc.scaleResolutionDownBy = 2;
            } else if (enc.rid === "q") {
              // LOW layer: 720p @30fps, 1.5 Mbps
              enc.maxFramerate = 30;
              enc.maxBitrate = 1_500_000;
              enc.scaleResolutionDownBy = 3;
            }
          }
        }
        await sender.setParameters(params);
        const vp = sender.getParameters();
        debugLog("Screen share encodings AFTER override: " + JSON.stringify(vp.encodings));
      if (vp.encodings) {
        for (const enc of vp.encodings) {
          debugLog("Screen share layer " + (enc.rid || "single") + ": fps=" + enc.maxFramerate +
            " bps=" + enc.maxBitrate + " scale=" + enc.scaleResolutionDownBy);
        }
      }
      debugLog("Screen share degPref=" + vp.degradationPreference + " layers=" + (vp.encodings?.length || 1));

      // Diagnostic: dump actual SDP bandwidth after 3s to see if munging worked
      setTimeout(() => {
        try {
          const pc = room.engine?.pcManager?.publisher?.pc;
          if (pc) {
            const ldBas = pc.localDescription?.sdp?.match(/b=(AS|TIAS):\d+/g) || ["NONE"];
            const rdBas = pc.remoteDescription?.sdp?.match(/b=(AS|TIAS):\d+/g) || ["NONE"];
            debugLog("SDP-CHECK local: " + ldBas.join(", ") + " | remote: " + rdBas.join(", "));
            // Also check if x-google params exist
            const xg = pc.localDescription?.sdp?.match(/x-google-start-bitrate=\d+/g) || ["NONE"];
            debugLog("SDP-CHECK x-google: " + xg.join(", "));
          } else {
            debugLog("SDP-CHECK: cannot access PeerConnection (engine.pcManager.publisher.pc)");
          }
        } catch (e) { debugLog("SDP-CHECK error: " + e.message); }
      }, 3000);
      } catch (e) {
        debugLog("Screen share post-publish setParameters FAILED: " + e.message);
      }
    }

    // Monitor capture track health — log if track ends/mutes unexpectedly
    if (publishMst) {
      publishMst.addEventListener("ended", () => {
        debugLog("WARNING: screen capture MediaStreamTrack ENDED (readyState=" + publishMst.readyState + ")");
      });
      publishMst.addEventListener("mute", () => {
        debugLog("WARNING: screen capture MediaStreamTrack MUTED");
      });
      publishMst.addEventListener("unmute", () => {
        debugLog("screen capture MediaStreamTrack unmuted");
      });
      debugLog("Screen capture track: readyState=" + publishMst.readyState + " enabled=" + publishMst.enabled + " muted=" + publishMst.muted +
        " width=" + publishMst.getSettings().width + " height=" + publishMst.getSettings().height + " fps=" + publishMst.getSettings().frameRate);
    }

    // Monitor encoding stats every 2s — simulcast-aware (per-layer tracking)
    if (_screenShareStatsInterval) clearInterval(_screenShareStatsInterval);
    const _layerBytes = new Map(); // rid -> { lastBytes, lastTime }
    _screenShareStatsInterval = setInterval(async () => {
      try {
        const sender = _screenShareVideoTrack?.sender;
        if (!sender) return;

        // Check if capture track and canvas pipeline are still alive
        const captureTrack = sender.track;
        var _pipeHealth = "";
        if (window._canvasOffVideo) {
          var ov = window._canvasOffVideo;
          var srcTrack = ov.srcObject && ov.srcObject.getVideoTracks ? ov.srcObject.getVideoTracks()[0] : null;
          _pipeHealth = " pipe[offVid:rs=" + ov.readyState + "/p=" + ov.paused + "/w=" + ov.videoWidth +
            " src:" + (srcTrack ? "rs=" + srcTrack.readyState + "/en=" + srcTrack.enabled + "/mt=" + srcTrack.muted : "NONE") +
            " canv:" + (captureTrack ? "rs=" + captureTrack.readyState + "/en=" + captureTrack.enabled + "/mt=" + captureTrack.muted : "NONE") + "]";
        }
        if (captureTrack && captureTrack.readyState !== "live") {
          debugLog("Screen share: CAPTURE TRACK DEAD: " + captureTrack.readyState + _pipeHealth);
        }

        // Get BWE + ICE candidate info from sender stats
        let bwe = "?";
        let iceInfo = "";
        let lType = "?", rType = "?";
        const stats = await sender.getStats();
        const candidateMap = new Map();
        stats.forEach((report) => {
          if (report.type === "local-candidate" || report.type === "remote-candidate") {
            candidateMap.set(report.id, report);
          }
        });
        stats.forEach((report) => {
          if (report.type === "candidate-pair" && report.state === "succeeded") {
            bwe = Math.round((report.availableOutgoingBitrate || 0) / 1000);
            _latestOutboundBwe = bwe; // update module-level for LOW restore interval to read
            const local = candidateMap.get(report.localCandidateId);
            const remote = candidateMap.get(report.remoteCandidateId);
            lType = local?.candidateType || "?";
            rType = remote?.candidateType || "?";
            const lAddr = local ? `${local.address}:${local.port}` : "?";
            const rAddr = remote ? `${remote.address}:${remote.port}` : "?";
            iceInfo = `ice=${lType}->${rType} ${lAddr}->${rAddr}`;
          }
        });

        // Collect per-layer stats (simulcast: multiple outbound-rtp with rid)
        const layers = [];
        let highLayerFps = 0;
        let highLayerLimit = "none";
        let totalKbps = 0;
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && report.kind === "video") {
            const rid = report.rid || "single";
            const fps = report.framesPerSecond || 0;
            const w = report.frameWidth || 0;
            const h = report.frameHeight || 0;
            const now = Date.now();
            const prev = _layerBytes.get(rid) || { lastBytes: report.bytesSent, lastTime: now };
            const elapsed = (now - prev.lastTime) / 1000;
            const bytesDelta = report.bytesSent - prev.lastBytes;
            const kbps = elapsed > 0 ? Math.round((bytesDelta * 8) / elapsed / 1000) : 0;
            _layerBytes.set(rid, { lastBytes: report.bytesSent, lastTime: now });
            const codec = report.encoderImplementation || "unknown";
            const limit = report.qualityLimitationReason || "none";
            totalKbps += kbps;
            layers.push({ rid, fps, w, h, kbps, codec, limit });
            // Track HIGH layer stats for adaptive camera + admin reporting
            if (rid === "f" || rid === "single") {
              highLayerFps = fps;
              highLayerLimit = limit;
            }
          }
        });

        // Log per-layer stats
        if (layers.length > 1) {
          // Simulcast: compact per-layer summary
          var layerSummary = layers.map(function(l) {
            var label = l.rid === "f" ? "HIGH" : l.rid === "h" ? "MED" : l.rid === "q" ? "LOW" : l.rid;
            return label + ":" + l.fps + "fps/" + l.w + "x" + l.h + "/" + l.kbps + "kbps";
          }).join(" ");
          var limitStr = highLayerLimit && highLayerLimit !== "none" ? " limit=" + highLayerLimit : "";
          var statsLine = "Screen: " + layerSummary + " total=" + totalKbps + "kbps bwe=" + bwe + "kbps" + limitStr + " " + layers[0].codec + " " + iceInfo;
          if (highLayerFps === 0 && _pipeHealth) statsLine += _pipeHealth;
          debugLog(statsLine);
        } else if (layers.length === 1) {
          // Single layer fallback
          var l = layers[0];
          var statsLine = `Screen: ${l.fps}fps ${l.w}x${l.h} ${l.kbps}kbps bwe=${bwe}kbps codec=${l.codec} limit=${l.limit} ${iceInfo}`;
          if (l.fps === 0 && _pipeHealth) statsLine += _pipeHealth;
          debugLog(statsLine);
        }

        // Use HIGH layer stats for admin dashboard + adaptive camera
        var highLayer = layers.find(function(l) { return l.rid === "f" || l.rid === "single"; }) || layers[0];
        if (highLayer) {
          _latestScreenStats = {
            screen_fps: highLayer.fps, screen_width: highLayer.w, screen_height: highLayer.h,
            screen_bitrate_kbps: totalKbps,
            bwe_kbps: typeof bwe === "number" ? bwe : null,
            quality_limitation: highLayer.limit, encoder: highLayer.codec,
            ice_local_type: lType !== "?" ? lType : null,
            ice_remote_type: rType !== "?" ? rType : null,
            simulcast_layers: layers.length,
          };

          // Report stats to admin dashboard (apiUrl handles native vs browser path)
          if (adminToken) {
            fetch(apiUrl("/admin/api/stats"), {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
              body: JSON.stringify({
                identity: room?.localParticipant?.identity || "",
                name: room?.localParticipant?.name || "",
                room: currentRoomName || "",
                screen_fps: highLayer.fps, screen_width: highLayer.w, screen_height: highLayer.h,
                screen_bitrate_kbps: totalKbps,
                bwe_kbps: typeof bwe === "number" ? bwe : null,
                quality_limitation: highLayer.limit, encoder: highLayer.codec,
                ice_local_type: lType !== "?" ? lType : null,
                ice_remote_type: rType !== "?" ? rType : null,
                simulcast_layers: layers.length,
              }),
            }).catch(() => {});
          }

          // ── Persistent stats log (daily JSONL on server) ──
          // Captures both outbound encoder stats and inbound viewer stats
          // for offline analysis across sessions.
          try {
            var inboundArr = [];
            _inboundDropTracker.forEach(function(dt, key) {
              var lastBytes = _inboundScreenLastBytes.get(key);
              if (!lastBytes) return;
              var parts = key.split("-");
              var source = parts[parts.length - 1]; // "screen" or "camera"
              var fromId = parts.slice(0, parts.length - 1).join("-");
              var avgF = dt.fpsHistory.length > 0
                ? dt.fpsHistory.reduce(function(a, b) { return a + b; }, 0) / dt.fpsHistory.length : 0;
              // Pull latest stats from the last debugLog data (stored in tracker)
              if (dt._lastReport) {
                inboundArr.push({
                  from: fromId, source: source,
                  fps: dt._lastReport.fps, width: dt._lastReport.w, height: dt._lastReport.h,
                  bitrate_kbps: dt._lastReport.kbps, jitter_ms: dt._lastReport.jitter,
                  lost: dt._lastReport.lost, dropped: dt._lastReport.dropped,
                  decoded: dt._lastReport.decoded, nack: dt._lastReport.nack,
                  pli: dt._lastReport.pli, avg_fps: Math.round(avgF),
                  layer: dt.currentQuality, codec: dt._lastReport.codec || null,
                });
              }
            });
            fetch(apiUrl("/api/stats-log"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                identity: room?.localParticipant?.identity || "",
                room: currentRoomName || "",
                out_fps: highLayer.fps, out_width: highLayer.w, out_height: highLayer.h,
                out_bitrate_kbps: totalKbps,
                out_bwe_kbps: typeof bwe === "number" ? bwe : null,
                out_limit: highLayer.limit || null,
                out_encoder: highLayer.codec || null,
                out_layers: layers.length,
                out_ice: iceInfo || null,
                inbound: inboundArr.length > 0 ? inboundArr : null,
              }),
            }).catch(function() {});
          } catch (e) {}

          // Adaptive camera quality: reduce camera when HIGH layer is bandwidth-constrained
          if (highLayerLimit === "bandwidth" || highLayerFps === 0) {
            _bwLimitedCount++;
          } else {
            _bwLimitedCount = Math.max(0, _bwLimitedCount - 1);
          }
          if (_bwLimitedCount >= 3 && camEnabled && !_cameraReducedForScreenShare) {
            _cameraReducedForScreenShare = true;
            debugLog("Adaptive: reducing camera to 360p/15fps to free bandwidth for screen share");
            logEvent("camera-reduced", "360p/15fps bandwidth-limited " + _bwLimitedCount + " ticks");
            reduceCameraForScreenShare();
          }
          if (_bwLimitedCount === 0 && _cameraReducedForScreenShare) {
            _cameraReducedForScreenShare = false;
            debugLog("Adaptive: restoring camera to full quality (bandwidth recovered)");
            logEvent("camera-restored", "bandwidth recovered");
            restoreCameraQuality();
          }

          // ── BWE watchdog: detect stuck-low bitrate and kick encoder ──
          // Chrome BWE starts at ~300kbps and probes up. If SFU congestion control
          // or TURN relay causes slow ramp-up, the HIGH layer can stay at <1Mbps for
          // a long time. After 10s of low total bitrate, re-assert minimum bitrate
          // via setParameters to nudge the BWE prober.
          if (!_bweKickAttempted && typeof bwe === "number" && bwe < 2000 && totalKbps < 1000) {
            _bweLowTicks++;
            if (_bweLowTicks >= 5) { // 5 ticks × 2s = 10s of stuck-low BWE
              _bweKickAttempted = true;
              debugLog("[bwe-watchdog] BWE stuck at " + bwe + "kbps (total send " + totalKbps + "kbps) — re-asserting encoder params");
              logEvent("bwe-watchdog-kick", "bwe=" + bwe + "kbps total=" + totalKbps + "kbps after " + _bweLowTicks + " ticks");
              try {
                var kickParams = sender.getParameters();
                if (kickParams.encodings) {
                  // Respect active bitrate cap from AIMD — don't override to defaults
                  var capHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                  var capMed = _currentAppliedCap ? _currentAppliedCap.med : 5_000_000;
                  var capLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                  for (var kEnc of kickParams.encodings) {
                    if (kEnc.rid === "f" || (!kEnc.rid && kickParams.encodings.length === 1)) {
                      kEnc.maxBitrate = capHigh;
                    } else if (kEnc.rid === "h") {
                      kEnc.maxBitrate = capMed;
                    } else if (kEnc.rid === "q") {
                      kEnc.maxBitrate = capLow;
                    }
                  }
                }
                sender.setParameters(kickParams).then(function() {
                  debugLog("[bwe-watchdog] encoder params re-asserted — waiting for BWE ramp-up");
                }).catch(function(e) {
                  debugLog("[bwe-watchdog] setParameters failed: " + e.message);
                });
              } catch (e) { debugLog("[bwe-watchdog] kick failed: " + e.message); }
            }
          } else {
            _bweLowTicks = Math.max(0, _bweLowTicks - 1);
          }

          // ── HIGH layer rescue: detect BWE crash pausing HIGH layer ──
          // When BWE drops from 25Mbps to ~5Mbps (e.g. jitter spike on TURN relay),
          // WebRTC disables the HIGH simulcast layer (0fps, limit=bandwidth) and only
          // sends MED+LOW. The BWE may recover slowly on its own, but the HIGH layer
          // can stay paused for 30+ seconds. This watchdog detects the pattern and
          // actively re-enables the HIGH layer by temporarily disabling LOW to free
          // bandwidth headroom for BWE to probe back up.
          var highPaused = highLayerFps === 0 && highLayerLimit === "bandwidth" && layers.length > 1;
          if (highPaused) {
            _highPausedTicks = (_highPausedTicks || 0) + 1;
          } else {
            _highPausedTicks = 0;
          }
          // After 3 ticks (6s) of HIGH layer paused, try rescue
          if (_highPausedTicks === 3) {
            debugLog("[bwe-rescue] HIGH layer paused for 6s (bwe=" + bwe + "kbps) — temporarily disabling LOW layer to free bandwidth for HIGH recovery");
            logEvent("bwe-rescue", "HIGH paused 6s, bwe=" + bwe + "kbps total=" + totalKbps + "kbps");
            try {
              var rescueParams = sender.getParameters();
              if (rescueParams.encodings) {
                // Respect active bitrate cap from AIMD
                var rescueCapHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                for (var rEnc of rescueParams.encodings) {
                  if (rEnc.rid === "q") {
                    // Disable LOW layer temporarily to free ~1.5Mbps for HIGH
                    rEnc.active = false;
                  }
                  if (rEnc.rid === "f") {
                    // Re-assert HIGH layer active with fresh bitrate
                    rEnc.active = true;
                    rEnc.maxBitrate = rescueCapHigh;
                  }
                }
              }
              sender.setParameters(rescueParams).then(function() {
                debugLog("[bwe-rescue] LOW layer disabled, HIGH re-asserted — BWE should ramp up");
                // Restore LOW layer once BWE has recovered enough (>= 10Mbps) or after 20s max.
                // Check every 2s instead of a blind 10s timer — prevents re-triggering HIGH pause
                // when BWE hasn't recovered enough to sustain all 3 layers.
                var _lowRestoreChecks = 0;
                var _lowRestoreInterval = setInterval(function() {
                  _lowRestoreChecks++;
                  try {
                    // Read current BWE from the module-level variable (updated every stats tick)
                    var currentBwe = _latestOutboundBwe || 0;
                    // If BWE >= 10Mbps or we've waited 20s, restore LOW
                    if (currentBwe >= 10000 || _lowRestoreChecks >= 10) {
                      clearInterval(_lowRestoreInterval);
                      var restoreParams = sender.getParameters();
                      if (restoreParams.encodings) {
                        var restoreCapLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                        for (var rEnc2 of restoreParams.encodings) {
                          if (rEnc2.rid === "q") {
                            rEnc2.active = true;
                            rEnc2.maxBitrate = restoreCapLow;
                          }
                        }
                      }
                      sender.setParameters(restoreParams).then(function() {
                        debugLog("[bwe-rescue] LOW layer restored (bwe=" + currentBwe + "kbps, checks=" + _lowRestoreChecks + ")");
                      }).catch(function() {});
                    }
                  } catch (e2) { clearInterval(_lowRestoreInterval); }
                }, 2000);
              }).catch(function(e) {
                debugLog("[bwe-rescue] setParameters failed: " + e.message);
              });
            } catch (e) { debugLog("[bwe-rescue] rescue failed: " + e.message); }
          }
          // If HIGH is still paused after 15 ticks (30s), try a harder rescue:
          // re-assert all layer params to force BWE re-evaluation
          if (_highPausedTicks === 15) {
            debugLog("[bwe-rescue] HIGH layer still paused after 30s — hard re-asserting all encoder params");
            logEvent("bwe-rescue-hard", "HIGH paused 30s, bwe=" + bwe + "kbps");
            try {
              var hardParams = sender.getParameters();
              if (hardParams.encodings) {
                // Respect active bitrate cap from AIMD
                var hardCapHigh = _currentAppliedCap ? _currentAppliedCap.high : 15_000_000;
                var hardCapMed = _currentAppliedCap ? _currentAppliedCap.med : 5_000_000;
                var hardCapLow = _currentAppliedCap ? _currentAppliedCap.low : 1_500_000;
                for (var hEnc of hardParams.encodings) {
                  hEnc.active = true;
                  if (hEnc.rid === "f" || (!hEnc.rid && hardParams.encodings.length === 1)) {
                    hEnc.maxBitrate = hardCapHigh;
                    hEnc.maxFramerate = 60;
                  } else if (hEnc.rid === "h") {
                    hEnc.maxBitrate = hardCapMed;
                    hEnc.maxFramerate = 60;
                  } else if (hEnc.rid === "q") {
                    hEnc.maxBitrate = hardCapLow;
                    hEnc.maxFramerate = 30;
                  }
                }
              }
              sender.setParameters(hardParams).then(function() {
                debugLog("[bwe-rescue] hard re-assert complete — all layers active with target bitrates");
              }).catch(function(e) {
                debugLog("[bwe-rescue] hard setParameters failed: " + e.message);
              });
            } catch (e) { debugLog("[bwe-rescue] hard rescue failed: " + e.message); }
            // Reset counter so we can try again in another 30s if still stuck
            _highPausedTicks = 0;
          }
        }
      } catch {}
    }, 2000);

    // Handle browser "Stop sharing" button
    videoMst.addEventListener("ended", () => {
      debugLog("Screen share ended by browser stop button");
      logEvent("screen-share-stop", "browser stop button");
      stopScreenShareManual().catch(() => {});
      screenEnabled = false;
      renderPublishButtons();
    });
  }

  // Publish audio track if available
  const audioTracks = stream.getAudioTracks();
  debugLog("Screen share audio tracks: " + audioTracks.length);
  const audioMst = audioTracks[0];
  if (audioMst) {
    debugLog("Screen share audio track: label=" + audioMst.label + " enabled=" + audioMst.enabled + " muted=" + audioMst.muted);
    _screenShareAudioTrack = new LK.LocalAudioTrack(audioMst, undefined, false);
    await room.localParticipant.publishTrack(_screenShareAudioTrack, {
      source: LK.Track.Source.ScreenShareAudio,
      dtx: false,        // DTX kills non-voice audio (games, music) — must be off
      red: false,         // No redundant encoding needed for continuous audio
      audioBitrate: 128000, // 128kbps for high quality screen audio
    });
    debugLog("Screen share audio published via LiveKit");
  } else {
    debugLog("No screen share audio track available (user may not have checked 'Share audio' or sharing a window)");
  }

  // In native client, auto-detect and capture per-process audio via WASAPI
  if (isNativeClient && hasTauriIPC()) {
    var shareTrackLabel = videoMst ? videoMst.label : "";
    autoDetectNativeAudio(shareTrackLabel).catch(function(err) {
      debugLog("[native-audio] autoDetect error: " + err);
    });
  }
}

async function stopScreenShareManual() {
  // ── Native capture stop path ──
  if (window._echoNativeCaptureActive) {
    try {
      if (window._echoNativeCaptureMode === 'desktop-dd') {
        await tauriInvoke('stop_desktop_capture');
      } else {
        await tauriInvoke('stop_screen_share');
      }
    } catch (e) {
      console.error('[screen-share] native stop error:', e);
    }
    window._echoNativeCaptureActive = false;
    window._echoNativeCaptureMode = null;
    screenEnabled = false;
    _stopQualityWarnListener();
    await stopNativeAudioCapture();
    renderPublishButtons();
    return; // Don't fall through to browser path
  }

  // ── Browser stop path ──
  // Stop native per-process audio capture if active
  await stopNativeAudioCapture();
  // Clean up canvas pipeline (Web Worker frame timer)
  if (window._canvasFrameWorker) {
    try { window._canvasFrameWorker.postMessage("stop"); window._canvasFrameWorker.terminate(); } catch {}
    window._canvasFrameWorker = null;
  }
  if (window._canvasRafId) { cancelAnimationFrame(window._canvasRafId); window._canvasRafId = null; }
  if (window._canvasOffVideo) {
    // Stop the original getDisplayMedia tracks to dismiss the browser sharing indicator
    var origStream = window._canvasOffVideo.srcObject;
    if (origStream) { origStream.getTracks().forEach(function(t) { t.stop(); }); }
    window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null;
  }
  if (window._canvasPipeEl) { window._canvasPipeEl.remove(); window._canvasPipeEl = null; }
  // Ghost subscriber removed (was causing DTLS timeouts)
  if (window._ghostSubscriber) {
    try { window._ghostSubscriber.disconnect(); } catch {}
    window._ghostSubscriber = null;
  }
  if (_screenShareStatsInterval) {
    clearInterval(_screenShareStatsInterval);
    _screenShareStatsInterval = null;
  }
  logEvent("screen-share-stop", "manual stop");
  // Always reset BWE watchdog state when screen share stops
  _bweLowTicks = 0;
  _bweKickAttempted = false;
  _highPausedTicks = 0;
  _latestOutboundBwe = 0;
  // Clean up publisher-side bitrate cap state
  _bitrateCaps.clear();
  _currentAppliedCap = null;
  if (_bitrateCapCleanupTimer) {
    clearInterval(_bitrateCapCleanupTimer);
    _bitrateCapCleanupTimer = null;
  }
  debugLog("[bitrate-ctrl] publisher-side caps cleared (screen share stopped)");
  // Restore camera quality if it was reduced for screen share
  if (_cameraReducedForScreenShare) {
    _cameraReducedForScreenShare = false;
    _bwLimitedCount = 0;
    restoreCameraQuality();
    debugLog("Adaptive: camera quality restored (screen share stopped)");
  }
  try {
    if (_screenShareVideoTrack) {
      await room.localParticipant.unpublishTrack(_screenShareVideoTrack, true);
      _screenShareVideoTrack.mediaStreamTrack?.stop();
      _screenShareVideoTrack = null;
    }
    if (_screenShareAudioTrack) {
      await room.localParticipant.unpublishTrack(_screenShareAudioTrack, true);
      _screenShareAudioTrack.mediaStreamTrack?.stop();
      _screenShareAudioTrack = null;
    }
  } catch (e) {
    debugLog("stopScreenShareManual error: " + e.message);
  }
  // Native audio capture stopped in stopNativeAudioCapture() above
}

// ---------- Native per-process audio capture (Tauri client only) ----------

var _nativeAudioWorkletCode = [
  "class NativeAudioProcessor extends AudioWorkletProcessor {",
  "  constructor() {",
  "    super();",
  "    this.buf = new Float32Array(96000);", // ~1s at 48kHz stereo
  "    this.wr = 0; this.rd = 0; this.len = 96000;",
  "    this.port.onmessage = (e) => {",
  "      var samples = e.data;",
  "      for (var i = 0; i < samples.length; i++) {",
  "        this.buf[this.wr] = samples[i];",
  "        this.wr = (this.wr + 1) % this.len;",
  "      }",
  "    };",
  "  }",
  "  process(inputs, outputs) {",
  "    var out = outputs[0];",
  "    var ch = out.length;",
  "    for (var i = 0; i < out[0].length; i++) {",
  "      for (var c = 0; c < ch; c++) {",
  "        if (this.rd !== this.wr) {",
  "          out[c][i] = this.buf[this.rd];",
  "          this.rd = (this.rd + 1) % this.len;",
  "        } else { out[c][i] = 0; }",
  "      }",
  "    }",
  "    return true;",
  "  }",
  "}",
  "registerProcessor('native-audio-proc', NativeAudioProcessor);",
].join("\n");

async function autoDetectNativeAudio(trackLabel) {
  if (!hasTauriIPC()) {
    debugLog("[native-audio] No Tauri IPC — skipping auto-detect");
    return;
  }
  try {
    var windows = await tauriInvoke("list_capturable_windows");
    debugLog("[native-audio] auto-detect: track label='" + trackLabel + "', " + windows.length + " capturable windows");

    // Try to match the screen share track label against windows
    var matched = null;
    var trackLower = (trackLabel || "").toLowerCase();

    // Strategy 1: Match by HWND from track label "window:HWND:monitor"
    var hwndMatch = trackLabel.match(/^window:(\d+):/);
    if (hwndMatch) {
      var targetHwnd = parseInt(hwndMatch[1], 10);
      debugLog("[native-audio] track label contains HWND: " + targetHwnd);
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].hwnd === targetHwnd) {
          matched = windows[i];
          debugLog("[native-audio] matched by HWND: '" + matched.title + "' pid=" + matched.pid);
          break;
        }
      }
    }

    // Strategy 2: Track label contains window title or vice versa
    if (!matched) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var titleLower = w.title.toLowerCase();
        if (titleLower.indexOf("echo chamber") !== -1) continue;
        if (trackLower.indexOf(titleLower) !== -1 || titleLower.indexOf(trackLower) !== -1) {
          matched = w;
          debugLog("[native-audio] matched by title: '" + w.title + "' pid=" + w.pid);
          break;
        }
      }
    }

    // Strategy 3: Partial word match
    if (!matched && trackLower.length > 3) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        var titleLower = w.title.toLowerCase();
        if (titleLower.indexOf("echo chamber") !== -1) continue;
        var words = trackLower.split(/[\s\-\_\.\|]+/).filter(function(word) { return word.length >= 3; });
        for (var j = 0; j < words.length; j++) {
          if (titleLower.indexOf(words[j]) !== -1) {
            matched = w;
            debugLog("[native-audio] matched by word '" + words[j] + "': '" + w.title + "' pid=" + w.pid);
            break;
          }
        }
        if (matched) break;
      }
    }

    // Strategy 4: Match by exe name from track label
    // Chromium/Edge track labels for window shares often contain the process/exe name
    if (!matched && trackLower.length > 2) {
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (!w.exe_name) continue;
        var exeLower = w.exe_name.toLowerCase().replace(/\.exe$/, "");
        if (exeLower.length < 3) continue;
        if (w.title.toLowerCase().indexOf("echo chamber") !== -1) continue;
        if (trackLower.indexOf(exeLower) !== -1 || exeLower.indexOf(trackLower) !== -1) {
          matched = w;
          debugLog("[native-audio] matched by exe name '" + w.exe_name + "': '" + w.title + "' pid=" + w.pid);
          break;
        }
      }
    }

    if (matched) {
      debugLog("[native-audio] auto-starting capture for '" + matched.title + "' (pid " + matched.pid + ")");
      try {
        await startNativeAudioCapture(matched.pid);
        debugLog("[native-audio] auto-capture started successfully");
        // WASAPI per-process audio is now active — remove the system-wide audio
        // from getDisplayMedia to prevent echo (it captures ALL system audio including voices)
        if (_screenShareAudioTrack) {
          debugLog("[native-audio] replacing system audio with per-process audio");
          await room.localParticipant.unpublishTrack(_screenShareAudioTrack, true);
          _screenShareAudioTrack.mediaStreamTrack?.stop();
          _screenShareAudioTrack = null;
        }
      } catch (err) {
        var errStr = String(err);
        debugLog("[native-audio] auto-capture failed: " + errStr);
        if (errStr.indexOf("build") !== -1 || errStr.indexOf("20348") !== -1) {
          setStatus("Window audio requires Windows 11 — share full screen with system audio instead", true);
        } else {
          setStatus("Window audio capture failed: " + errStr, true);
        }
      }
    } else {
      debugLog("[native-audio] no matching window found for track label '" + trackLabel + "'");
      setStatus("Could not detect window audio — share full screen with system audio for best results", true);
      // Log available windows for debugging
      for (var i = 0; i < Math.min(windows.length, 10); i++) {
        debugLog("[native-audio]   available: '" + windows[i].title + "' (" + windows[i].exe_name + ") hwnd=" + windows[i].hwnd);
      }
    }
  } catch (err) {
    debugLog("[native-audio] auto-detect error: " + err);
  }
}

async function startNativeAudioCapture(pid, opts) {
  opts = opts || {};
  // Stop existing capture first
  await stopNativeAudioCapture();

  if (!hasTauriIPC()) throw new Error("Tauri IPC not available");

  var LK = getLiveKitClient();
  var trackSource = opts.source || LK.Track.Source.ScreenShareAudio;
  var trackName = opts.name || undefined;

  // Create AudioContext — DON'T hardcode sample rate, let it match system default
  // WASAPI will report its actual format and we adapt
  _nativeAudioCtx = new AudioContext();
  // Resume immediately — Chrome suspends new AudioContexts by default
  if (_nativeAudioCtx.state === "suspended") {
    await _nativeAudioCtx.resume();
  }
  debugLog("[native-audio] AudioContext state=" + _nativeAudioCtx.state + " sampleRate=" + _nativeAudioCtx.sampleRate);

  var blob = new Blob([_nativeAudioWorkletCode], { type: "application/javascript" });
  var url = URL.createObjectURL(blob);
  await _nativeAudioCtx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  _nativeAudioWorklet = new AudioWorkletNode(_nativeAudioCtx, "native-audio-proc", {
    outputChannelCount: [2],
  });
  _nativeAudioDest = _nativeAudioCtx.createMediaStreamDestination();
  _nativeAudioWorklet.connect(_nativeAudioDest);

  // Debug: track data flow
  var _dataChunkCount = 0;
  var _dataSampleCount = 0;
  var _firstNonSilentLogged = false;

  // Listen for audio data from Rust via Tauri events
  var captureFormat = null;
  var formatUn = await tauriListen("audio-capture-format", function (ev) {
    captureFormat = ev.payload;
    debugLog("[native-audio] WASAPI format: " + JSON.stringify(captureFormat));
  });

  _nativeAudioUnlisten = await tauriListen("audio-capture-data", function (ev) {
    try {
      // Decode base64 → ArrayBuffer → Float32Array
      var b64 = ev.payload;
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var floats = new Float32Array(bytes.buffer);

      _dataChunkCount++;
      _dataSampleCount += floats.length;

      // Check peak level for this chunk
      var maxVal = 0;
      for (var j = 0; j < Math.min(floats.length, 200); j++) {
        var abs = Math.abs(floats[j]);
        if (abs > maxVal) maxVal = abs;
      }

      // Log first non-silent chunk (confirms real audio is flowing)
      if (!_firstNonSilentLogged && maxVal > 0.001) {
        _firstNonSilentLogged = true;
        debugLog("[native-audio] FIRST NON-SILENT chunk at #" + _dataChunkCount +
          " peak=" + maxVal.toFixed(4) + " samples=" + floats.length +
          " — audio data is flowing!");
      }

      // Log first few chunks and then every 50th for diagnostics
      if (_dataChunkCount <= 3 || _dataChunkCount % 50 === 0) {
        debugLog("[native-audio] chunk #" + _dataChunkCount + " samples=" + floats.length +
          " totalSamples=" + _dataSampleCount + " peak=" + maxVal.toFixed(4));
      }

      // Send to AudioWorklet
      if (_nativeAudioWorklet) {
        _nativeAudioWorklet.port.postMessage(floats);
      }
    } catch (e) {
      debugLog("[native-audio] decode error: " + e);
    }
  });

  // Also listen for errors/stopped
  var errorUn = await tauriListen("audio-capture-error", function (ev) {
    debugLog("[native-audio] capture error: " + ev.payload);
    var st = document.getElementById("native-audio-status");
    if (st) { st.textContent = "Error: " + ev.payload; st.classList.remove("active"); }
  });

  var stoppedUn = await tauriListen("audio-capture-stopped", function () {
    debugLog("[native-audio] capture stopped by Rust");
  });

  // Store unlisteners for cleanup
  var origUnlisten = _nativeAudioUnlisten;
  _nativeAudioUnlisten = function () {
    origUnlisten(); formatUn(); errorUn(); stoppedUn();
  };

  // Start the WASAPI capture on Rust side
  await tauriInvoke("start_audio_capture", { pid: pid });
  debugLog("[native-audio] WASAPI started for PID " + pid);

  // Publish the audio track via LiveKit
  var audioTrack = _nativeAudioDest.stream.getAudioTracks()[0];
  debugLog("[native-audio] MediaStream track: " + (audioTrack ? "exists, enabled=" + audioTrack.enabled + " muted=" + audioTrack.muted + " state=" + audioTrack.readyState : "MISSING"));
  if (audioTrack) {
    _nativeAudioTrack = new LK.LocalAudioTrack(audioTrack, undefined, false);
    var publishOpts = {
      source: trackSource,
      dtx: false,
      red: false,
      audioBitrate: 128000,
    };
    if (trackName) publishOpts.name = trackName;
    await room.localParticipant.publishTrack(_nativeAudioTrack, publishOpts);
    debugLog("[native-audio] published to LiveKit as " + (trackName || "ScreenShareAudio"));
  } else {
    debugLog("[native-audio] ERROR: no audio track from MediaStreamDestination!");
  }

  _nativeAudioActive = true;

  // Show native audio indicator
  var indicator = document.getElementById("native-audio-indicator");
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "native-audio-indicator";
    indicator.style.cssText = "position:fixed;bottom:8px;right:8px;background:rgba(0,200,0,0.8);color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;z-index:99999;pointer-events:none;";
    document.body.appendChild(indicator);
  }
  indicator.textContent = "Native Audio Active";
  indicator.style.display = "";
}

async function stopNativeAudioCapture() {
  if (!_nativeAudioActive) return;
  _nativeAudioActive = false;
  debugLog("[native-audio] stopping capture");

  // Hide native audio indicator
  var indicator = document.getElementById("native-audio-indicator");
  if (indicator) indicator.style.display = "none";

  // Tell Rust to stop
  try {
    if (hasTauriIPC()) {
      await tauriInvoke("stop_audio_capture");
    }
  } catch (e) {
    debugLog("[native-audio] stop_audio_capture error: " + e);
  }

  // Unlisten Tauri events
  if (_nativeAudioUnlisten) {
    try { _nativeAudioUnlisten(); } catch (e) {}
    _nativeAudioUnlisten = null;
  }

  // Unpublish LiveKit track
  if (_nativeAudioTrack && room) {
    try {
      await room.localParticipant.unpublishTrack(_nativeAudioTrack, true);
      _nativeAudioTrack.mediaStreamTrack?.stop();
    } catch (e) {}
    _nativeAudioTrack = null;
  }

  // Close AudioContext
  if (_nativeAudioWorklet) {
    try { _nativeAudioWorklet.disconnect(); } catch (e) {}
    _nativeAudioWorklet = null;
  }
  _nativeAudioDest = null;
  if (_nativeAudioCtx) {
    try { _nativeAudioCtx.close(); } catch (e) {}
    _nativeAudioCtx = null;
  }

  var st = document.getElementById("native-audio-status");
  if (st) { st.textContent = ""; st.classList.remove("active"); }
}

// ---------- End native audio capture ----------
