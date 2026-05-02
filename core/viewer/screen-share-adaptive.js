/* =========================================================
   SCREEN SHARE — AIMD bitrate control + adaptive layer switching + camera adaptation
   ========================================================= */

function getScreenPresentationStatsForIdentity(identity) {
  var tile = screenTileByIdentity.get(identity);
  var video = tile ? tile.querySelector("video") : null;
  if (typeof getVideoPresentationSnapshot === "function") {
    return getVideoPresentationSnapshot(video);
  }
  return video?._echoPresentationStats || null;
}

function startInboundScreenStatsMonitor() {
  if (_inboundScreenStatsInterval) return;
  _inboundScreenStatsInterval = setInterval(async () => {
    try {
      if (!room || !room.remoteParticipants) return;
      const LK = getLiveKitClient();
      // Extract ICE candidate-pair info once per poll cycle (from subscriber PeerConnection)
      var _iceType = "";
      var _iceLocalType = null, _iceRemoteType = null;
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
              _iceLocalType = lType !== "?" ? lType : null;
              _iceRemoteType = rType !== "?" ? rType : null;
              // rtt collected in _iceType debug string above; not POSTed yet —
              // remove the dead intermediate variable. Add back end-to-end if
              // we want it on the dashboard later.
            }
          });
        }
      } catch (e) { /* ignore ICE stats errors */ }
      room.remoteParticipants.forEach(async (participant) => {
        const effectiveIdentity = isScreenIdentity(participant.identity)
          ? getParentIdentity(participant.identity)
          : participant.identity;
        const pubs = getParticipantPublications(participant);
        for (const pub of pubs) {
          // Monitor both screen shares and cameras (video only)
          if (pub?.source !== LK?.Track?.Source?.ScreenShare &&
              pub?.source !== LK?.Track?.Source?.Camera) continue;
          if (pub?.kind !== LK?.Track?.Kind?.Video) continue;
          if (!pub.track || !pub.isSubscribed) continue;
          // Skip unwatched screen shares
          if (pub.source === LK?.Track?.Source?.ScreenShare && hiddenScreens.has(effectiveIdentity)) continue;
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
              const key = effectiveIdentity + "-" + sourceLabel;
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
              // (e.g. 13->23->29->14->25->18) — counter went up/down without ever triggering.
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
              // Localhost/LAN subscribers skip adaptive downgrades — SFU BWE is broken on localhost
              var isLocalhost = _echoServerUrl && (_echoServerUrl.includes("127.0.0.1") || _echoServerUrl.includes("localhost") || _echoServerUrl.includes("192.168."));
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
              // Throttled keyframe requests — at most one per 8 seconds per track.
              // Excessive keyframes flood the encoder and cause brief 0fps stalls.
              var _kfKey = key + "-kf";
              var _lastKf = _inboundScreenLastBytes.get(_kfKey) || 0;
              var _kfElapsed = Date.now() - _lastKf;
              if (deltaLost > 5 && _kfElapsed > 8000) {
                _inboundScreenLastBytes.set(_kfKey, Date.now());
                debugLog(`[packet-loss] ${key}: ${deltaLost} new packets lost (total=${pktLost}), requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }
              // Also detect FPS stall (0fps for 2+ ticks when we previously had frames) — decoder is stuck
              if (fps === 0 && dt.fpsHistory.length >= 2 && dt.fpsHistory[dt.fpsHistory.length - 1] === 0 &&
                  dt.fpsHistory[dt.fpsHistory.length - 2] > 0 && _kfElapsed > 8000) {
                _inboundScreenLastBytes.set(_kfKey, Date.now());
                debugLog(`[stall-recovery] ${key}: FPS at 0 for 2 ticks, requesting keyframe`);
                try {
                  if (pub.track?.requestKeyFrame) pub.track.requestKeyFrame();
                  else if (pub.videoTrack?.requestKeyFrame) pub.videoTrack.requestKeyFrame();
                } catch (e) { /* ignore */ }
              }

              var qualityChanged = false;

              // ── SCREEN SHARES: Adaptive Publisher Bitrate Control (AIMD) ──
              // Instead of switching simulcast layers (which causes 1080p->360p jumps),
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
                    // Already capped, still congested: x0.7 multiplicative decrease
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
                  if (ctrl.capped && ctrl.cleanTicksSinceLoss === 2 && ctrl.probePhase === "backing-off") {
                    // 2 clean ticks after loss → likely burst, not sustained congestion.
                    // Don't snap back instantly — ramp via probing to avoid setParameters churn
                    debugLog("[bitrate-ctrl] " + pubIdent + ": burst detected (clean 2 ticks) — starting probe ramp");
                    ctrl.probePhase = "probing";
                    ctrl.probeCleanTicks = 0;
                    ctrl.probeBitrate = Math.min(ctrl.currentCapHigh + 3_000_000, BITRATE_DEFAULT_HIGH);
                    targetHighBps = ctrl.probeBitrate;
                    ctrl.currentCapHigh = targetHighBps;
                  }
                  // Sustained congestion recovery: slow probe ramp
                  else if (ctrl.capped && ctrl.cleanTicksSinceLoss >= 4) {
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
              // Skip adaptive layer switching for cameras — let WebRTC handle it natively.
              var _bitrateCtrlActive = !isCamera && _pubBitrateControl.has(participant?.identity);
              if (isCamera) {
                // no-op: cameras bypass adaptive layer switching entirely
              } else if (!_bitrateCtrlActive) {
                dt.lossHistory.push(deltaLost);
                if (dt.lossHistory.length > 8) dt.lossHistory.shift();
                var nowMsLoss = Date.now();
                var timeSinceLastLossChange = nowMsLoss - (dt.lastLayerChangeTime || 0);
                var prevFps = dt.fpsHistory.length > 0 ? dt.fpsHistory[dt.fpsHistory.length - 1] : 0;
                // Require 2+ consecutive 0fps ticks to treat as genuine stall —
                // single-tick 0fps is normal during layer switches and keyframe generation.
                var prev2Fps = dt.fpsHistory.length > 1 ? dt.fpsHistory[dt.fpsHistory.length - 2] : -1;
                var isStalled = fps === 0 && prevFps === 0 && prev2Fps >= 0;
                var isTanking = fps > 0 && fps < 30 && prevFps >= 30 && deltaLost > 15;
                var isBurstNuke = deltaLost >= 50;
                // Require meaningful loss (>5 packets), not just TURN relay noise
                var shouldDropLow = (isStalled && deltaLost > 5) || isTanking || isBurstNuke;

                if (shouldDropLow && !isLocalhost && dt.currentQuality !== "LOW" && timeSinceLastLossChange >= 15000 && LK?.VideoQuality) {
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
              // Include 0fps readings so stall detection can see consecutive zero ticks
              dt.fpsHistory.push(fps);
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
              var shouldDowngrade = !isLocalhost && ((dt.fpsHistory.length >= 4 && avgFps < 30) || dropRatio > 0.4);
              var reason = dropRatio > 0.4 ? "decode (drop=" + Math.round(dropRatio * 100) + "%)"
                : "low avg fps (" + Math.round(avgFps) + "fps avg over " + dt.fpsHistory.length + " ticks)";

              // Cooldown: don't switch layers more often than this to prevent thrashing.
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
              dt._lastReport = { fps: fps, w: w, h: h, kbps: kbps, jitter: jitter, lost: pktLost, dropped: dropped, decoded: decoded, nack: nacks, pli: plis, codec: codec !== "?" ? codec : null, _deltaLost: deltaLost, ice_local_type: _iceLocalType, ice_remote_type: _iceRemoteType };
              debugLog(`Inbound ${sourceLabel} ${participant.identity}: ${fps}fps ${w}x${h} ${kbps}kbps codec=${codec} decoder=${decoder} jitter=${jitter}ms lost=${pktLost} dropped=${dropped}/${decoded} (${Math.round(dropRatio*100)}%/tick) nack=${nacks} pli=${plis} avgFps=${Math.round(avgFps)} layer=${dt.currentQuality}${layerInfo}${_iceType ? " " + _iceType : ""}`);
            }
          });
        }
      });
    } catch {}

    // ── POST per-receiver inbound stats to control plane ─────────────────
    // Runs on EVERY viewer (publisher or not) so we can compare what each
    // receiver sees from each publisher. Auth: LiveKit room JWT (any logged-in
    // viewer). Server merges into client_stats map keyed by JWT subject.
    // Critical for diagnosing per-receiver mysteries — added 2026-04-08.
    try {
      if (room && currentAccessToken) {
        var inboundArr2 = [];
        _inboundDropTracker.forEach(function(dt, key) {
          if (!dt._lastReport) return;
          var parts = key.split("-");
          var source = parts[parts.length - 1];
          var fromId = parts.slice(0, parts.length - 1).join("-");
          var avgF = dt.fpsHistory.length > 0
            ? dt.fpsHistory.reduce(function(a, b) { return a + b; }, 0) / dt.fpsHistory.length : 0;
          var presentation = source === "screen" ? getScreenPresentationStatsForIdentity(fromId) : null;
          var presentationAge = presentation?.updatedAt
            ? Math.max(0, Date.now() - presentation.updatedAt)
            : null;
          inboundArr2.push({
            from: fromId, source: source,
            fps: dt._lastReport.fps, width: dt._lastReport.w, height: dt._lastReport.h,
            bitrate_kbps: dt._lastReport.kbps, jitter_ms: dt._lastReport.jitter,
            lost: dt._lastReport.lost, dropped: dt._lastReport.dropped,
            decoded: dt._lastReport.decoded, nack: dt._lastReport.nack,
            pli: dt._lastReport.pli, avg_fps: Math.round(avgF),
            layer: dt.currentQuality, codec: dt._lastReport.codec || null,
            ice_local_type: dt._lastReport.ice_local_type || null,
            ice_remote_type: dt._lastReport.ice_remote_type || null,
            presented_fps: presentation ? presentation.fps : null,
            presented_width: presentation ? presentation.width : null,
            presented_height: presentation ? presentation.height : null,
            presented_frames: presentation ? presentation.presentedFrames : null,
            presentation_age_ms: presentationAge,
          });
        });

        // Capture health from Tauri client (null when running in browser viewer
        // or when no capture is active — both are fine, server schema is optional).
        var captureHealth = null;
        try {
          if (typeof tauriInvoke === "function") {
            captureHealth = await tauriInvoke("get_capture_health");
          }
        } catch (e) { /* IPC unavailable, e.g. browser viewer */ }
        var displayStatus = typeof getEchoDisplayStatusSnapshot === "function"
          ? getEchoDisplayStatusSnapshot()
          : null;
        var nativePresenter = typeof getNativePresenterStatusSnapshot === "function"
          ? getNativePresenterStatusSnapshot()
          : null;

        // Fire the POST whenever we have ANYTHING to report — either receive-side
        // inbound stats (other publishers exist) OR local capture health (we are
        // a Tauri publisher). Without this OR, a publisher alone in the room
        // would never report their own capture telemetry. Discovered live
        // 2026-04-08 during Phase 2 smoke test.
        if (inboundArr2.length > 0 || captureHealth || displayStatus || nativePresenter) {
          fetch(apiUrl("/api/client-stats-report"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + currentAccessToken,
            },
            body: JSON.stringify({
              identity: room?.localParticipant?.identity || "",
              name: room?.localParticipant?.name || "",
              room: currentRoomName || "",
              inbound: inboundArr2,
              capture_health: captureHealth,
              display_status: displayStatus,
              native_presenter: nativePresenter,
            }),
          }).catch(function() {});
        }
      }
    } catch (e) {}
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
