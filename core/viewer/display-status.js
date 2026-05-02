/* =========================================================
   DISPLAY STATUS - native Echo display-path badge and stats cache
   ========================================================= */

var _echoDisplayStatus = null;
var _echoDisplayStatusTimer = null;

function isEchoDisplayWarning(status) {
  if (!status || status.available === false) return false;
  return status.on_preferred_display === false || status.window_spans_displays === true;
}

function getEchoDisplayStatusSnapshot() {
  return _echoDisplayStatus || null;
}

function getPreferredEchoDisplayId() {
  return echoGet("echo-preferred-display-id") || "";
}

async function refreshEchoDisplayStatus() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return null;
  try {
    var preferredId = getPreferredEchoDisplayId();
    _echoDisplayStatus = await tauriInvoke("get_echo_display_status", {
      preferredDisplayId: preferredId || null,
    });
    renderEchoDisplayStatus(_echoDisplayStatus);
    return _echoDisplayStatus;
  } catch (e) {
    debugLog("[display] status failed: " + e);
    return null;
  }
}

async function moveEchoToPreferredDisplay() {
  if (!window.__ECHO_NATIVE__ || !hasTauriIPC()) return null;
  var preferredId = getPreferredEchoDisplayId();
  if (!preferredId) {
    showToast("No Echo display selected yet", 2500);
    return null;
  }
  try {
    _echoDisplayStatus = await tauriInvoke("move_echo_to_display", { displayId: preferredId });
    renderEchoDisplayStatus(_echoDisplayStatus);
    return _echoDisplayStatus;
  } catch (e) {
    showToast("Display move failed: " + e, 4000);
    debugLog("[display] move failed: " + e);
    return null;
  }
}

async function saveCurrentEchoDisplayAsPreferred() {
  var status = await refreshEchoDisplayStatus();
  if (!status || !status.current_display_id) {
    showToast("Could not detect current Echo display", 3000);
    return;
  }
  echoSet("echo-preferred-display-id", status.current_display_id);
  showToast("Echo display saved: " + (status.current_display_name || "current display"), 2500);
  await refreshEchoDisplayStatus();
}

function renderEchoDisplayStatus(status) {
  var el = document.getElementById("echo-display-status");
  if (!el) return;
  if (!status || status.available === false) {
    el.classList.add("hidden");
    return;
  }

  var warning = isEchoDisplayWarning(status);
  var name = status.current_display_name || "Display";
  var suffix = warning ? "Check display path" : "Full-tilt display";
  el.textContent = suffix + ": " + name;
  el.title = "Click to save this monitor as Echo's preferred full-performance display. Shift-click moves Echo to the saved display.";
  el.classList.remove("hidden");
  el.classList.toggle("display-warning", warning);
}

function startEchoDisplayStatusMonitor() {
  if (_echoDisplayStatusTimer) return;
  refreshEchoDisplayStatus();
  _echoDisplayStatusTimer = setInterval(refreshEchoDisplayStatus, 5000);
  var el = document.getElementById("echo-display-status");
  if (el && !el._echoDisplayClickBound) {
    el._echoDisplayClickBound = true;
    el.addEventListener("click", function(e) {
      if (e.shiftKey) moveEchoToPreferredDisplay();
      else saveCurrentEchoDisplayAsPreferred();
    });
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", startEchoDisplayStatusMonitor);
}

if (typeof module === "object" && module.exports) {
  module.exports = {
    isEchoDisplayWarning,
  };
}
