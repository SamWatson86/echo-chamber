/* =========================================================
   URLS — Server URL derivation and Tauri IPC helpers
   ========================================================= */

var _echoServerUrl = ""; // Server URL for API calls (set by Tauri get_control_url on native client)

function getControlUrl() {
  const val = controlUrlInput?.value?.trim();
  if (val) return val;
  return `https://${window.location.host}`;
}

// Tauri IPC — viewer loaded locally so window.__TAURI__ is available natively
function tauriInvoke(cmd, args) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  return Promise.reject(new Error("Tauri IPC not available"));
}
function tauriListen(eventName, callback) {
  if (window.__TAURI__ && window.__TAURI__.event) {
    return window.__TAURI__.event.listen(eventName, callback);
  }
  return Promise.reject(new Error("Tauri event system not available"));
}
function hasTauriIPC() {
  return !!(window.__TAURI__ && window.__TAURI__.core);
}
function isAdminMode() {
  return !!window.__ECHO_ADMIN__;
}

// Build absolute URL for API calls. Native client uses the configured server URL
// since the page is loaded locally (tauri://). Browser uses relative paths.
function apiUrl(path) {
  if (window.__ECHO_NATIVE__ && _echoServerUrl) {
    return _echoServerUrl + path;
  }
  return path;
}

function setDefaultUrls() {
  if (window.__ECHO_NATIVE__ && hasTauriIPC()) {
    // Native client: get server URL from Tauri config
    tauriInvoke("get_control_url").then(function(url) {
      _echoServerUrl = url;
      if (!controlUrlInput.value) controlUrlInput.value = url;
      if (!sfuUrlInput.value) {
        // SFU is proxied through the control plane — same host:port, just wss://
        sfuUrlInput.value = url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
      }
      debugLog("[native] server URL from Tauri config: " + url);
    }).catch(function(e) {
      debugLog("[native] get_control_url failed: " + e);
      // Fallback to defaults
      if (!controlUrlInput.value) controlUrlInput.value = "https://echo.fellowshipoftheboatrace.party:9443";
      if (!sfuUrlInput.value) sfuUrlInput.value = "wss://echo.fellowshipoftheboatrace.party:9443";
    });
  } else {
    if (!controlUrlInput.value) {
      controlUrlInput.value = window.location.protocol + "//" + window.location.host;
    }
    if (!sfuUrlInput.value) {
      if (window.location.protocol === "https:") {
        sfuUrlInput.value = "wss://" + window.location.host;
      } else {
        sfuUrlInput.value = "ws://" + window.location.hostname + ":7880";
      }
    }
  }
}

function normalizeUrls() {
  // For native client, URLs are set by setDefaultUrls via Tauri IPC
  if (window.__ECHO_NATIVE__) return;
  if (window.location.protocol !== "https:") return;
  if (!controlUrlInput.value) {
    controlUrlInput.value = "https://" + window.location.host;
  }
  if (!sfuUrlInput.value) {
    sfuUrlInput.value = "wss://" + window.location.host;
  }
}
