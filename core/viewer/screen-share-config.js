/* =========================================================
   SCREEN SHARE — Publish options builder
   ========================================================= */

function getScreenSharePublishOptions(srcW, srcH) {
  // Performance Mode: single layer, reduced settings — saves GPU on weak hardware
  if (performanceMode) {
    debugLog("[simulcast] performance mode — single layer screen share");
    return {
      videoCodec: "h264",
      simulcast: false,
      screenShareEncoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
      degradationPreference: "balanced",
    };
  }

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
    videoCodec: "h264",
    simulcast: true,
    screenShareEncoding: { maxBitrate: 15_000_000, maxFramerate: 60 },
    screenShareSimulcastLayers: [
      { width: medW, height: medH, encoding: { maxBitrate: 5_000_000, maxFramerate: 60 } },
      { width: lowW, height: lowH, encoding: { maxBitrate: 1_500_000, maxFramerate: 30 } },
    ],
    degradationPreference: "maintain-framerate",
  };
}
