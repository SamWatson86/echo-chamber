/* =========================================================
   RNNOISE — WebAssembly noise cancellation with voice gate
   ========================================================= */

// Mobile device detection — variable declared in state.js, assigned here
var _isMobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// ── State vars that depend on echoGet (settings.js) ──
let noiseCancelEnabled = echoGet("echo-noise-cancel") !== "false"; // Default ON (#59)
let ncSuppressionLevel = parseInt(echoGet("echo-nc-level") || "1", 10); // 0=light, 1=medium, 2=strong

// Detects SIMD support for optimal WASM variant
async function detectSimdSupport() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
    ]));
  } catch (e) { return false; }
}

// Noise cancellation applies ONLY to the microphone track — never screen share audio
// Skip on mobile — too CPU-heavy and .wasm fetch triggers Samsung download interceptor
async function enableNoiseCancellation() {
  if (_isMobileDevice) { debugLog("[noise-cancel] Skipped on mobile device"); return; }
  if (!room || !micEnabled) return;
  var LK = getLiveKitClient();
  if (!LK) { debugLog("[noise-cancel] LiveKit SDK not loaded"); return; }
  var micPub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
  if (!micPub || !micPub.track) return;
  if (micPub.source === LK.Track.Source.ScreenShareAudio) return;

  try {
    var mediaTrack = micPub.track.mediaStreamTrack;
    if (!mediaTrack) return;

    // Create audio context at mic's sample rate
    var sampleRate = mediaTrack.getSettings().sampleRate || 48000;
    rnnoiseCtx = new AudioContext({ sampleRate: sampleRate });

    // Register the RNNoise worklet
    await rnnoiseCtx.audioWorklet.addModule("rnnoise-processor.js");

    // Fetch the WASM binary (SIMD if supported)
    var simd = await detectSimdSupport();
    var wasmUrl = simd ? "rnnoise_simd.wasm" : "rnnoise.wasm";
    var wasmResp = await fetch(wasmUrl, { headers: { 'Accept': 'application/wasm' }, cache: 'force-cache' });
    var wasmBinary = await wasmResp.arrayBuffer();

    // Create source from mic track
    var source = rnnoiseCtx.createMediaStreamSource(new MediaStream([mediaTrack]));

    // Create the RNNoise worklet node
    rnnoiseNode = new AudioWorkletNode(rnnoiseCtx, "@sapphi-red/web-noise-suppressor/rnnoise", {
      processorOptions: { wasmBinary: wasmBinary, maxChannels: 1 }
    });

    // Wire: source → rnnoise → gate (gain) → destination
    var dest = rnnoiseCtx.createMediaStreamDestination();

    // Create noise gate: analyser monitors level, gain node mutes when below threshold
    ncGateNode = rnnoiseCtx.createGain();
    ncGateNode.gain.value = 1.0;
    ncAnalyser = rnnoiseCtx.createAnalyser();
    ncAnalyser.fftSize = 256;

    source.connect(rnnoiseNode);
    rnnoiseNode.connect(ncAnalyser);
    rnnoiseNode.connect(ncGateNode);
    ncGateNode.connect(dest);

    // Start gate monitoring loop (checks audio level every 20ms)
    startNoiseGate();

    // Save original track and swap in the processed one
    rnnoiseOriginalTrack = mediaTrack;
    var processedTrack = dest.stream.getAudioTracks()[0];

    // Replace the track in LiveKit's RTCRtpSender
    var sender = micPub.track.sender;
    if (sender) {
      await sender.replaceTrack(processedTrack);
    }

    debugLog("[noise-cancel] RNNoise enabled" + (simd ? " (SIMD)" : " (no SIMD)") + ", gate level=" + ncSuppressionLevel);
  } catch (err) {
    debugLog("[noise-cancel] Failed to enable: " + (err.message || err));
    disableNoiseCancellation();
    throw err;
  }
}

// Noise gate thresholds: [light, medium, strong]
// Light = no gate (RNNoise only), Medium = gentle gate, Strong = aggressive gate
var NC_GATE_THRESHOLDS = [0, 0.006, 0.012];

function startNoiseGate() {
  stopNoiseGate();
  if (ncSuppressionLevel === 0 || !ncAnalyser || !ncGateNode) return; // light = no gate
  var dataArray = new Float32Array(ncAnalyser.fftSize);
  ncGateInterval = setInterval(function() {
    if (!ncAnalyser || !ncGateNode) return;
    ncAnalyser.getFloatTimeDomainData(dataArray);
    // Compute RMS level
    var sum = 0;
    for (var i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
    var rms = Math.sqrt(sum / dataArray.length);
    var threshold = NC_GATE_THRESHOLDS[ncSuppressionLevel] || 0.008;
    // Smooth gate: ramp gain up/down to avoid clicks
    var target = rms > threshold ? 1.0 : 0.0;
    ncGateNode.gain.setTargetAtTime(target, ncGateNode.context.currentTime, target > 0.5 ? 0.01 : 0.05);
  }, 50); // 20Hz — adequate for voice activity detection, was 50Hz which burned CPU
}

function stopNoiseGate() {
  if (ncGateInterval) { clearInterval(ncGateInterval); ncGateInterval = null; }
  if (ncGateNode) ncGateNode.gain.value = 1.0;
}

function updateNoiseGateLevel(level) {
  ncSuppressionLevel = level;
  echoSet("echo-nc-level", String(level));
  debugLog("[noise-cancel] Suppression level changed to " + ["Light", "Medium", "Strong"][level]);
  if (noiseCancelEnabled && ncGateNode) {
    if (level === 0) { stopNoiseGate(); ncGateNode.gain.value = 1.0; }
    else startNoiseGate();
  }
}

function disableNoiseCancellation() {
  stopNoiseGate();
  if (rnnoiseNode) {
    try { rnnoiseNode.port.postMessage("destroy"); } catch (e) {}
    rnnoiseNode.disconnect();
    rnnoiseNode = null;
  }
  ncGateNode = null;
  ncAnalyser = null;

  // Restore original track if we have one
  if (rnnoiseOriginalTrack && room) {
    var LK = getLiveKitClient();
    var micPub = LK ? room.localParticipant.getTrackPublication(LK.Track.Source.Microphone) : null;
    if (micPub && micPub.track && micPub.track.sender) {
      micPub.track.sender.replaceTrack(rnnoiseOriginalTrack).catch(function() {});
    }
    rnnoiseOriginalTrack = null;
  }

  if (rnnoiseCtx) {
    rnnoiseCtx.close().catch(function() {});
    rnnoiseCtx = null;
  }

  debugLog("[noise-cancel] RNNoise disabled");
}

function updateNoiseCancelUI() {
  var btn = document.getElementById("nc-toggle-btn");
  if (btn) {
    btn.textContent = noiseCancelEnabled ? "ON" : "OFF";
    btn.classList.toggle("is-on", noiseCancelEnabled);
  }
}
