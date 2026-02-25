(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoPublishStateReconcile = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function reconcilePublishIndicators(current, actual) {
    const cur = current || {};
    const act = actual || {};

    const nextCamEnabled = !!act.cameraPublished;
    const nextScreenEnabled = !!act.screenPublished;

    const cameraDrift = !!cur.camEnabled !== nextCamEnabled;
    const screenDrift = !!cur.screenEnabled !== nextScreenEnabled;

    return {
      next: {
        camEnabled: nextCamEnabled,
        screenEnabled: nextScreenEnabled,
      },
      drift: {
        camera: cameraDrift,
        screen: screenDrift,
      },
      anyDrift: cameraDrift || screenDrift,
    };
  }

  return {
    reconcilePublishIndicators,
  };
});
