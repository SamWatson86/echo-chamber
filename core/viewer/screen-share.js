/* =========================================================
   SCREEN SHARE — Canvas pipeline, WASAPI audio, stats, and adaptive bitrate
   ========================================================= */

function getScreenSharePublishOptions(srcW, srcH) {
  // Compute simulcast layers dynamically based on actual source dimensions.
  // This prevents the MEDIUM layer from matching HIGH when the source height
  // is less than 1080 (e.g. ultrawide 1920x804 after canvas cap).
  // Layers: MEDIUM = half resolution, LOW = third resolution.
  var medW = Math.round((srcW || 1920) / 2);
  var medH = Math.round((srcH || 1080) / 2);
  medW = medW - (medW % 2); medH = medH - (medH % 2); // even dims for H.264
  var lowW = Math.round((srcW || 1920) / 3);
  var lowH = Math.round((srcH || 1080) / 3);
  lowW = lowW - (lowW % 2); lowH = lowH - (lowH % 2);
  debugLog("[simulcast] layers: HIGH=" + (srcW||1920) + "x" + (srcH||1080) +
    " MED=" + medW + "x" + medH + " LOW=" + lowW + "x" + lowH);
  return {
    // H264 High profile with hardware encoding (NVENC/QSV/AMF) via WebView2 flags.
    // SDP is munged to upgrade Constrained Baseline (42e0) -> High (6400) to force
    // hardware encoder selection. Software encoders (OpenH264, libvpx) max ~25fps.
    videoCodec: "h264",
    // Simulcast: 3 quality layers so each receiver gets what their hardware can decode.
    // HIGH = source resolution @60fps. MEDIUM = half @60fps. LOW = third @30fps.
    // Layers are computed dynamically to guarantee MEDIUM < HIGH (ultrawide fix).
    // SFU selects the best layer per subscriber based on bandwidth + decode capability.
    simulcast: true,
    screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
    screenShareSimulcastLayers: [
      { width: medW, height: medH, encoding: { maxBitrate: 5_000_000, maxFramerate: 60 } },
      { width: lowW, height: lowH, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
    ],
    // "maintain-framerate" drops resolution under pressure instead of FPS.
    // Critical for gaming — smooth 60fps at lower quality beats choppy high-res.
    // Old note: "caused encoder startup issues with NVENC (0fps)" — that was the
    // 12-second encoder death bug, now fixed by the canvas pipeline keeping frames flowing.
    degradationPreference: "maintain-framerate",
  };
}

// Track refs for manual screen share (so we can unpublish on stop)
let _screenShareVideoTrack = null;
let _screenShareAudioTrack = null;
let _screenShareStatsInterval = null;
let _inboundScreenStatsInterval = null;
let _inboundScreenLastBytes = new Map(); // identity -> { bytes, time }
// Adaptive layer selection: track quality per inbound video (screen shares + cameras)
// to auto-downgrade when decoder/network can't keep up, and upgrade when stable.
let _inboundDropTracker = new Map(); // "identity-source" -> { lastDropped, lastDecoded, highDropTicks, lowFpsTicks, stableTicks, currentQuality }
// ── Adaptive publisher bitrate control (receiver side) ──
// AIMD algorithm: when we detect loss on a remote screen share, we compute an
// optimal bitrate cap and send it to the publisher via data channel. The publisher
// applies it to their RTCRtpSender, reducing upload without changing resolution.
let _pubBitrateControl = new Map(); // publisherIdentity -> AIMD controller state

function startInboundScreenStatsMonitor() {
  if (_inboundScreenStatsInterval) return;
  _inboundScreenStatsInterval = setInterval(async () => {
    try {
      if (!room || !room.remoteParticipants) return;
      const LK = getLiveKitClient();
      // Extract ICE candidate-pair info once per poll cycle (from subscriber PeerConnection)
      var _iceType = "";
      try {
        const subPc = room.engine?.pcManager?.subscriber?.pc;
        if (subPc) {
          const pcStats = await subPc.getStats();
          const iceCandidates = new Map();
          pcStats.forEach(function(r) {
            if (r.type === "local-candidate" || r.type === "remote-candidate") iceCandidates.set(r.id, r);
          });
          pcStats.forEach(function(r) {
            if (r.type === "candidate-pair" && r.state === "succeeded") {
              const lc = iceCandidates.get(r.localCandidateId);
              const rc = iceCandidates.get(r.remoteCandidateId);
              var lType = lc?.candidateType || "?";
              var rType = rc?.candidateType || "?";
              var rtt = r.currentRoundTripTime ? Math.round(r.currentRoundTripTime * 1000) : "?";
              _iceType = `ice=${lType}->${rType} rtt=${rtt}ms`;
            }
          });
        }
      } catch (e) { /* ignore ICE stats errors */ }
      room.remoteParticipants.forEach(async (participant) => {
        const pubs = getParticipantPublications(participant);
        for (const pub of pubs) {
          // Monitor both screen shares and cameras (video only)
          if (pub?.source !== LK?.Track?.Source?.ScreenShare &&
              pub?.source !== LK?.Track?.Source?.Camera) continue;
          if (pub?.kind !== LK?.Track?.Kind?.Video) continue;
          if (!pub.track || !pub.isSubscribed) continue;
          // Skip unwatched screen shares
          if (pub.source === LK?.Track?.Source?.ScreenShare && hiddenScreens.has(participant.identity)) continue;
          // Get receiver stats from the track's mediaStreamTrack
          const mst = pub.track.mediaStreamTrack;
          if (!mst) continue;
          const pc = room.engine?.pcManager?.subscriber?.pc;
          if (!pc) continue;
          const receivers = pc.getReceivers();
          const receiver = receivers.find(r => r.track === mst);
          if (!receiver) continue;
          const stats = await receiver.getStats();
          var isCamera = pub.source === LK?.Track?.Source?.Camera;
          var sourceLabel = isCamera ? "camera" : "screen";
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && report.kind === "video") {
              const fps = report.framesPerSecond || 0;
              const w = report.frameWidth || 0;
              const h = report.frameHeight || 0;
              const now = Date.now();
              // Source-aware key so camera + screen for same participant are tracked independently
              const key = participant.identity + "-" + sourceLabel;
              const prev = _inboundScreenLastBytes.get(key);
              let kbps = 0;
              if (prev) {
                const elapsed = (now - prev.time) / 1000;
                const bytesDelta = report.bytesReceived - prev.bytes;
                kbps = elapsed > 0 ? Math.round((bytesDelta * 8) / elapsed / 1000) : 0;
              }
              _inboundScreenLastBytes.set(key, { bytes: report.bytesReceived, time: now });
              // Get codec info
              let codec = "?";
              if (report.codecId) {
                const codecReport = stats.get(report.codecId);
                if (codecReport) codec = codecReport.mimeType?.replace("video/", "") || "?";
              }
              const jitter = report.jitter ? Math.round(report.jitter * 1000) : 0;
              const pktLost = report.packetsLost || 0;
              const decoder = report.decoderImplementation || "?";
              const dropped = report.framesDropped || 0;
              const decoded = report.framesDecoded || 0;
              const nacks = report.nackCount || 0;
              const plis = report.pliCount || 0;

              // ── Adaptive layer selection: rolling average approach ──
              // Previous approach counted individual bad ticks but failed when FPS oscillates
              // (e.g. 13→23→29→14→25→18) — counter went up/down without ever triggering.
              // Now we track a rolling window of FPS samples and decide based on the AVERAGE.
              var dt = _inboundDropTracker.get(key);
              if (!dt) {
                // Cameras start on LOW (forceVideoLayer sends LOW first, then upgrades).
                // Screen shares start on HIGH. Initialize to match actual requested layer
                // to prevent false "HIGH is failing" downgrades.
                var initQuality = isCamera ? "LOW" : "HIGH";
                dt = {
                  lastDropped: dropped, lastDecoded: decoded,
                  lastLost: pktLost,    // track packet loss delta for proactive keyframe requests
                  fpsHistory: [],       // last N fps readings (rolling window)
                  lossHistory: [],      // last N ticks of packet loss deltas (rolling window for loss-rate detection)
                  lossDowngraded: false, // true if currently downgraded due to packet loss
                  lossStableTicks: 0,   // consecutive ticks with zero loss (for promote-back)
                  stableTicks: 0,
                  currentQuality: initQuality,
                  lastLayerChangeTime: 0,
                };
                _inboundDropTracker.set(key, dt);
              }
              var deltaDropped = dropped - dt.lastDropped;
              var deltaDecoded = decoded - dt.lastDecoded;
              dt.lastDropped = dropped;
              dt.lastDecoded = decoded;
              var dropRatio = deltaDecoded > 0 ? deltaDropped / (deltaDropped + deltaDecoded) : 0;

              // ── Proactive keyframe request on packet loss ──
              // When packets are lost, the decoder may stall waiting for a reference frame.
              // Rather than waiting for the natural PLI cycle (which can take seconds), we
              // detect new losses and immediately request a keyframe to speed recovery.
              // This is especially important for TURN relay users where RTT is 40-80ms —
              // NACK retransmission alone may not recover in time.
              var deltaLost = pktLost - (dt.lastLost || 0);
              dt.lastLost = pktLost;
              if (deltaLost > 0) {
                debugLog(`[packet-loss] ${key}: ${deltaLost} new packets lost (total=${pktLost}), requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }
              // Also detect FPS stall (0fps when we previously had frames) — decoder is stuck
              if (fps === 0 && dt.fpsHistory.length > 0 && dt.fpsHistory[dt.fpsHistory.length - 1] > 0) {
                debugLog(`[stall-recovery] ${key}: FPS dropped to 0 (was ${dt.fpsHistory[dt.fpsHistory.length - 1]}), requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }

              var qualityChanged = false;

              // ── SCREEN SHARES: Adaptive Publisher Bitrate Control (AIMD) ──
              // Instead of switching simulcast layers (which causes 1080p→360p jumps),
              // we tell the PUBLISHER to reduce their encoder bitrate. Resolution stays
              // 1080p@60fps; only compression level changes. Uses data channel messages.
              if (!isCamera && participant && room?.localParticipant) {
                var pubIdent = participant.identity;
                var ctrl = _pubBitrateControl.get(pubIdent);
                if (!ctrl) {
                  ctrl = {
                    lossHistory: [], kbpsHistory: [],
                    currentCapHigh: BITRATE_DEFAULT_HIGH, capped: false,
                    probePhase: "idle", probeBitrate: 0, probeCleanTicks: 0,
                    lastCapSendTime: 0, lastLossTime: 0, cleanTicksSinceLoss: 0,
                    ackReceived: false, firstCapSendTime: 0, fallbackToLayers: false,
                    _lockedHigh: false,
                  };
                  _pubBitrateControl.set(pubIdent, ctrl);
                }

                // Feed data into AIMD
                ctrl.lossHistory.push(deltaLost);
                if (ctrl.lossHistory.length > 10) ctrl.lossHistory.shift();
                ctrl.kbpsHistory.push(kbps);
                if (ctrl.kbpsHistory.length > 10) ctrl.kbpsHistory.shift();

                // EWMA loss (alpha=0.3, recent ticks weighted more)
                var ewmaLoss = 0, weightSum = 0;
                for (var ei = 0; ei < ctrl.lossHistory.length; ei++) {
                  var w_e = Math.pow(0.7, ctrl.lossHistory.length - 1 - ei);
                  ewmaLoss += ctrl.lossHistory[ei] * w_e;
                  weightSum += w_e;
                }
                ewmaLoss = weightSum > 0 ? ewmaLoss / weightSum : 0;

                // Average received kbps
                var avgKbps = ctrl.kbpsHistory.reduce(function(a, b) { return a + b; }, 0) /
                              Math.max(1, ctrl.kbpsHistory.length);

                // Estimate loss rate
                var lossRate = 0;
                if (avgKbps > 0 && ewmaLoss > 0) {
                  var estTotalPkts = (avgKbps * 1000 / 8 / 1200) * 3 + ewmaLoss;
                  lossRate = ewmaLoss / Math.max(1, estTotalPkts);
                }

                // ── AIMD trigger: use loss RATE not absolute count ──
                // At 12Mbps/60fps through TURN relay, ~4000 packets per 3s tick.
                // TURN relay normally produces 0.03% loss (small bursts of 1-50 pkts).
                // Only trigger AIMD when loss rate exceeds 0.5% (genuine congestion).
                var estPktsPerTick = Math.max(100, (avgKbps * 1000 / 8 / 1200) * 3);
                var tickLossRate = deltaLost / estPktsPerTick;
                var isCongestion = tickLossRate > 0.005; // >0.5% loss rate
                var isSevereCongestion = tickLossRate > 0.02; // >2% loss rate
                var targetHighBps = ctrl.currentCapHigh;
                var nowCtrl = Date.now();

                if (isCongestion) {
                  // ── LOSS DETECTED: multiplicative decrease ──
                  ctrl.lastLossTime = nowCtrl;
                  ctrl.cleanTicksSinceLoss = 0;
                  ctrl.probePhase = "backing-off";
                  ctrl.probeCleanTicks = 0;

                  if (!ctrl.capped) {
                    // First congestion: cut to 70% of received bitrate
                    targetHighBps = Math.round(avgKbps * 1000 * 0.7);
                  } else {
                    // Already capped, still congested: ×0.7 multiplicative decrease
                    targetHighBps = Math.round(ctrl.currentCapHigh * 0.7);
                  }
                  // Severe congestion: more aggressive (50%)
                  if (isSevereCongestion) {
                    targetHighBps = Math.round(avgKbps * 1000 * 0.5);
                  }
                  // Floor 1Mbps, ceiling 15Mbps
                  targetHighBps = Math.max(1_000_000, Math.min(targetHighBps, BITRATE_DEFAULT_HIGH));
                  ctrl.currentCapHigh = targetHighBps;
                  ctrl.capped = true;
                  debugLog("[bitrate-ctrl] " + pubIdent + ": lossRate=" +
                    (tickLossRate * 100).toFixed(2) + "% (" + deltaLost + "/" +
                    Math.round(estPktsPerTick) + " pkts) → cap=" +
                    Math.round(targetHighBps / 1000) + "kbps");

                } else {
                  // ── LOW/MODERATE LOSS (below congestion threshold): recover ──
                  // Allow recovery even during stalls (fps=0) — the old fps>0 check
                  // caused a deadlock: AIMD capped → stall → couldn't uncap because fps=0
                  // TURN relay normally has 0.03-0.15% loss — this is NOT congestion.
                  ctrl.cleanTicksSinceLoss++;

                  // ── BURST DETECTION: instant snap-back for transient loss ──
                  // TURN relay bursts are transient (wifi interference, buffer overflow).
                  // Pattern: large loss in one tick, then immediately clean.
                  // If the FIRST tick after capping is clean, path capacity is unchanged
                  // — snap back immediately instead of slow 12s probe ramp.
                  if (ctrl.capped && ctrl.cleanTicksSinceLoss === 1 && ctrl.probePhase === "backing-off") {
                    // First tick after loss is clean → burst, not sustained congestion
                    debugLog("[bitrate-ctrl] " + pubIdent + ": burst detected (clean after 1 tick) — INSTANT SNAP BACK");
                    targetHighBps = BITRATE_DEFAULT_HIGH;
                    ctrl.currentCapHigh = targetHighBps;
                    ctrl.capped = false;
                    ctrl.probePhase = "idle";
                    ctrl.lossHistory = [];
                    ctrl.kbpsHistory = [];
                  }
                  // Sustained congestion recovery: slow probe ramp
                  else if (ctrl.capped && ctrl.cleanTicksSinceLoss >= 3) {
                    // 3 consecutive clean ticks (~9s) = sustained congestion has cleared
                    debugLog("[bitrate-ctrl] " + pubIdent + ": 9s low-loss — SNAP BACK to full bitrate");
                    targetHighBps = BITRATE_DEFAULT_HIGH;
                    ctrl.currentCapHigh = targetHighBps;
                    ctrl.capped = false;
                    ctrl.probePhase = "idle";
                    ctrl.lossHistory = [];
                    ctrl.kbpsHistory = [];
                  } else if (ctrl.capped && ctrl.probePhase === "backing-off" && ctrl.cleanTicksSinceLoss >= 2) {
                    // 2 clean ticks but not burst (loss continued for >1 tick) — start probing
                    ctrl.probePhase = "probing";
                    ctrl.probeCleanTicks = 0;
                    ctrl.probeBitrate = ctrl.currentCapHigh + 3_000_000; // faster: +3Mbps steps
                    ctrl.probeBitrate = Math.min(ctrl.probeBitrate, BITRATE_DEFAULT_HIGH);
                    targetHighBps = ctrl.probeBitrate;
                    ctrl.currentCapHigh = targetHighBps;
                  } else if (ctrl.probePhase === "probing") {
                    ctrl.probeCleanTicks++;
                    // 1 clean tick (~3s) per step, +3Mbps per step
                    if (ctrl.probeCleanTicks >= 1) {
                      ctrl.probeCleanTicks = 0;
                      ctrl.probeBitrate = ctrl.currentCapHigh + 3_000_000;
                      if (ctrl.probeBitrate >= BITRATE_DEFAULT_HIGH) {
                        // Reached full bitrate — uncap
                        targetHighBps = BITRATE_DEFAULT_HIGH;
                        ctrl.currentCapHigh = targetHighBps;
                        ctrl.capped = false;
                        ctrl.probePhase = "idle";
                        ctrl.lossHistory = [];
                        ctrl.kbpsHistory = [];
                      } else {
                        targetHighBps = ctrl.probeBitrate;
                        ctrl.currentCapHigh = targetHighBps;
                      }
                    }
                  }
                }

                // Send cap or restore to publisher
                if (ctrl.capped && nowCtrl - ctrl.lastCapSendTime >= 2000) {
                  ctrl.lastCapSendTime = nowCtrl;
                  if (!ctrl.firstCapSendTime) ctrl.firstCapSendTime = nowCtrl;
                  var capMsg = {
                    type: "bitrate-cap", version: 1,
                    targetBitrateHigh: targetHighBps,
                    targetBitrateMed: Math.round(targetHighBps * 0.33),
                    targetBitrateLow: Math.round(targetHighBps * 0.1),
                    reason: isSevereCongestion ? "severe" : isCongestion ? "congestion" :
                            ctrl.probePhase === "probing" ? "probe" : "hold",
                    lossRate: Math.round(lossRate * 1000) / 1000,
                    senderIdentity: room.localParticipant.identity
                  };
                  try {
                    room.localParticipant.publishData(
                      new TextEncoder().encode(JSON.stringify(capMsg)),
                      { reliable: true, destinationIdentities: [pubIdent] }
                    );
                    debugLog("[bitrate-ctrl] sent cap to " + pubIdent + ": HIGH=" +
                      Math.round(targetHighBps / 1000) + "kbps phase=" + ctrl.probePhase +
                      " reason=" + capMsg.reason);
                  } catch (e) { /* ignore send failure */ }

                  // Ensure we stay on HIGH layer (don't also downgrade layer)
                  if (!ctrl._lockedHigh && LK?.VideoQuality) {
                    try {
                      if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                    } catch (e) {}
                    ctrl._lockedHigh = true;
                  }
                }

                // Send restore when uncapped (once)
                if (!ctrl.capped && ctrl.lastCapSendTime > 0) {
                  var restoreMsg = {
                    type: "bitrate-cap", version: 1,
                    targetBitrateHigh: BITRATE_DEFAULT_HIGH,
                    targetBitrateMed: BITRATE_DEFAULT_MED,
                    targetBitrateLow: BITRATE_DEFAULT_LOW,
                    reason: "restore", lossRate: 0,
                    senderIdentity: room.localParticipant.identity
                  };
                  try {
                    room.localParticipant.publishData(
                      new TextEncoder().encode(JSON.stringify(restoreMsg)),
                      { reliable: true, destinationIdentities: [pubIdent] }
                    );
                    debugLog("[bitrate-ctrl] sent RESTORE to " + pubIdent);
                  } catch (e) { /* ignore */ }
                  ctrl.lastCapSendTime = 0;
                  ctrl.firstCapSendTime = 0;
                  ctrl._lockedHigh = false;
                }

                // Fallback: if publisher never ack'd after 10s, revert to v3 layer switching
                if (ctrl.capped && ctrl.firstCapSendTime > 0 && !ctrl.ackReceived &&
                    nowCtrl - ctrl.firstCapSendTime > 10000) {
                  debugLog("[bitrate-ctrl] " + pubIdent + " no ack after 10s — falling back to layer switching");
                  ctrl.fallbackToLayers = true;
                  _pubBitrateControl.delete(pubIdent);
                }
              }

              // ── CAMERAS (or screen share fallback): v3 layer switching ──
              // Only used for camera tracks, or screen shares where bitrate control failed.
              var _bitrateCtrlActive = !isCamera && _pubBitrateControl.has(participant?.identity);
              if (!_bitrateCtrlActive) {
                dt.lossHistory.push(deltaLost);
                if (dt.lossHistory.length > 8) dt.lossHistory.shift();
                var nowMsLoss = Date.now();
                var timeSinceLastLossChange = nowMsLoss - (dt.lastLayerChangeTime || 0);
                var prevFps = dt.fpsHistory.length > 0 ? dt.fpsHistory[dt.fpsHistory.length - 1] : 0;
                var isStalled = fps === 0 && prevFps > 0;
                var isTanking = fps > 0 && fps < 30 && prevFps >= 30 && deltaLost > 15;
                var isBurstNuke = deltaLost >= 50;
                var shouldDropLow = (isStalled && deltaLost > 0) || isTanking || isBurstNuke;

                if (shouldDropLow && dt.currentQuality !== "LOW" && timeSinceLastLossChange >= 3000 && LK?.VideoQuality) {
                  var oldQ = dt.currentQuality;
                  dt.currentQuality = "LOW";
                  dt.lossDowngraded = true;
                  dt.lossStableTicks = 0;
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMsLoss;
                  dt.lossHistory = [];
                  qualityChanged = true;
                  var dropReason = isStalled ? "stall+loss(" + deltaLost + ")" : isTanking ? "fps-tanking(" + fps + "fps+" + deltaLost + "lost)" : "burst-nuke(" + deltaLost + "lost)";
                  debugLog("[adaptive-loss] " + key + ": INSTANT DROP " + oldQ + " -> LOW (" + dropReason + ")");
                  logEvent("loss-drop", key + ": " + oldQ + "->LOW " + dropReason);
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.LOW);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.LOW });
                  } catch (e) { debugLog("[adaptive-loss] drop failed: " + e.message); }
                }

                if (dt.lossDowngraded) {
                  if (deltaLost === 0 && fps > 0) {
                    dt.lossStableTicks++;
                  } else {
                    dt.lossStableTicks = 0;
                  }
                  if (dt.lossStableTicks >= 4 && timeSinceLastLossChange >= 12000 && LK?.VideoQuality) {
                    dt.currentQuality = "HIGH";
                    dt.lossDowngraded = false;
                    dt.fpsHistory = [];
                    dt.stableTicks = 0;
                    dt.lossStableTicks = 0;
                    dt.lossHistory = [];
                    dt.lastLayerChangeTime = nowMsLoss;
                    qualityChanged = true;
                    debugLog("[adaptive-loss] " + key + ": clean 12s, SNAP BACK LOW -> HIGH");
                    logEvent("loss-snapback", key + ": LOW->HIGH");
                    try {
                      if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                      if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.HIGH });
                    } catch (e) { debugLog("[adaptive-loss] snapback failed: " + e.message); }
                  }
                }
              }

              // Push FPS into rolling window (keep last 5 ticks = 15 seconds)
              if (fps > 0) dt.fpsHistory.push(fps);
              if (dt.fpsHistory.length > 5) dt.fpsHistory.shift();

              // Calculate rolling average FPS (used by both layer switching and debug log)
              var avgFps = 0;
              if (dt.fpsHistory.length > 0) {
                avgFps = dt.fpsHistory.reduce(function(a, b) { return a + b; }, 0) / dt.fpsHistory.length;
              }

              // ── FPS-based layer switching ──
              // Skip for screen shares when AIMD bitrate control is active — bitrate
              // control handles quality smoothly without resolution jumps. Only used
              // for cameras, or screen shares where bitrate control isn't active/failed.
              if (!_bitrateCtrlActive) {

              // Downgrade when rolling average is clearly bad:
              // - avgFps < 30 over 15 seconds = consistently struggling (catches Jeff's 13-29fps oscillation)
              // - OR decode struggles (> 40% frame drop ratio)
              // Spencer on fiber at 50-60fps will never hit avgFps < 30.
              var shouldDowngrade = (dt.fpsHistory.length >= 4 && avgFps < 30) || dropRatio > 0.4;
              var reason = dropRatio > 0.4 ? "decode (drop=" + Math.round(dropRatio * 100) + "%)"
                : "low avg fps (" + Math.round(avgFps) + "fps avg over " + dt.fpsHistory.length + " ticks)";

              // Cooldown: don't switch layers more than once per 30 seconds to prevent thrashing
              var nowMs = Date.now();
              var timeSinceLastChange = nowMs - dt.lastLayerChangeTime;
              var layerCooldown = 30000;

              if (shouldDowngrade && timeSinceLastChange >= layerCooldown && dt.currentQuality === "HIGH" && LK?.VideoQuality) {
                var newQuality = isCamera ? "LOW" : "MEDIUM";
                var newLKQuality = isCamera ? LK.VideoQuality.LOW : LK.VideoQuality.MEDIUM;
                dt.currentQuality = newQuality;
                dt.fpsHistory = []; // reset window after layer change
                dt.stableTicks = 0;
                dt.lastLayerChangeTime = nowMs;
                qualityChanged = true;
                debugLog("[adaptive-layer] " + key + ": " + reason + ", downgrading HIGH -> " + newQuality);
                logEvent("layer-downgrade", key + ": HIGH->" + newQuality + " " + reason);
                try {
                  if (pub.setVideoQuality) pub.setVideoQuality(newLKQuality);
                  if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: newLKQuality });
                } catch (e) { debugLog("[adaptive-layer] downgrade failed: " + e.message); }
              } else if (shouldDowngrade && timeSinceLastChange >= layerCooldown && dt.currentQuality === "MEDIUM" && !isCamera && LK?.VideoQuality) {
                // Only downgrade MEDIUM -> LOW if there are actual decode problems (frame drops).
                // If dropRatio is near zero, the frames that arrive decode fine — the bottleneck is
                // the SFU transport pacer (e.g. TURN relay users), and downgrading to LOW just gives
                // worse resolution at the same FPS. Better to stay on MEDIUM (1080p@20fps > 720p@20fps).
                if (dropRatio > 0.1) {
                  dt.currentQuality = "LOW";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": " + reason + " + decode drops=" + Math.round(dropRatio*100) + "%, downgrading MEDIUM -> LOW");
                  logEvent("layer-downgrade", key + ": MEDIUM->LOW drops=" + Math.round(dropRatio*100) + "%");
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.LOW);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.LOW });
                  } catch (e) { debugLog("[adaptive-layer] downgrade failed: " + e.message); }
                } else {
                  debugLog("[adaptive-layer] " + key + ": " + reason + " but drops=" + Math.round(dropRatio*100) + "% (near-zero), staying on MEDIUM (SFU pacer bottleneck, not decode)");
                }
              }

              // ── Upgrade: climb back when rolling average is good for current layer ──
              // Compare against what's achievable at current layer:
              // - LOW layer caps at 30fps → upgrade if avgFps >= 27 (90% of cap) and low jitter
              // - MEDIUM layer caps at 60fps → upgrade if avgFps >= 45
              // Bug fix: old code required avgFps >= 45 always, which is impossible on LOW (30fps cap)
              // LOW cameras through TURN relay often cap at ~25fps, so 27fps threshold
              // creates a permanent stuck-on-LOW feedback loop. Use 20fps for LOW.
              var upgradeThreshold = dt.currentQuality === "LOW" ? 20 : 45;
              // Don't let FPS-based system upgrade when loss system is holding quality down
              var shouldUpgrade = !shouldDowngrade && !dt.lossDowngraded && avgFps >= upgradeThreshold && jitter < 25 && dropRatio < 0.15;
              if (shouldUpgrade && dt.currentQuality !== "HIGH") {
                dt.stableTicks++;
              } else if (dt.currentQuality !== "HIGH") {
                dt.stableTicks = Math.max(0, dt.stableTicks - 1);
              }
              // Cameras: 4 good ticks (12s), Screen shares: 8 ticks (24s) + cooldown
              var upgradeTicksNeeded = isCamera ? 4 : 8;
              if (dt.stableTicks >= upgradeTicksNeeded && timeSinceLastChange >= layerCooldown && dt.currentQuality !== "HIGH" && LK?.VideoQuality) {
                if (dt.currentQuality === "LOW" && !isCamera) {
                  dt.currentQuality = "MEDIUM";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": stable 24s (avg " + Math.round(avgFps) + "fps), upgrading LOW -> MEDIUM");
                  logEvent("layer-upgrade", key + ": LOW->MEDIUM avgFps=" + Math.round(avgFps));
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.MEDIUM);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.MEDIUM });
                  } catch (e) { debugLog("[adaptive-layer] upgrade failed: " + e.message); }
                } else {
                  dt.currentQuality = "HIGH";
                  dt.fpsHistory = [];
                  dt.stableTicks = 0;
                  dt.lastLayerChangeTime = nowMs;
                  qualityChanged = true;
                  debugLog("[adaptive-layer] " + key + ": stable 24s (avg " + Math.round(avgFps) + "fps), upgrading -> HIGH");
                  logEvent("layer-upgrade", key + ": ->HIGH avgFps=" + Math.round(avgFps));
                  try {
                    if (pub.setVideoQuality) pub.setVideoQuality(LK.VideoQuality.HIGH);
                    if (pub.setPreferredLayer) pub.setPreferredLayer({ quality: LK.VideoQuality.HIGH });
                  } catch (e) { debugLog("[adaptive-layer] upgrade failed: " + e.message); }
                }
              }
              } // end if (!_bitrateCtrlActive) — FPS-based layer switching guard

              var layerInfo = qualityChanged ? " [LAYER->" + dt.currentQuality + "]" : "";
              // Store latest report for persistent stats logging
              dt._lastReport = { fps: fps, w: w, h: h, kbps: kbps, jitter: jitter, lost: pktLost, dropped: dropped, decoded: decoded, nack: nacks, pli: plis, codec: codec !== "?" ? codec : null, _deltaLost: deltaLost };
              debugLog(`Inbound ${sourceLabel} ${participant.identity}: ${fps}fps ${w}x${h} ${kbps}kbps codec=${codec} decoder=${decoder} jitter=${jitter}ms lost=${pktLost} dropped=${dropped}/${decoded} (${Math.round(dropRatio*100)}%/tick) nack=${nacks} pli=${plis} avgFps=${Math.round(avgFps)} layer=${dt.currentQuality}${layerInfo}${_iceType ? " " + _iceType : ""}`);
            }
          });
        }
      });
    } catch {}
  }, 3000);
}

function stopInboundScreenStatsMonitor() {
  if (_inboundScreenStatsInterval) {
    clearInterval(_inboundScreenStatsInterval);
    _inboundScreenStatsInterval = null;
  }
  _inboundScreenLastBytes.clear();
  _inboundDropTracker.clear();
}

// Native per-process audio capture (Tauri client only)
var _nativeAudioCtx = null;        // AudioContext for worklet
var _nativeAudioWorklet = null;     // AudioWorkletNode
var _nativeAudioDest = null;        // MediaStreamDestination
var _nativeAudioTrack = null;       // Published LiveKit track
var _nativeAudioUnlisten = null;    // Tauri event unlisten function
var _nativeAudioActive = false;

async function startScreenShareManual() {
  const LK = getLiveKitClient();

  // Call getDisplayMedia ourselves — no fixed width/height so ultrawides
  // capture at native aspect ratio instead of being forced to 16:9
  var isNativeClient = !!window.__ECHO_NATIVE__;
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
    // captureStream(60) = auto-capture at 60fps — browser drives frame timing
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
  // Stop native per-process audio capture if active
  await stopNativeAudioCapture();
  // Clean up canvas pipeline (Web Worker frame timer)
  if (window._canvasFrameWorker) {
    try { window._canvasFrameWorker.postMessage("stop"); window._canvasFrameWorker.terminate(); } catch {}
    window._canvasFrameWorker = null;
  }
  if (window._canvasRafId) { cancelAnimationFrame(window._canvasRafId); window._canvasRafId = null; }
  if (window._canvasOffVideo) { window._canvasOffVideo.pause(); window._canvasOffVideo.srcObject = null; window._canvasOffVideo = null; }
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

// Adaptive camera quality: reduce camera when screen share is bandwidth-constrained
async function reduceCameraForScreenShare() {
  try {
    const LK = getLiveKitClient();
    const pubs = getParticipantPublications(room.localParticipant);
    const camPub = pubs.find((p) => p?.source === LK?.Track?.Source?.Camera && p.track);
    if (!camPub?.track?.sender) return;
    const sender = camPub.track.sender;
    const params = sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      params.encodings[0].maxBitrate = 300000; // 300kbps
      params.encodings[0].maxFramerate = 15;
      params.encodings[0].scaleResolutionDownBy = 2; // halve resolution
      await sender.setParameters(params);
    }
  } catch (e) { debugLog("Adaptive camera reduce failed: " + e.message); }
}

async function restoreCameraQuality() {
  try {
    const LK = getLiveKitClient();
    const pubs = getParticipantPublications(room.localParticipant);
    const camPub = pubs.find((p) => p?.source === LK?.Track?.Source?.Camera && p.track);
    if (!camPub?.track?.sender) return;
    const sender = camPub.track.sender;
    const params = sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      delete params.encodings[0].maxBitrate;
      params.encodings[0].maxFramerate = 30;
      delete params.encodings[0].scaleResolutionDownBy;
      await sender.setParameters(params);
    }
  } catch (e) { debugLog("Adaptive camera restore failed: " + e.message); }
}

// ── Adaptive publisher bitrate control — publisher-side functions ──
// Receives bitrate-cap messages from viewers and applies to local screen share sender.
function handleBitrateCapRequest(msg, participant) {
  if (!_screenShareVideoTrack?.sender) {
    debugLog("[bitrate-ctrl] ignoring cap request — not screen sharing");
    return;
  }
  var senderIdent = msg.senderIdentity || participant?.identity || "unknown";
  var capHigh = Math.max(500_000, Math.min(msg.targetBitrateHigh || BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_HIGH));
  var capMed = Math.max(300_000, Math.min(msg.targetBitrateMed || Math.round(capHigh * 0.33), BITRATE_DEFAULT_MED));
  var capLow = Math.max(200_000, Math.min(msg.targetBitrateLow || Math.round(capHigh * 0.1), BITRATE_DEFAULT_LOW));
  // Enforce layer ordering: HIGH > MED > LOW
  if (capMed >= capHigh) capMed = Math.round(capHigh * 0.6);
  if (capLow >= capMed) capLow = Math.round(capMed * 0.5);

  _bitrateCaps.set(senderIdent, {
    high: capHigh, med: capMed, low: capLow,
    timestamp: Date.now(), reason: msg.reason || "unknown"
  });
  debugLog("[bitrate-ctrl] cap from " + senderIdent + ": HIGH=" +
    Math.round(capHigh / 1000) + "kbps reason=" + (msg.reason || "?") +
    " lossRate=" + (msg.lossRate || "?"));

  // Start cleanup timer if not already running
  if (!_bitrateCapCleanupTimer) {
    _bitrateCapCleanupTimer = setInterval(cleanupAndApplyBitrateCaps, 5000);
  }
  applyMostRestrictiveCap();

  // Ack back to requester
  try {
    var ack = JSON.stringify({
      type: "bitrate-cap-ack", version: 1,
      appliedBitrateHigh: capHigh, identity: room?.localParticipant?.identity
    });
    room.localParticipant.publishData(
      new TextEncoder().encode(ack),
      { reliable: true, destinationIdentities: [senderIdent] }
    );
  } catch (e) { /* ignore ack failure */ }
}

function cleanupAndApplyBitrateCaps() {
  var now = Date.now();
  var expired = [];
  _bitrateCaps.forEach(function(cap, ident) {
    if (now - cap.timestamp > BITRATE_CAP_TTL) expired.push(ident);
  });
  expired.forEach(function(ident) {
    _bitrateCaps.delete(ident);
    debugLog("[bitrate-ctrl] cap expired from " + ident);
  });
  if (_bitrateCaps.size === 0 && _currentAppliedCap !== null) {
    debugLog("[bitrate-ctrl] all caps expired, restoring defaults");
    _currentAppliedCap = null;
    applyBitrateToSender(BITRATE_DEFAULT_HIGH, BITRATE_DEFAULT_MED, BITRATE_DEFAULT_LOW);
    clearInterval(_bitrateCapCleanupTimer);
    _bitrateCapCleanupTimer = null;
  } else if (_bitrateCaps.size > 0) {
    applyMostRestrictiveCap();
  }
}

function applyMostRestrictiveCap() {
  var minHigh = BITRATE_DEFAULT_HIGH;
  var minMed = BITRATE_DEFAULT_MED;
  var minLow = BITRATE_DEFAULT_LOW;
  _bitrateCaps.forEach(function(cap) {
    if (cap.high < minHigh) minHigh = cap.high;
    if (cap.med < minMed) minMed = cap.med;
    if (cap.low < minLow) minLow = cap.low;
  });
  if (_currentAppliedCap &&
      _currentAppliedCap.high === minHigh &&
      _currentAppliedCap.med === minMed) {
    return; // no change
  }
  _currentAppliedCap = { high: minHigh, med: minMed, low: minLow };
  applyBitrateToSender(minHigh, minMed, minLow);
}

function applyBitrateToSender(highBps, medBps, lowBps) {
  var sender = _screenShareVideoTrack?.sender;
  if (!sender) return;
  try {
    var params = sender.getParameters();
    if (!params.encodings) return;
    for (var i = 0; i < params.encodings.length; i++) {
      var enc = params.encodings[i];
      if (enc.rid === "f" || (!enc.rid && params.encodings.length === 1)) {
        enc.maxBitrate = highBps;
      } else if (enc.rid === "h") {
        enc.maxBitrate = medBps;
      } else if (enc.rid === "q") {
        enc.maxBitrate = lowBps;
      }
    }
    sender.setParameters(params).then(function() {
      debugLog("[bitrate-ctrl] applied: HIGH=" + Math.round(highBps / 1000) +
        "kbps MED=" + Math.round(medBps / 1000) + "kbps LOW=" + Math.round(lowBps / 1000) + "kbps");
      logEvent("bitrate-cap-applied", "HIGH=" + Math.round(highBps / 1000) + "kbps");
    }).catch(function(e) {
      debugLog("[bitrate-ctrl] setParameters failed: " + e.message);
    });
  } catch (e) {
    debugLog("[bitrate-ctrl] apply failed: " + e.message);
  }
}
