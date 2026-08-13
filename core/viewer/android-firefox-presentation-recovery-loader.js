(function(root) {
  "use strict";

  var RECOVERY_SCRIPT = "android-firefox-presentation-recovery.js?v=0.6.34.1786572903";
  var TARGET_USER_AGENT = /Android[^)]*Mobile/i;
  var TARGET_FIREFOX = /Firefox\/\d/i;
  var FLAG_PARAM = "echoAndroidFirefoxPresentationRecovery";
  var FLAG_STORAGE_KEY = "echo-android-firefox-presentation-recovery";
  var moduleRequested = false;

  function isExactTarget(environment) {
    var env = environment || {};
    if (env.isNativeShell === true) return false;
    var userAgent = String(env.userAgent || "");
    return TARGET_USER_AGENT.test(userAgent) && TARGET_FIREFOX.test(userAgent) &&
      !/FxiOS\/\d/i.test(userAgent);
  }

  function readFlag(environment) {
    var env = environment || {};
    var search = String(env.search || "");
    try {
      var invite = new URLSearchParams(search).get(FLAG_PARAM);
      if (invite === "0") return false;
      if (invite === "1") return true;
    } catch (_error) {}
    try {
      var storage = env.storage || (typeof env.getStorage === "function" ? env.getStorage() : null);
      var stored = storage && storage.getItem(FLAG_STORAGE_KEY);
      if (stored === "0") return false;
      if (stored === "1") return true;
    } catch (_error) {}
    // Exact Android Firefox phones are the production cohort. The explicit
    // override remains available for an immediate server-only kill switch.
    return true;
  }

  function shouldLoad(environment) {
    return isExactTarget(environment) && readFlag(environment);
  }

  function load(environment) {
    var env = environment || {};
    if (!shouldLoad(env) || !env.document || !env.document.createElement) return false;
    if (moduleRequested) return false;
    try {
      if (env.document.querySelector &&
          env.document.querySelector('script[data-echo-android-firefox-presentation-recovery="1"]')) {
        moduleRequested = true;
        return false;
      }
    } catch (_error) {}
    var script = env.document.createElement("script");
    script.src = RECOVERY_SCRIPT;
    script.async = false;
    script.dataset.echoAndroidFirefoxPresentationRecovery = "1";
    moduleRequested = true;
    (env.document.head || env.document.documentElement).appendChild(script);
    return true;
  }

  function safelyGetStorage(rootObject) {
    try { return rootObject.localStorage; } catch (_error) { return null; }
  }

  var api = {
    FLAG_PARAM: FLAG_PARAM,
    FLAG_STORAGE_KEY: FLAG_STORAGE_KEY,
    RECOVERY_SCRIPT: RECOVERY_SCRIPT,
    isExactTarget: isExactTarget,
    load: load,
    readFlag: readFlag,
    shouldLoad: shouldLoad,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.EchoAndroidFirefoxPresentationRecoveryLoader = api;

  if (root.document && root.navigator) {
    load({
      document: root.document,
      getStorage: function() { return safelyGetStorage(root); },
      isNativeShell: root.__ECHO_NATIVE__ === true,
      search: root.location && root.location.search,
      userAgent: root.navigator.userAgent,
    });
  }
})(typeof window === "object" ? window : globalThis);
