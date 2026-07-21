(function () {
  "use strict";

  var PAGE_SIZE = 50;
  var PAGE_FETCH_SIZE = PAGE_SIZE + 1;
  var TOKEN_MAX_LENGTH = 8192;
  var DOWNLOAD_MAX_BYTES = 384 * 1024;
  var INCIDENT_ID_PATTERN = /^inc_[0-9a-f]{32}$/;
  var SAFE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
  var SEVERITIES = ["debug", "info", "warning", "error", "fatal"];
  var EVENT_TYPES = new Set([
    "session_start", "session_end", "unclean_shutdown", "javascript_error",
    "unhandled_rejection", "console_warning", "console_error", "permission",
    "media", "connection", "reconnect", "tauri_ipc_error", "native_error",
  ]);
  var OPERATING_SYSTEMS = new Set([
    "macos", "windows", "linux", "ios", "android", "unknown",
  ]);
  var ARCHITECTURES = new Set(["aarch64", "x86_64", "x86", "arm", "unknown"]);
  var CLIENT_KINDS = new Set(["browser", "desktop"]);

  var elements = {
    loginView: document.getElementById("login-view"),
    dashboardView: document.getElementById("dashboard-view"),
    loginForm: document.getElementById("login-form"),
    ownerSecret: document.getElementById("owner-secret"),
    loginButton: document.getElementById("login-button"),
    loginStatus: document.getElementById("login-status"),
    refreshButton: document.getElementById("refresh-button"),
    logoutButton: document.getElementById("logout-button"),
    searchFilter: document.getElementById("search-filter"),
    osFilter: document.getElementById("os-filter"),
    severityFilter: document.getElementById("severity-filter"),
    eventFilter: document.getElementById("event-filter"),
    clearFiltersButton: document.getElementById("clear-filters-button"),
    resultsSummary: document.getElementById("results-summary"),
    dashboardStatus: document.getElementById("dashboard-status"),
    incidentRows: document.getElementById("incident-rows"),
    emptyState: document.getElementById("empty-state"),
    emptyStateTitle: document.getElementById("empty-state-title"),
    emptyStateCopy: document.getElementById("empty-state-copy"),
    previousButton: document.getElementById("previous-button"),
    nextButton: document.getElementById("next-button"),
    pageLabel: document.getElementById("page-label"),
    detailPanel: document.getElementById("detail-panel"),
    detailTitle: document.getElementById("detail-title"),
    detailContent: document.getElementById("detail-content"),
    detailStatus: document.getElementById("detail-status"),
    closeDetailButton: document.getElementById("close-detail-button"),
    downloadButton: document.getElementById("download-button"),
    deleteButton: document.getElementById("delete-button"),
  };

  var state = {
    token: null,
    generation: 0,
    expiryTimer: null,
    controllers: new Set(),
    objectUrls: new Set(),
    currentPage: null,
    previousPages: [],
    selectedIncidentId: null,
    detailReturnFocus: null,
    rowActions: new Map(),
    pageSequence: 0,
    detailSequence: 0,
  };

  function text(value, maximum) {
    if (typeof value !== "string") return "";
    var limit = maximum || 256;
    return value.length <= limit ? value : value.slice(0, limit);
  }

  function integer(value, maximum) {
    if (!Number.isSafeInteger(value) || value < 0) return 0;
    return Math.min(value, maximum || Number.MAX_SAFE_INTEGER);
  }

  function safeIncidentId(value) {
    return typeof value === "string" && INCIDENT_ID_PATTERN.test(value) ? value : null;
  }

  function safeToken(value, fallback) {
    return typeof value === "string" && SAFE_TOKEN_PATTERN.test(value) ? value : fallback;
  }

  function safeEnum(value, allowed, fallback) {
    return typeof value === "string" && allowed.has(value) ? value : fallback;
  }

  function makeElement(tag, className, value) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  function setStatus(node, message, tone) {
    node.textContent = message || "";
    if (tone) node.dataset.tone = tone;
    else node.removeAttribute("data-tone");
  }

  function setButtonBusy(button, busy) {
    button.disabled = Boolean(busy);
    button.setAttribute("aria-busy", busy ? "true" : "false");
  }

  function setDetailActionsEnabled(enabled) {
    setButtonBusy(elements.downloadButton, false);
    setButtonBusy(elements.deleteButton, false);
    elements.downloadButton.disabled = !enabled;
    elements.deleteButton.disabled = !enabled;
  }

  function resetPageControlBusy() {
    setButtonBusy(elements.refreshButton, false);
    setButtonBusy(elements.previousButton, false);
    setButtonBusy(elements.nextButton, false);
  }

  function formatTimestamp(milliseconds) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return "Unknown";
    try {
      return new Date(milliseconds).toLocaleString([], {
        year: "numeric", month: "short", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch (_) {
      return "Unknown";
    }
  }

  function prettyToken(value) {
    return text(value, 128).replace(/_/g, " ");
  }

  function retryMessage(response) {
    var raw = response && response.headers ? response.headers.get("Retry-After") : null;
    var seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "Too many attempts. Try again later.";
    }
    seconds = Math.min(900, Math.max(1, Math.ceil(seconds)));
    if (seconds >= 60) {
      return "Too many attempts. Try again in " + Math.ceil(seconds / 60) + " minutes.";
    }
    return "Too many attempts. Try again in " + seconds + " seconds.";
  }

  function failureMessage(response, context) {
    var status = response ? response.status : 0;
    if (status === 429) return retryMessage(response);
    if (status === 404) {
      if (context === "login" || context === "list") {
        return "Private diagnostics are not enabled on this server.";
      }
      return "The incident no longer exists or private diagnostics are unavailable.";
    }
    if (status === 400 || status === 422) return "The diagnostics request was rejected.";
    if (status === 413) return "The sign-in request is too large.";
    if (status >= 500 || status === 0) return "Diagnostics are temporarily unavailable. Try again.";
    if (status === 401 || status === 403) return "Session expired. Sign in again.";
    return "Diagnostics are temporarily unavailable. Try again.";
  }

  function abortRequests() {
    state.controllers.forEach(function (controller) { controller.abort(); });
    state.controllers.clear();
  }

  function revokeObjectUrls() {
    state.objectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.objectUrls.clear();
  }

  function clearExpiryTimer() {
    if (state.expiryTimer !== null) window.clearTimeout(state.expiryTimer);
    state.expiryTimer = null;
  }

  function clearPrivateView() {
    state.currentPage = null;
    state.previousPages = [];
    state.selectedIncidentId = null;
    state.detailReturnFocus = null;
    state.rowActions.clear();
    state.pageSequence += 1;
    state.detailSequence += 1;
    elements.incidentRows.replaceChildren();
    elements.detailContent.replaceChildren();
    elements.detailPanel.hidden = true;
    elements.detailTitle.textContent = "Selected incident";
    elements.searchFilter.value = "";
    elements.osFilter.value = "";
    elements.severityFilter.value = "";
    elements.eventFilter.value = "";
    elements.resultsSummary.textContent = "No page loaded.";
    elements.pageLabel.textContent = "Page 1";
    resetPageControlBusy();
    elements.previousButton.disabled = true;
    elements.nextButton.disabled = true;
    setDetailActionsEnabled(false);
    setStatus(elements.dashboardStatus, "");
    setStatus(elements.detailStatus, "");
  }

  function endSession(message, shouldFocus) {
    state.generation += 1;
    state.token = null;
    abortRequests();
    clearExpiryTimer();
    revokeObjectUrls();
    clearPrivateView();
    elements.dashboardView.hidden = true;
    elements.loginView.hidden = false;
    elements.ownerSecret.value = "";
    setButtonBusy(elements.loginButton, false);
    setStatus(elements.loginStatus, message || "", message ? "warning" : "");
    if (shouldFocus !== false) elements.ownerSecret.focus();
  }

  function beginRequest() {
    var controller = new AbortController();
    state.controllers.add(controller);
    return controller;
  }

  function finishRequest(controller) {
    state.controllers.delete(controller);
  }

  function protectedOptions(method, controller, body) {
    var headers = { Authorization: "Bearer " + state.token };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    var options = {
      method: method || "GET",
      headers: headers,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    return options;
  }

  function validOwnerToken(value) {
    return typeof value === "string" && value.length > 0 && value.length <= TOKEN_MAX_LENGTH &&
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  }

  function severityRank(value) {
    var rank = SEVERITIES.indexOf(value);
    return rank < 0 ? 0 : rank;
  }

  function sanitizeSummary(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var incidentId = safeIncidentId(raw.incident_id);
    if (!incidentId) return null;
    var eventTypes = Array.isArray(raw.event_types)
      ? raw.event_types.filter(function (value) { return EVENT_TYPES.has(value); }).slice(0, 16)
      : [];
    return {
      incidentId: incidentId,
      envelopeId: text(raw.envelope_id, 64),
      identity: text(raw.authenticated_identity, 256),
      receivedAt: integer(raw.received_at_ms),
      capturedAt: integer(raw.captured_at_ms),
      sessionId: text(raw.session_id, 64),
      appVersion: text(raw.app_version, 64),
      channel: text(raw.channel, 64),
      clientKind: safeEnum(raw.client_kind, CLIENT_KINDS, "browser"),
      operatingSystem: safeEnum(raw.operating_system, OPERATING_SYSTEMS, "unknown"),
      architecture: safeEnum(raw.architecture, ARCHITECTURES, "unknown"),
      eventCount: integer(raw.event_count, 1000),
      highestSeverity: SEVERITIES.includes(raw.highest_severity) ? raw.highest_severity : "debug",
      eventTypes: eventTypes,
    };
  }

  function sanitizeDetailValue(value, depth) {
    if (depth > 3) return "[truncated]";
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : "[invalid number]";
    if (typeof value === "string") return text(value, 512);
    if (Array.isArray(value)) {
      return value.slice(0, 20).map(function (item) { return sanitizeDetailValue(item, depth + 1); });
    }
    if (value && typeof value === "object") {
      var result = Object.create(null);
      Object.keys(value).slice(0, 50).forEach(function (key) {
        var safeKey = text(key, 64);
        var normalizedKey = safeKey.toLowerCase();
        if (!safeKey || normalizedKey.includes("message") || normalizedKey.includes("fingerprint") ||
            normalizedKey.includes("digest")) return;
        result[safeKey] = sanitizeDetailValue(value[key], depth + 1);
      });
      return result;
    }
    return "[unsupported]";
  }

  function sanitizeDetail(raw, requestedIncidentId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var incidentId = safeIncidentId(raw.incident_id);
    if (!incidentId || incidentId !== requestedIncidentId) return null;
    var envelope = raw.envelope;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    var app = envelope.app && typeof envelope.app === "object" ? envelope.app : {};
    var platform = envelope.platform && typeof envelope.platform === "object" ? envelope.platform : {};
    var runtimes = app.runtimes && typeof app.runtimes === "object" ? app.runtimes : {};
    var events = Array.isArray(envelope.events) ? envelope.events.slice(0, 50) : [];
    var sanitizedEvents = events.map(function (event) {
      if (!event || typeof event !== "object" || Array.isArray(event)) return null;
      var eventType = safeEnum(event.event_type, EVENT_TYPES, null);
      var severity = SEVERITIES.includes(event.severity) ? event.severity : "debug";
      if (!eventType) return null;
      return {
        sequence: integer(event.sequence, 1000000),
        timestamp: integer(event.timestamp_ms),
        eventType: eventType,
        severity: severity,
        code: safeToken(event.code, "unknown"),
        details: sanitizeDetailValue(
          event.details && typeof event.details === "object" ? event.details : {},
          0,
        ),
      };
    }).filter(Boolean);
    return {
      incidentId: incidentId,
      receivedAt: integer(raw.received_at_ms),
      identity: text(raw.authenticated_identity, 256),
      envelopeId: text(envelope.envelope_id, 64),
      installId: text(envelope.install_id, 64),
      sessionId: text(envelope.session_id, 64),
      capturedAt: integer(envelope.captured_at_ms),
      sentAt: integer(envelope.sent_at_ms),
      app: {
        version: text(app.version, 64),
        gitSha: text(app.git_sha, 16),
        channel: text(app.channel, 64),
        browserName: text(runtimes.browser_name, 64),
        browserVersion: text(runtimes.browser_version, 64),
        webviewVersion: text(runtimes.webview_version, 64),
        livekitVersion: text(runtimes.livekit_version, 64),
        tauriVersion: text(runtimes.tauri_version, 64),
      },
      platform: {
        clientKind: safeEnum(platform.client_kind, CLIENT_KINDS, "browser"),
        operatingSystem: safeEnum(platform.operating_system, OPERATING_SYSTEMS, "unknown"),
        architecture: safeEnum(platform.architecture, ARCHITECTURES, "unknown"),
        osVersion: text(platform.os_version, 64),
        osBuild: text(platform.os_build, 64),
      },
      events: sanitizedEvents,
    };
  }

  function appendTextLine(parent, primary, secondary, primaryClass) {
    var primaryNode = makeElement("span", primaryClass || "primary-cell", primary);
    parent.appendChild(primaryNode);
    if (secondary) parent.appendChild(makeElement("span", "cell-meta", secondary));
  }

  function filterMatches(item) {
    var query = elements.searchFilter.value.toLowerCase();
    if (query) {
      var haystack = [item.identity, item.incidentId].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (elements.osFilter.value && item.operatingSystem !== elements.osFilter.value) return false;
    if (elements.severityFilter.value &&
        severityRank(item.highestSeverity) < severityRank(elements.severityFilter.value)) return false;
    if (elements.eventFilter.value && !item.eventTypes.includes(elements.eventFilter.value)) return false;
    return true;
  }

  function renderIncidentRow(item) {
    var row = document.createElement("tr");

    var receivedCell = document.createElement("td");
    appendTextLine(receivedCell, formatTimestamp(item.receivedAt), "Captured " + formatTimestamp(item.capturedAt));
    row.appendChild(receivedCell);

    var identityCell = document.createElement("td");
    appendTextLine(identityCell, item.identity || "Unknown participant", item.incidentId);
    identityCell.lastChild.classList.add("monospace");
    row.appendChild(identityCell);

    var platformCell = document.createElement("td");
    appendTextLine(
      platformCell,
      prettyToken(item.operatingSystem) + " · " + prettyToken(item.architecture),
      (item.appVersion || "Unknown build") + " · " + (item.channel || "unknown channel"),
    );
    row.appendChild(platformCell);

    var severityCell = document.createElement("td");
    severityCell.appendChild(makeElement(
      "span",
      "severity severity-" + item.highestSeverity,
      item.highestSeverity,
    ));
    row.appendChild(severityCell);

    var eventsCell = document.createElement("td");
    var tags = makeElement("div", "event-tags");
    item.eventTypes.forEach(function (eventType) {
      tags.appendChild(makeElement("span", "event-tag", prettyToken(eventType)));
    });
    if (!item.eventTypes.length) tags.appendChild(makeElement("span", "event-tag", "No event type"));
    eventsCell.appendChild(tags);
    eventsCell.appendChild(makeElement(
      "span",
      "cell-meta",
      item.eventCount + (item.eventCount === 1 ? " event" : " events"),
    ));
    row.appendChild(eventsCell);

    var actionCell = makeElement("td", "row-action");
    var viewButton = makeElement("button", "button button-quiet", "View details");
    viewButton.type = "button";
    viewButton.setAttribute("aria-label", "View details for incident " + item.incidentId.slice(-8));
    viewButton.addEventListener("click", function () { void loadDetail(item.incidentId, viewButton); });
    state.rowActions.set(item.incidentId, viewButton);
    actionCell.appendChild(viewButton);
    row.appendChild(actionCell);
    return row;
  }

  function renderCurrentPage() {
    var page = state.currentPage;
    state.rowActions.clear();
    if (!page) {
      elements.incidentRows.replaceChildren();
      elements.emptyState.hidden = false;
      elements.nextButton.disabled = true;
      elements.previousButton.disabled = true;
      return;
    }
    var filtered = page.items.filter(filterMatches);
    elements.incidentRows.replaceChildren.apply(
      elements.incidentRows,
      filtered.map(renderIncidentRow),
    );
    elements.emptyState.hidden = filtered.length !== 0;
    elements.emptyStateTitle.textContent = page.items.length ? "No matching incidents" : "No incidents found";
    elements.emptyStateCopy.textContent = page.items.length
      ? "Nothing on this loaded page matches the current filters."
      : "The server returned no incidents for this page.";
    elements.resultsSummary.textContent = "Showing " + filtered.length + " of " + page.items.length +
      " incidents on this loaded page. Filters do not query other pages.";
    elements.pageLabel.textContent = "Page " + page.number;
    elements.previousButton.disabled = state.previousPages.length === 0;
    elements.nextButton.disabled = !page.hasNext;
  }

  function addDetailCard(grid, label, value, monospace) {
    var card = makeElement("div", "detail-card");
    card.appendChild(makeElement("span", "detail-label", label));
    card.appendChild(makeElement(
      "span",
      "detail-value" + (monospace ? " monospace" : ""),
      value || "Unknown",
    ));
    grid.appendChild(card);
  }

  function runtimeSummary(app) {
    var values = [];
    if (app.browserName) values.push(app.browserName + (app.browserVersion ? " " + app.browserVersion : ""));
    if (app.webviewVersion) values.push("WebView " + app.webviewVersion);
    if (app.livekitVersion) values.push("LiveKit " + app.livekitVersion);
    if (app.tauriVersion) values.push("Tauri " + app.tauriVersion);
    return values.join(" · ") || "Unknown";
  }

  function renderDetail(detail) {
    var fragment = document.createDocumentFragment();
    var grid = makeElement("div", "detail-grid");
    addDetailCard(grid, "Participant", detail.identity);
    addDetailCard(grid, "Received", formatTimestamp(detail.receivedAt));
    addDetailCard(grid, "Captured", formatTimestamp(detail.capturedAt));
    addDetailCard(grid, "Sent", formatTimestamp(detail.sentAt));
    addDetailCard(
      grid,
      "Build",
      [detail.app.version, detail.app.gitSha, detail.app.channel].filter(Boolean).join(" · "),
      true,
    );
    addDetailCard(
      grid,
      "Platform",
      [detail.platform.clientKind, detail.platform.operatingSystem, detail.platform.architecture]
        .map(prettyToken).join(" · "),
    );
    addDetailCard(
      grid,
      "OS version",
      [detail.platform.osVersion, detail.platform.osBuild].filter(Boolean).join(" · "),
    );
    addDetailCard(grid, "Runtime", runtimeSummary(detail.app));
    addDetailCard(grid, "Incident ID", detail.incidentId, true);
    addDetailCard(grid, "Envelope ID", detail.envelopeId, true);
    addDetailCard(grid, "Install ID", detail.installId, true);
    addDetailCard(grid, "Session ID", detail.sessionId, true);
    fragment.appendChild(grid);

    fragment.appendChild(makeElement("h4", "timeline-heading", "Event timeline"));
    var timeline = makeElement("ol", "timeline");
    detail.events.forEach(function (event) {
      var eventNode = makeElement("li", "timeline-event");
      eventNode.dataset.severity = event.severity;
      var heading = makeElement("div", "event-heading");
      heading.appendChild(makeElement(
        "span",
        "event-title",
        "#" + event.sequence + " · " + prettyToken(event.eventType) + " · " + event.code,
      ));
      heading.appendChild(makeElement("time", "event-time", formatTimestamp(event.timestamp)));
      eventNode.appendChild(heading);
      eventNode.appendChild(makeElement(
        "pre",
        "event-details",
        JSON.stringify(event.details, null, 2),
      ));
      timeline.appendChild(eventNode);
    });
    if (!detail.events.length) {
      timeline.appendChild(makeElement("li", "timeline-event", "No valid events were returned."));
    }
    fragment.appendChild(timeline);
    elements.detailContent.replaceChildren(fragment);
    elements.detailTitle.textContent = "Incident " + detail.incidentId.slice(-8);
    elements.detailPanel.hidden = false;
    setStatus(elements.detailStatus, "");
    elements.detailPanel.scrollIntoView({ behavior: "auto", block: "start" });
  }

  function handleProtectedFailure(response, context, statusNode) {
    var message = failureMessage(response, context);
    if (response.status === 401 || response.status === 403 ||
        (response.status === 404 && context === "list")) {
      endSession(message);
      return;
    }
    setStatus(statusNode, message, response.status === 429 ? "warning" : "error");
  }

  async function fetchPage(cursor, pageNumber, pageSequence) {
    if (!state.token) return null;
    var requestGeneration = state.generation;
    var controller = beginRequest();
    var parameters = new URLSearchParams({ limit: String(PAGE_FETCH_SIZE) });
    if (cursor) {
      parameters.set("before_received_at_ms", String(cursor.receivedAt));
      parameters.set("before_incident_id", cursor.incidentId);
    }
    try {
      var response = await fetch(
        "/admin/api/diagnostics?" + parameters.toString(),
        protectedOptions("GET", controller),
      );
      if (requestGeneration !== state.generation || pageSequence !== state.pageSequence) return null;
      if (!response.ok) {
        handleProtectedFailure(response, "list", elements.dashboardStatus);
        return null;
      }
      var payload = await response.json();
      if (requestGeneration !== state.generation || pageSequence !== state.pageSequence) return null;
      if (!payload || !Array.isArray(payload.incidents)) {
        setStatus(elements.dashboardStatus, "The diagnostics response could not be verified.", "error");
        return null;
      }
      var allItems = payload.incidents.slice(0, PAGE_FETCH_SIZE)
        .map(sanitizeSummary).filter(Boolean);
      var items = allItems.slice(0, PAGE_SIZE);
      var lastDisplayed = items[items.length - 1];
      return {
        cursor: cursor,
        number: pageNumber,
        items: items,
        hasNext: allItems.length > PAGE_SIZE && Boolean(lastDisplayed),
        nextCursor: allItems.length > PAGE_SIZE && lastDisplayed ? {
          receivedAt: lastDisplayed.receivedAt,
          incidentId: lastDisplayed.incidentId,
        } : null,
      };
    } catch (error) {
      if (requestGeneration === state.generation && pageSequence === state.pageSequence &&
          error && error.name !== "AbortError") {
        setStatus(elements.dashboardStatus, failureMessage(null, "list"), "error");
      }
      return null;
    } finally {
      finishRequest(controller);
    }
  }

  function closeDetail(restoreFocus) {
    var incidentId = state.selectedIncidentId;
    var returnFocus = state.detailReturnFocus;
    state.detailSequence += 1;
    state.selectedIncidentId = null;
    state.detailReturnFocus = null;
    elements.detailContent.replaceChildren();
    elements.detailTitle.textContent = "Selected incident";
    elements.detailPanel.hidden = true;
    setDetailActionsEnabled(false);
    setStatus(elements.detailStatus, "");
    if (restoreFocus) {
      var focusTarget = returnFocus && returnFocus.isConnected
        ? returnFocus
        : state.rowActions.get(incidentId);
      if (focusTarget && focusTarget.isConnected && !focusTarget.disabled) focusTarget.focus();
      else elements.searchFilter.focus();
    }
  }

  async function replaceCurrentPage(cursor, pageNumber) {
    var pageSequence = state.pageSequence + 1;
    state.pageSequence = pageSequence;
    setButtonBusy(elements.refreshButton, true);
    setStatus(elements.dashboardStatus, "Loading incidents...");
    var page = await fetchPage(cursor, pageNumber, pageSequence);
    if (pageSequence !== state.pageSequence) return false;
    resetPageControlBusy();
    if (!page) {
      renderCurrentPage();
      return false;
    }
    state.currentPage = page;
    closeDetail();
    setStatus(elements.dashboardStatus, "Page refreshed.", "success");
    renderCurrentPage();
    return true;
  }

  async function loadNextPage() {
    if (!state.currentPage || !state.currentPage.nextCursor) return;
    var pageSequence = state.pageSequence + 1;
    state.pageSequence = pageSequence;
    var prior = state.currentPage;
    setButtonBusy(elements.nextButton, true);
    setStatus(elements.dashboardStatus, "Loading older incidents...");
    var nextPage = await fetchPage(prior.nextCursor, prior.number + 1, pageSequence);
    if (pageSequence !== state.pageSequence) return;
    resetPageControlBusy();
    if (!nextPage) {
      renderCurrentPage();
      return;
    }
    state.previousPages.push(prior);
    state.currentPage = nextPage;
    closeDetail();
    setStatus(elements.dashboardStatus, "");
    renderCurrentPage();
  }

  function showPreviousPage() {
    state.pageSequence += 1;
    resetPageControlBusy();
    var prior = state.previousPages.pop();
    if (!prior) {
      renderCurrentPage();
      return;
    }
    state.currentPage = prior;
    closeDetail();
    setStatus(elements.dashboardStatus, "");
    renderCurrentPage();
  }

  async function refreshCurrentPage() {
    var cursor = state.currentPage ? state.currentPage.cursor : null;
    var number = state.currentPage ? state.currentPage.number : 1;
    return replaceCurrentPage(cursor, number);
  }

  async function loadDetail(incidentId, returnFocus) {
    if (!state.token || !safeIncidentId(incidentId)) return;
    var detailSequence = state.detailSequence + 1;
    state.detailSequence = detailSequence;
    state.selectedIncidentId = incidentId;
    state.detailReturnFocus = returnFocus && typeof returnFocus.focus === "function"
      ? returnFocus
      : null;
    var requestGeneration = state.generation;
    var controller = beginRequest();
    elements.detailPanel.hidden = false;
    elements.detailContent.replaceChildren();
    elements.detailTitle.textContent = "Loading incident";
    setDetailActionsEnabled(false);
    setStatus(elements.detailStatus, "Loading redacted detail...");
    try {
      var response = await fetch(
        "/admin/api/diagnostics/" + encodeURIComponent(incidentId),
        protectedOptions("GET", controller),
      );
      if (requestGeneration !== state.generation || detailSequence !== state.detailSequence) return;
      if (!response.ok) {
        handleProtectedFailure(response, "detail", elements.detailStatus);
        return;
      }
      var payload = await response.json();
      if (requestGeneration !== state.generation || detailSequence !== state.detailSequence) return;
      var detail = sanitizeDetail(payload, incidentId);
      if (!detail) {
        setStatus(elements.detailStatus, "The incident response could not be verified.", "error");
        return;
      }
      renderDetail(detail);
      setDetailActionsEnabled(true);
      elements.detailTitle.focus({ preventScroll: true });
    } catch (error) {
      if (requestGeneration === state.generation && detailSequence === state.detailSequence &&
          error && error.name !== "AbortError") {
        setStatus(elements.detailStatus, failureMessage(null, "detail"), "error");
      }
    } finally {
      finishRequest(controller);
    }
  }

  async function signIn(secret) {
    state.generation += 1;
    abortRequests();
    clearExpiryTimer();
    revokeObjectUrls();
    clearPrivateView();
    state.token = null;
    var requestGeneration = state.generation;
    var controller = beginRequest();
    var requestBody = JSON.stringify({ secret: secret });
    secret = "";
    setButtonBusy(elements.loginButton, true);
    setStatus(elements.loginStatus, "Signing in...");
    elements.ownerSecret.value = "";
    try {
      var response = await fetch("/v1/auth/diagnostics/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      requestBody = "";
      if (requestGeneration !== state.generation) return;
      if (!response.ok) {
        setStatus(
          elements.loginStatus,
          response.status === 401 ? "Sign-in failed." : failureMessage(response, "login"),
          response.status === 429 ? "warning" : "error",
        );
        return;
      }
      var payload = await response.json();
      if (requestGeneration !== state.generation) return;
      var expiresIn = payload && payload.expires_in_seconds;
      if (!payload || payload.ok !== true || !validOwnerToken(payload.token) ||
          !Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > 3600) {
        setStatus(elements.loginStatus, "The sign-in response could not be verified.", "error");
        return;
      }
      state.token = payload.token;
      state.expiryTimer = window.setTimeout(function () {
        if (requestGeneration === state.generation) endSession("Session expired. Sign in again.");
      }, expiresIn * 1000);
      elements.loginView.hidden = true;
      elements.dashboardView.hidden = false;
      setStatus(elements.loginStatus, "");
      var loaded = await replaceCurrentPage(null, 1);
      if (!loaded && state.token) renderCurrentPage();
    } catch (error) {
      if (requestGeneration === state.generation && error && error.name !== "AbortError") {
        setStatus(elements.loginStatus, failureMessage(null, "login"), "error");
      }
    } finally {
      requestBody = "";
      finishRequest(controller);
      if (requestGeneration === state.generation) setButtonBusy(elements.loginButton, false);
    }
  }

  async function readBoundedResponseText(response) {
    var declaredLength = response.headers.get("Content-Length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > DOWNLOAD_MAX_BYTES) {
      if (response.body && typeof response.body.cancel === "function") {
        try { await response.body.cancel(); } catch (_) {}
      }
      throw new Error("Download exceeds the browser safety limit");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("A bounded download stream is unavailable");
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder("utf-8", { fatal: true });
    var totalBytes = 0;
    var textBody = "";
    var streamClosed = false;
    try {
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) {
          streamClosed = true;
          break;
        }
        totalBytes += chunk.value.byteLength;
        if (totalBytes > DOWNLOAD_MAX_BYTES) {
          try { await reader.cancel(); } catch (_) {}
          streamClosed = true;
          throw new Error("Download exceeds the browser safety limit");
        }
        textBody += decoder.decode(chunk.value, { stream: true });
      }
      textBody += decoder.decode();
      return textBody;
    } finally {
      if (!streamClosed) {
        try { await reader.cancel(); } catch (_) {}
      }
      reader.releaseLock();
    }
  }

  async function downloadSelected() {
    var incidentId = safeIncidentId(state.selectedIncidentId);
    if (!state.token || !incidentId) return;
    var requestGeneration = state.generation;
    var controller = beginRequest();
    setButtonBusy(elements.downloadButton, true);
    setStatus(elements.detailStatus, "Preparing redacted download...");
    try {
      var response = await fetch(
        "/admin/api/diagnostics/" + encodeURIComponent(incidentId) + "/download",
        protectedOptions("GET", controller),
      );
      if (requestGeneration !== state.generation || state.selectedIncidentId !== incidentId) {
        if (response.body && typeof response.body.cancel === "function") {
          try { await response.body.cancel(); } catch (_) {}
        }
        return;
      }
      if (!response.ok) {
        handleProtectedFailure(response, "download", elements.detailStatus);
        return;
      }
      var body = await readBoundedResponseText(response);
      if (requestGeneration !== state.generation || state.selectedIncidentId !== incidentId) return;
      var blob = new Blob([body], { type: "application/json;charset=utf-8" });
      if (blob.size > DOWNLOAD_MAX_BYTES) {
        setStatus(elements.detailStatus, "The redacted download is larger than the safe browser limit.", "error");
        return;
      }
      var parsed;
      try { parsed = JSON.parse(body); }
      catch (_) { parsed = null; }
      if (!parsed || parsed.incident_id !== incidentId) {
        setStatus(elements.detailStatus, "The redacted download could not be verified.", "error");
        return;
      }
      var objectUrl = URL.createObjectURL(blob);
      state.objectUrls.add(objectUrl);
      var anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = "echo-diagnostic-" + incidentId + ".json";
      anchor.rel = "noopener";
      anchor.className = "visually-hidden";
      anchor.textContent = "Download redacted incident";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(function () {
        if (state.objectUrls.delete(objectUrl)) URL.revokeObjectURL(objectUrl);
      }, 0);
      setStatus(elements.detailStatus, "Redacted download prepared.", "success");
    } catch (error) {
      if (requestGeneration === state.generation && state.selectedIncidentId === incidentId &&
          error && error.name !== "AbortError") {
        setStatus(elements.detailStatus, failureMessage(null, "download"), "error");
      }
    } finally {
      finishRequest(controller);
      if (requestGeneration === state.generation && state.selectedIncidentId === incidentId) {
        setButtonBusy(elements.downloadButton, false);
      }
    }
  }

  async function deleteSelected() {
    var incidentId = safeIncidentId(state.selectedIncidentId);
    if (!state.token || !incidentId) return;
    if (!window.confirm("Delete this diagnostic incident permanently? This cannot be undone.")) return;
    var requestGeneration = state.generation;
    var controller = beginRequest();
    setButtonBusy(elements.deleteButton, true);
    setStatus(elements.detailStatus, "Deleting incident...");
    try {
      var response = await fetch(
        "/admin/api/diagnostics/" + encodeURIComponent(incidentId),
        protectedOptions("DELETE", controller),
      );
      if (requestGeneration !== state.generation || state.selectedIncidentId !== incidentId) return;
      if (response.status !== 204) {
        handleProtectedFailure(response, "delete", elements.detailStatus);
        return;
      }
      if (state.currentPage) {
        state.currentPage.items = state.currentPage.items.filter(function (item) {
          return item.incidentId !== incidentId;
        });
      }
      closeDetail();
      renderCurrentPage();
      elements.resultsSummary.focus({ preventScroll: true });
      setStatus(elements.dashboardStatus, "Incident deleted.", "success");
      var refreshed = await refreshCurrentPage();
      if (refreshed) setStatus(elements.dashboardStatus, "Incident deleted.", "success");
    } catch (error) {
      if (requestGeneration === state.generation && state.selectedIncidentId === incidentId &&
          error && error.name !== "AbortError") {
        setStatus(elements.detailStatus, failureMessage(null, "delete"), "error");
      }
    } finally {
      finishRequest(controller);
      if (requestGeneration === state.generation && state.selectedIncidentId === incidentId) {
        setButtonBusy(elements.deleteButton, false);
      }
    }
  }

  elements.loginForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var secret = elements.ownerSecret.value;
    if (secret.length) void signIn(secret);
  });
  elements.logoutButton.addEventListener("click", function () { endSession("Signed out."); });
  elements.refreshButton.addEventListener("click", function () { void refreshCurrentPage(); });
  elements.nextButton.addEventListener("click", function () { void loadNextPage(); });
  elements.previousButton.addEventListener("click", showPreviousPage);
  elements.closeDetailButton.addEventListener("click", function () { closeDetail(true); });
  elements.downloadButton.addEventListener("click", function () { void downloadSelected(); });
  elements.deleteButton.addEventListener("click", function () { void deleteSelected(); });
  elements.clearFiltersButton.addEventListener("click", function () {
    elements.searchFilter.value = "";
    elements.osFilter.value = "";
    elements.severityFilter.value = "";
    elements.eventFilter.value = "";
    renderCurrentPage();
  });
  elements.searchFilter.addEventListener("input", renderCurrentPage);
  elements.osFilter.addEventListener("change", renderCurrentPage);
  elements.severityFilter.addEventListener("change", renderCurrentPage);
  elements.eventFilter.addEventListener("change", renderCurrentPage);
  window.addEventListener("pagehide", function () { endSession("", false); });

  endSession("");
})();
