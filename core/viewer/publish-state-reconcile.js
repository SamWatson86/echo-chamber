(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoPublishStateReconcile = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function isMicrophoneActuallyEnabled(participant, publications, microphoneSource, audioKind) {
    if (!participant || !participant.isMicrophoneEnabled) return false;
    const pubs = Array.isArray(publications) ? publications : [];
    return pubs.some((publication) => {
      if (!publication) return false;
      const track = publication.track;
      const source = publication.source || (track && track.source);
      const kind = publication.kind || (track && track.kind);
      return source === microphoneSource &&
        kind === audioKind &&
        !publication.isMuted &&
        !!track &&
        !track.isMuted &&
        (!track.mediaStreamTrack || track.mediaStreamTrack.readyState !== "ended");
    });
  }

  function reconcilePublishIndicators(current, actual) {
    const cur = current || {};
    const act = actual || {};
    const tracksMicrophone = Object.prototype.hasOwnProperty.call(cur, "micEnabled") ||
      Object.prototype.hasOwnProperty.call(act, "microphonePublished");

    const nextMicEnabled = !!act.microphonePublished;
    const nextCamEnabled = !!act.cameraPublished;
    const nextScreenEnabled = !!act.screenPublished;

    const microphoneDrift = tracksMicrophone && !!cur.micEnabled !== nextMicEnabled;
    const cameraDrift = !!cur.camEnabled !== nextCamEnabled;
    const screenDrift = !!cur.screenEnabled !== nextScreenEnabled;

    const next = {
      camEnabled: nextCamEnabled,
      screenEnabled: nextScreenEnabled,
    };
    const drift = {
      camera: cameraDrift,
      screen: screenDrift,
    };
    // Preserve the helper's old camera/screen-only shape for reliability
    // scenarios that intentionally do not model microphone state.
    if (tracksMicrophone) {
      next.micEnabled = nextMicEnabled;
      drift.microphone = microphoneDrift;
    }

    return {
      next,
      drift,
      anyDrift: microphoneDrift || cameraDrift || screenDrift,
    };
  }

  return {
    isMicrophoneActuallyEnabled,
    reconcilePublishIndicators,
  };
});
