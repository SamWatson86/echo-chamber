(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EchoWebDiagnostics = api;
  if (root && root.document) {
    Promise.resolve().then(function () {
      try { api.installBrowserRuntime(root); } catch (_) {}
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CONSENT_KEY = "echo-web-diagnostics-consent-v1";
  var INSTALL_KEY = "echo-web-diagnostics-install-v1";
  var QUEUE_KEY = "echo-web-diagnostics-queue-v1";
  var STATUS_KEY = "echo-web-diagnostics-status-v1";
  var ACTIVE_KEY = "echo-web-diagnostics-active-v1";
  var CONSENT_ENABLED = "enabled-v1";
  var CONSENT_DISABLED = "disabled-v1";
  var QUEUE_VERSION = 1;
  var MAX_ENVELOPES = 10;
  var MAX_ENVELOPE_BYTES = 64 * 1024;
  var MAX_QUEUE_BYTES = 512 * 1024;
  var MAX_EVENTS_PER_ENVELOPE = 50;
  var QUEUE_TTL_MS = 72 * 60 * 60 * 1000;
  var SESSION_STALE_MS = 5 * 60 * 1000;
  var SEAL_INTERVAL_MS = 15 * 1000;
  var HEARTBEAT_AUTH_MAX_MS = 18 * 1000;

  var EVENT_PREFIXES = {
    session_start: ["session."],
    session_end: ["session."],
    unclean_shutdown: ["session."],
    javascript_error: ["javascript.", "promise."],
    unhandled_rejection: ["javascript.", "promise."],
    permission: ["permission.", "microphone.", "camera.", "screen_share."],
    media: ["media.", "microphone.", "camera.", "screen_share."],
    connection: ["connection.", "ice.", "livekit.", "sfu.", "webrtc."],
    reconnect: ["reconnect.", "connection."],
  };
  var SEVERITIES = new Set(["debug", "info", "warning", "error", "fatal"]);
  var DETAIL_KEYS = new Set([
    "action", "actual", "attempt", "audio", "browser", "camera", "clean", "column",
    "connection_state", "count", "current", "denied", "device_count", "device_kind",
    "direction", "duration_ms", "enabled", "ended", "error_code", "expected",
    "failure_stage", "granted", "kind", "line", "media_kind", "microphone", "operation",
    "output", "permission", "permission_state", "phase", "previous", "published",
    "reconnect_count", "requested", "result", "room_state", "screen", "selected", "stage",
    "started", "state", "status", "subscribed", "target", "track_state", "transport",
    "unclean", "video", "visibility",
  ]);
  var CHANNELS = new Set(["web", "web-canary", "web-smoke", "test"]);
  var OS_VALUES = new Set(["macos", "windows", "linux", "ios", "android", "unknown"]);
  var ARCH_VALUES = new Set(["aarch64", "x86_64", "x86", "arm", "unknown"]);
  var SAFE_STATES = new Set([
    "connecting", "connected", "reconnecting", "disconnected", "failed", "error", "enabled",
    "disabled", "started", "stopped", "granted", "denied", "available", "unavailable",
    "browser", "microphone", "camera", "screen", "output", "unknown",
  ]);
  var SAFE_ACTIONS = new Set(["enable", "disable", "start", "stop", "observe", "connect"]);
  var MEDIA_KINDS = new Set(["microphone", "camera", "screen"]);
  var CONNECTION_STATES = new Set(["connecting", "connected", "reconnecting", "disconnected", "failed", "error"]);
  var ERROR_NAMES = new Map([
    ["NotAllowedError", "permission_denied"],
    ["PermissionDeniedError", "permission_denied"],
    ["NotFoundError", "device_not_found"],
    ["DevicesNotFoundError", "device_not_found"],
    ["NotReadableError", "device_unavailable"],
    ["TrackStartError", "device_unavailable"],
    ["AbortError", "aborted"],
    ["TypeError", "type_error"],
    ["RangeError", "range_error"],
    ["ReferenceError", "reference_error"],
    ["SyntaxError", "syntax_error"],
    ["MicrophonePublishError", "publish_failed"],
  ]);
  var LEGACY_EVENTS = {
    "room-join": ["connection", "connection.joined", "info"],
    "room-disconnect": ["connection", "connection.disconnected", "warning"],
    "signal-reconnecting": ["reconnect", "reconnect.started", "warning"],
    "reconnecting": ["reconnect", "reconnect.started", "warning"],
    "signal-reconnected": ["reconnect", "reconnect.completed", "info"],
    "reconnected": ["reconnect", "reconnect.completed", "info"],
    "loss-drop": ["media", "media.receiver_quality_degraded", "warning"],
    "layer-downgrade": ["media", "media.receiver_quality_degraded", "warning"],
    "loss-snapback": ["media", "media.receiver_quality_recovered", "info"],
    "layer-upgrade": ["media", "media.receiver_quality_recovered", "info"],
    "screen-share-start": ["media", "screen_share.started", "info"],
    "screen-share-stop": ["media", "screen_share.stopped", "info"],
    "camera-reduced": ["media", "camera.quality_reduced", "warning"],
    "camera-restored": ["media", "camera.quality_restored", "info"],
    "bitrate-cap-applied": ["media", "media.bandwidth_limited", "warning"],
    "bwe-watchdog-kick": ["media", "media.bandwidth_recovery", "warning"],
    "bwe-rescue": ["media", "media.bandwidth_recovery", "warning"],
    "bwe-rescue-hard": ["media", "media.bandwidth_recovery", "warning"],
  };

  function byteLength(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  function canonicalUuid(value) {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  }

  function secureUuid(cryptoObject) {
    if (!cryptoObject) return null;
    if (typeof cryptoObject.randomUUID === "function") {
      var generated = String(cryptoObject.randomUUID()).toLowerCase();
      return canonicalUuid(generated) ? generated : null;
    }
    if (typeof cryptoObject.getRandomValues !== "function") return null;
    var bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (item) { return item.toString(16).padStart(2, "0"); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function safeInteger(value, maximum) {
    var number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(maximum || 0x7fffffff, Math.round(number)));
  }

  function safeErrorCode(errorName) {
    return typeof errorName === "string" ? (ERROR_NAMES.get(errorName) || "unknown") : "unknown";
  }

  function safeToken(value, allowed) {
    value = String(value || "").toLowerCase();
    if (allowed && !allowed.has(value)) return "unknown";
    return /^[a-z][a-z0-9_-]{0,47}$/.test(value) ? value : "unknown";
  }

  function sanitizeDetails(details) {
    var output = {};
    if (!details || typeof details !== "object" || Array.isArray(details)) return output;
    Object.keys(details).slice(0, 32).forEach(function (key) {
      if (!DETAIL_KEYS.has(key)) return;
      var value = details[key];
      if (typeof value === "boolean") output[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) output[key] = Math.max(-1e9, Math.min(1e9, value));
      else if (typeof value === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(value)) output[key] = value;
    });
    return output;
  }

  function sanitizeEvent(event) {
    if (!event || !EVENT_PREFIXES[event.event_type] || !SEVERITIES.has(event.severity)) return null;
    var code = String(event.code || "");
    if (code.length > 96 || !/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)+$/.test(code)) return null;
    if (!EVENT_PREFIXES[event.event_type].some(function (prefix) { return code.indexOf(prefix) === 0; })) return null;
    return {
      timestamp_ms: safeInteger(event.timestamp_ms, Number.MAX_SAFE_INTEGER),
      event_type: event.event_type,
      severity: event.severity,
      code: code,
      details: sanitizeDetails(event.details),
    };
  }

  function safeMetadata(input) {
    if (!input || !input.app || !input.platform) return null;
    var version = String(input.app.version || "");
    var sha = String(input.app.git_sha || "").toLowerCase();
    var channel = String(input.app.channel || "");
    if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(version)) return null;
    if (!/^[0-9a-f]{7,12}$/.test(sha) || !CHANNELS.has(channel)) return null;
    var runtimes = {};
    var sourceRuntimes = input.app.runtimes || {};
    if (["Browser", "Edge", "Chrome", "Firefox", "Safari"].indexOf(sourceRuntimes.browser_name) >= 0) {
      runtimes.browser_name = sourceRuntimes.browser_name;
    }
    if (typeof sourceRuntimes.browser_version === "string" &&
        (/^[0-9]+(?:\.[0-9]+){0,5}$/.test(sourceRuntimes.browser_version) || sourceRuntimes.browser_version === "unknown")) {
      runtimes.browser_version = sourceRuntimes.browser_version;
    }
    if (typeof sourceRuntimes.livekit_version === "string" &&
        /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(sourceRuntimes.livekit_version)) {
      runtimes.livekit_version = sourceRuntimes.livekit_version;
    }
    var operatingSystem = OS_VALUES.has(input.platform.operating_system) ? input.platform.operating_system : "unknown";
    var architecture = ARCH_VALUES.has(input.platform.architecture) ? input.platform.architecture : "unknown";
    return {
      app: { version: version, git_sha: sha, channel: channel, runtimes: runtimes },
      platform: { client_kind: "browser", operating_system: operatingSystem, architecture: architecture },
    };
  }

  function hasExactKeys(value, expected) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    var actual = Object.keys(value).sort();
    var wanted = expected.slice().sort();
    return actual.length === wanted.length && actual.every(function (key, index) { return key === wanted[index]; });
  }

  function validateSealedBody(body, expectedInstallId) {
    if (typeof body !== "string" || !body || byteLength(body) > MAX_ENVELOPE_BYTES) return false;
    try {
      var envelope = JSON.parse(body);
      if (JSON.stringify(envelope) !== body) return false;
      if (!hasExactKeys(envelope, [
        "schema_version", "envelope_id", "install_id", "session_id", "captured_at_ms",
        "sent_at_ms", "app", "platform", "events",
      ])) return false;
      if (envelope.schema_version !== 1 || !canonicalUuid(envelope.envelope_id) ||
          !canonicalUuid(envelope.install_id) || !canonicalUuid(envelope.session_id)) return false;
      if (expectedInstallId && envelope.install_id !== expectedInstallId) return false;
      if (!Number.isSafeInteger(envelope.captured_at_ms) || envelope.captured_at_ms <= 0 ||
          !Number.isSafeInteger(envelope.sent_at_ms) || envelope.sent_at_ms < envelope.captured_at_ms) return false;
      if (!hasExactKeys(envelope.app, ["version", "git_sha", "channel", "runtimes"]) ||
          !hasExactKeys(envelope.platform, ["client_kind", "operating_system", "architecture"]) ||
          !hasExactKeys(envelope.app.runtimes, Object.keys(envelope.app.runtimes))) return false;
      var runtimeKeys = Object.keys(envelope.app.runtimes);
      if (runtimeKeys.some(function (key) {
        return ["browser_name", "browser_version", "livekit_version"].indexOf(key) < 0;
      })) return false;
      var normalizedMetadata = safeMetadata({ app: envelope.app, platform: envelope.platform });
      if (!normalizedMetadata || JSON.stringify(normalizedMetadata.app) !== JSON.stringify(envelope.app) ||
          JSON.stringify(normalizedMetadata.platform) !== JSON.stringify(envelope.platform)) return false;
      if (!Array.isArray(envelope.events) || envelope.events.length < 1 ||
          envelope.events.length > MAX_EVENTS_PER_ENVELOPE) return false;
      var priorTimestamp = envelope.captured_at_ms;
      for (var index = 0; index < envelope.events.length; index += 1) {
        var event = envelope.events[index];
        if (!hasExactKeys(event, ["sequence", "timestamp_ms", "event_type", "severity", "code", "details"]) ||
            event.sequence !== index + 1 || !Number.isSafeInteger(event.timestamp_ms) ||
            event.timestamp_ms < priorTimestamp || event.timestamp_ms > envelope.sent_at_ms) return false;
        var normalizedEvent = sanitizeEvent(event);
        if (!normalizedEvent || normalizedEvent.timestamp_ms !== event.timestamp_ms ||
            normalizedEvent.event_type !== event.event_type || normalizedEvent.severity !== event.severity ||
            normalizedEvent.code !== event.code ||
            JSON.stringify(normalizedEvent.details) !== JSON.stringify(event.details)) return false;
        priorTimestamp = event.timestamp_ms;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function emptyQueue() {
    return { version: QUEUE_VERSION, revision: 0, writer: "", draft: null, envelopes: [] };
  }

  function parseQueue(raw, now) {
    if (!raw) return emptyQueue();
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.envelopes)) return emptyQueue();
      var output = emptyQueue();
      output.revision = safeInteger(parsed.revision, Number.MAX_SAFE_INTEGER);
      if (parsed.draft && canonicalUuid(parsed.draft.session_id) && Array.isArray(parsed.draft.events)) {
        var draftEvents = parsed.draft.events.map(sanitizeEvent).filter(Boolean).slice(-MAX_EVENTS_PER_ENVELOPE);
        var draftCapturedAt = safeInteger(parsed.draft.captured_at_ms, Number.MAX_SAFE_INTEGER);
        if (draftEvents.length && draftCapturedAt && draftCapturedAt + QUEUE_TTL_MS >= now &&
            draftCapturedAt <= now + 5 * 60 * 1000) {
          output.draft = {
            session_id: parsed.draft.session_id,
            captured_at_ms: draftCapturedAt,
            scope: typeof parsed.draft.scope === "string" && /^[0-9a-f]{64}$/.test(parsed.draft.scope)
              ? parsed.draft.scope : null,
            events: draftEvents,
          };
        }
      }
      parsed.envelopes.forEach(function (item) {
        if (!item || !validateSealedBody(item.body)) return;
        var createdAt = safeInteger(item.created_at_ms, Number.MAX_SAFE_INTEGER);
        if (!createdAt || createdAt + QUEUE_TTL_MS < now || createdAt > now + 5 * 60 * 1000) return;
        output.envelopes.push({
          body: item.body,
          created_at_ms: createdAt,
          scope: typeof item.scope === "string" && /^[0-9a-f]{64}$/.test(item.scope) ? item.scope : null,
          attempts: safeInteger(item.attempts, 20),
          next_attempt_ms: safeInteger(item.next_attempt_ms, Number.MAX_SAFE_INTEGER),
        });
      });
      output.envelopes = output.envelopes.slice(-MAX_ENVELOPES);
      return enforceQueueBounds(output);
    } catch (_) {
      return emptyQueue();
    }
  }

  function queueBytes(queue) {
    return byteLength(JSON.stringify(queue));
  }

  function enforceQueueBounds(queue) {
    while (queue.envelopes.length > MAX_ENVELOPES || queueBytes(queue) > MAX_QUEUE_BYTES) queue.envelopes.shift();
    while (queue.draft && queue.draft.events.length > 1 && queueBytes(queue) > MAX_QUEUE_BYTES) {
      queue.draft.events.shift();
      queue.draft.captured_at_ms = queue.draft.events[0].timestamp_ms;
    }
    if (queue.draft && queueBytes(queue) > MAX_QUEUE_BYTES) queue.draft = null;
    return queue;
  }

  function decodeJwtSubject(token) {
    try {
      if (typeof token !== "string" || token.length < 3 || token.length > 16 * 1024) return null;
      var parts = token.split(".");
      if (parts.length !== 3) return null;
      var encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (encoded.length % 4) encoded += "=";
      var json;
      if (typeof atob === "function") json = decodeURIComponent(Array.from(atob(encoded), function (char) {
        return "%" + char.charCodeAt(0).toString(16).padStart(2, "0");
      }).join(""));
      else if (typeof Buffer !== "undefined") json = Buffer.from(encoded, "base64").toString("utf8");
      else return null;
      var payload = JSON.parse(json);
      return typeof payload.sub === "string" && payload.sub.length > 0 && payload.sub.length <= 256
        ? payload.sub : null;
    } catch (_) {
      return null;
    }
  }

  async function defaultScopeDigest(token, installId, origin, cryptoObject) {
    var subject = decodeJwtSubject(token);
    if (!subject || !cryptoObject || !cryptoObject.subtle || typeof TextEncoder !== "function") return null;
    var bytes = new TextEncoder().encode(installId + "\0" + origin + "\0" + subject);
    var digest = await cryptoObject.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), function (item) { return item.toString(16).padStart(2, "0"); }).join("");
  }

  function createCollector(options) {
    options = options || {};
    var storage = options.storage;
    var cryptoObject = options.crypto;
    var fetchImpl = options.fetch;
    var now = options.now || Date.now;
    var setTimer = options.setTimeout || setTimeout;
    var clearTimer = options.clearTimeout || clearTimeout;
    var setRepeating = options.setInterval || setInterval;
    var clearRepeating = options.clearInterval || clearInterval;
    var metadataProvider = options.metadataProvider;
    var scopeDigest = options.scopeDigest || function (token, installId, origin) {
      return defaultScopeDigest(token, installId, origin, cryptoObject);
    };
    var eventTarget = options.eventTarget || null;
    var writerId = secureUuid(cryptoObject);
    var sessionId = null;
    var installId = null;
    var enabled = false;
    var started = false;
    var metadata = null;
    var metadataPromise = null;
    var auth = null;
    var uploadAbort = null;
    var uploading = false;
    var uploadSequence = 0;
    var pageDisabled = false;
    var sealTimer = null;
    var sessionTimer = null;
    var retryTimer = null;
    var reconnecting = false;
    var lastEventCode = "";
    var lastEventAt = 0;
    var handlers = null;
    var lifecycleVersion = 0;
    var enablePromise = null;
    var heartbeatVersion = 0;
    var credentialSeen = false;

    function cancelUpload() {
      uploadSequence += 1;
      var controller = uploadAbort;
      uploadAbort = null;
      uploading = false;
      if (controller) controller.abort();
    }

    function haltRuntime(statusCode) {
      lifecycleVersion += 1;
      heartbeatVersion += 1;
      enabled = false;
      started = false;
      auth = null;
      cancelUpload();
      detachHandlers();
      if (sealTimer) clearRepeating(sealTimer);
      if (sessionTimer) clearRepeating(sessionTimer);
      if (retryTimer) clearTimer(retryTimer);
      sealTimer = sessionTimer = retryTimer = null;
      if (statusCode) setStatus(statusCode);
    }

    function setStatus(code, at) {
      var payload = JSON.stringify({ version: 1, code: safeToken(code), at_ms: safeInteger(at || now(), Number.MAX_SAFE_INTEGER) });
      try {
        if (storage.getItem(CONSENT_KEY) !== CONSENT_ENABLED) return false;
        storage.setItem(STATUS_KEY, payload);
        return true;
      } catch (_) {
        return false;
      }
    }

    function consentState() {
      try {
        var value = storage.getItem(CONSENT_KEY);
        if (value === CONSENT_ENABLED) return "enabled";
        if (value === CONSENT_DISABLED) return "disabled";
        return "unset";
      } catch (_) {
        return "disabled";
      }
    }

    function requirePersistedConsent() {
      try {
        if (storage.getItem(CONSENT_KEY) === CONSENT_ENABLED) return true;
      } catch (_) {}
      disable(false);
      return false;
    }

    function loadQueue() {
      try { return parseQueue(storage.getItem(QUEUE_KEY), now()); }
      catch (_) { haltRuntime("storage_unavailable"); return emptyQueue(); }
    }

    function saveQueue(queue) {
      if (!enabled) return false;
      if (!requirePersistedConsent()) return false;
      try {
        queue.revision = safeInteger(queue.revision + 1, Number.MAX_SAFE_INTEGER);
        queue.writer = writerId || "";
        enforceQueueBounds(queue);
        storage.setItem(QUEUE_KEY, JSON.stringify(queue));
        return true;
      } catch (_) {
        haltRuntime("storage_unavailable");
        return false;
      }
    }

    function ensureInstallId() {
      try {
        var existing = storage.getItem(INSTALL_KEY);
        if (canonicalUuid(existing)) return existing;
        var generated = secureUuid(cryptoObject);
        if (!generated) return null;
        storage.setItem(INSTALL_KEY, generated);
        return generated;
      } catch (_) {
        return null;
      }
    }

    function recordInternal(eventType, code, severity, details, immediate) {
      if (!enabled || !started || !sessionId) return false;
      var timestamp = safeInteger(now(), Number.MAX_SAFE_INTEGER);
      if (code === lastEventCode && timestamp - lastEventAt < 1500) return false;
      var event = sanitizeEvent({
        timestamp_ms: timestamp,
        event_type: eventType,
        severity: severity,
        code: code,
        details: details,
      });
      if (!event || !event.timestamp_ms) return false;
      var queue = loadQueue();
      if (!enabled) return false;
      if (queue.draft && queue.draft.session_id !== sessionId && !sealQueueDraft(queue)) {
        queue.draft = null;
        setStatus("invalid_dropped");
      }
      if (!queue.draft) {
        queue.draft = {
          session_id: sessionId,
          captured_at_ms: event.timestamp_ms,
          scope: auth ? auth.scope : null,
          events: [],
        };
      }
      var prior = queue.draft.events[queue.draft.events.length - 1];
      if (prior && event.timestamp_ms < prior.timestamp_ms) event.timestamp_ms = prior.timestamp_ms;
      queue.draft.events.push(event);
      if (queue.draft.events.length >= MAX_EVENTS_PER_ENVELOPE && metadata) sealQueueDraft(queue);
      saveQueue(queue);
      lastEventCode = code;
      lastEventAt = timestamp;
      if (immediate && metadata) {
        var updated = loadQueue();
        sealQueueDraft(updated);
        saveQueue(updated);
        void uploadAvailable();
      }
      return true;
    }

    function sealQueueDraft(queue) {
      if (!metadata || !installId || !queue.draft || !queue.draft.events.length) return false;
      var envelopeId = secureUuid(cryptoObject);
      if (!envelopeId) return false;
      var draftEvents = queue.draft.events.slice();
      var body = "";
      var sentAt = 0;
      do {
        var events = draftEvents.map(function (event, index) {
          return {
            sequence: index + 1,
            timestamp_ms: event.timestamp_ms,
            event_type: event.event_type,
            severity: event.severity,
            code: event.code,
            details: event.details,
          };
        });
        var capturedAt = draftEvents.length === queue.draft.events.length
          ? Math.min(queue.draft.captured_at_ms, events[0].timestamp_ms)
          : events[0].timestamp_ms;
        sentAt = Math.max(safeInteger(now(), Number.MAX_SAFE_INTEGER), events[events.length - 1].timestamp_ms, capturedAt);
        body = JSON.stringify({
          schema_version: 1,
          envelope_id: envelopeId,
          install_id: installId,
          session_id: queue.draft.session_id,
          captured_at_ms: capturedAt,
          sent_at_ms: sentAt,
          app: metadata.app,
          platform: metadata.platform,
          events: events,
        });
        if (byteLength(body) > MAX_ENVELOPE_BYTES && draftEvents.length > 1) draftEvents.shift();
        else break;
      } while (draftEvents.length);
      if (byteLength(body) > MAX_ENVELOPE_BYTES) return false;
      queue.envelopes.push({
        body: body,
        created_at_ms: sentAt,
        scope: queue.draft.scope || (queue.draft.session_id === sessionId && auth ? auth.scope : null),
        attempts: 0,
        next_attempt_ms: 0,
      });
      queue.draft = null;
      enforceQueueBounds(queue);
      return true;
    }

    function sealDraft() {
      if (!enabled || !metadata) return false;
      var queue = loadQueue();
      var sealed = sealQueueDraft(queue);
      if (sealed) saveQueue(queue);
      return sealed;
    }

    function attachHandlers() {
      if (!eventTarget || handlers) return;
      handlers = {
        error: function (event) {
          var name = "unknown";
          var line = 0;
          var column = 0;
          try { name = event && event.error ? event.error.name : "unknown"; } catch (_) {}
          try { line = safeInteger(event && event.lineno, 1000000); } catch (_) {}
          try { column = safeInteger(event && event.colno, 1000000); } catch (_) {}
          recordInternal("javascript_error", "javascript.window_error", "error", {
            error_code: safeErrorCode(name),
            line: line,
            column: column,
          }, true);
        },
        rejection: function () {
          recordInternal("unhandled_rejection", "promise.unhandled_rejection", "error", { error_code: "unknown" }, true);
        },
        pagehide: function (event) {
          if (event && event.persisted) {
            removeActiveSession();
            return;
          }
          recordInternal("session_end", "session.end", "info", { clean: true }, false);
          sealDraft();
          removeActiveSession();
        },
        pageshow: function (event) {
          if (event && event.persisted) refreshActiveSession(false);
        },
      };
      eventTarget.addEventListener("error", handlers.error);
      eventTarget.addEventListener("unhandledrejection", handlers.rejection);
      eventTarget.addEventListener("pagehide", handlers.pagehide);
      eventTarget.addEventListener("pageshow", handlers.pageshow);
    }

    function detachHandlers() {
      if (!eventTarget || !handlers) return;
      eventTarget.removeEventListener("error", handlers.error);
      eventTarget.removeEventListener("unhandledrejection", handlers.rejection);
      eventTarget.removeEventListener("pagehide", handlers.pagehide);
      eventTarget.removeEventListener("pageshow", handlers.pageshow);
      handlers = null;
    }

    function readActiveSessions() {
      try {
        var parsed = JSON.parse(storage.getItem(ACTIVE_KEY) || "{}");
        if (!parsed || parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
          return { version: 1, sessions: {} };
        }
        var sessions = {};
        Object.keys(parsed.sessions).slice(-32).forEach(function (id) {
          var item = parsed.sessions[id];
          if (!canonicalUuid(id) || !item || !Number.isFinite(item.started_at_ms) ||
              !Number.isFinite(item.last_seen_ms)) return;
          sessions[id] = {
            started_at_ms: safeInteger(item.started_at_ms, Number.MAX_SAFE_INTEGER),
            last_seen_ms: safeInteger(item.last_seen_ms, Number.MAX_SAFE_INTEGER),
            scope: typeof item.scope === "string" && /^[0-9a-f]{64}$/.test(item.scope) ? item.scope : null,
          };
        });
        return { version: 1, sessions: sessions };
      } catch (_) { return { version: 1, sessions: {} }; }
    }

    function writeActiveSessions(registry) {
      if (!enabled || !requirePersistedConsent()) return false;
      try {
        storage.setItem(ACTIVE_KEY, JSON.stringify(registry));
        return true;
      } catch (_) {
        return false;
      }
    }

    function refreshActiveSession(reportStale) {
      if (!enabled || !sessionId) return;
      var currentTime = safeInteger(now(), Number.MAX_SAFE_INTEGER);
      var registry = readActiveSessions();
      Object.keys(registry.sessions).forEach(function (id) {
        var item = registry.sessions[id];
        if (id !== sessionId && item.last_seen_ms + SESSION_STALE_MS < currentTime) {
          if (item.last_seen_ms + QUEUE_TTL_MS < currentTime) {
            delete registry.sessions[id];
          } else if (reportStale && auth && item.scope === auth.scope) {
            recordInternal("unclean_shutdown", "session.unclean_shutdown", "error", {
              unclean: true,
              duration_ms: safeInteger(item.last_seen_ms - item.started_at_ms, QUEUE_TTL_MS),
            }, false);
            delete registry.sessions[id];
          } else if (reportStale && auth && item.scope === null) {
            delete registry.sessions[id];
          }
        }
      });
      var existing = registry.sessions[sessionId];
      registry.sessions[sessionId] = {
        started_at_ms: existing ? existing.started_at_ms : currentTime,
        last_seen_ms: currentTime,
        scope: auth ? auth.scope : (existing ? existing.scope : null),
      };
      Object.keys(registry.sessions)
        .filter(function (id) { return id !== sessionId; })
        .sort(function (left, right) {
          return registry.sessions[left].last_seen_ms - registry.sessions[right].last_seen_ms;
        })
        .slice(0, Math.max(0, Object.keys(registry.sessions).length - 32))
        .forEach(function (id) { delete registry.sessions[id]; });
      writeActiveSessions(registry);
    }

    function removeActiveSession() {
      if (!sessionId) return;
      var registry = readActiveSessions();
      delete registry.sessions[sessionId];
      if (Object.keys(registry.sessions).length) writeActiveSessions(registry);
      else {
        try { storage.removeItem(ACTIVE_KEY); } catch (_) {}
      }
    }

    function scheduleRetry(delay) {
      if (!enabled || !requirePersistedConsent()) return false;
      if (retryTimer) clearTimer(retryTimer);
      retryTimer = setTimer(function () { retryTimer = null; void uploadAvailable(); }, Math.max(1000, delay));
      return true;
    }

    function removeEnvelope(body) {
      var queue = loadQueue();
      queue.envelopes = queue.envelopes.filter(function (item) { return item.body !== body; });
      return saveQueue(queue);
    }

    function updateEnvelope(body, update) {
      var queue = loadQueue();
      var item = queue.envelopes.find(function (entry) { return entry.body === body; });
      if (!item) return false;
      update(item);
      return saveQueue(queue);
    }

    async function uploadAvailable(force) {
      if (!enabled || !auth || uploading || pageDisabled || !fetchImpl) return false;
      if (!requirePersistedConsent()) return false;
      if (auth.proved_at_ms + HEARTBEAT_AUTH_MAX_MS < now()) {
        auth = null;
        return false;
      }
      sealDraft();
      var queue = loadQueue();
      var candidate = queue.envelopes.find(function (item) {
        return item.scope === auth.scope && (force || item.next_attempt_ms <= now());
      });
      if (!candidate) return false;
      if (!validateSealedBody(candidate.body, installId)) {
        if (!removeEnvelope(candidate.body)) return false;
        if (!setStatus("invalid_dropped")) {
          disable(false);
          return false;
        }
        return false;
      }
      uploading = true;
      var uploadOperation = uploadSequence + 1;
      uploadSequence = uploadOperation;
      var uploadHeartbeat = heartbeatVersion;
      var uploadAuth = auth;
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      uploadAbort = controller;
      var timeout = controller ? setTimer(function () { controller.abort(); }, 10000) : null;
      try {
        if (!requirePersistedConsent()) return false;
        var response = await fetchImpl(uploadAuth.origin + "/api/diagnostics/v1/envelopes", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + uploadAuth.token },
          body: candidate.body,
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        });
        if (uploadOperation !== uploadSequence || !enabled || !requirePersistedConsent()) return false;
        if (response.status === 200 || response.status === 202) {
          if (!removeEnvelope(candidate.body)) return false;
          if (!setStatus(response.status === 200 ? "duplicate" : "accepted")) {
            disable(false);
            return false;
          }
        } else if (response.status === 401 || response.status === 403) {
          if (uploadHeartbeat === heartbeatVersion) {
            auth = null;
            if (!setStatus("auth_wait")) {
              disable(false);
              return false;
            }
          }
        } else if (response.status === 404) {
          pageDisabled = true;
          if (!setStatus("server_disabled")) {
            disable(false);
            return false;
          }
        } else if ([400, 409, 413, 422].indexOf(response.status) >= 0) {
          if (!removeEnvelope(candidate.body)) return false;
          if (!setStatus(response.status === 409 ? "conflict_dropped" : "invalid_dropped")) {
            disable(false);
            return false;
          }
        } else {
          var retryAfter = response.status === 429 && response.headers && response.headers.get
            ? parseRetryAfter(response.headers.get("Retry-After"), now()) : 0;
          var delay = retryAfter || Math.min(300000, 5000 * Math.pow(2, Math.min(candidate.attempts, 6)));
          if (!updateEnvelope(candidate.body, function (item) {
            item.attempts += 1;
            item.next_attempt_ms = now() + delay;
          })) return false;
          if (!setStatus(response.status === 429 ? "rate_limited" : "retry_wait")) {
            disable(false);
            return false;
          }
          if (!scheduleRetry(delay)) return false;
        }
      } catch (_) {
        if (uploadOperation !== uploadSequence || !enabled || !auth) return false;
        if (!requirePersistedConsent()) return false;
        var networkDelay = Math.min(300000, 5000 * Math.pow(2, Math.min(candidate.attempts, 6)));
        if (!updateEnvelope(candidate.body, function (item) {
          item.attempts += 1;
          item.next_attempt_ms = now() + networkDelay;
        })) return false;
        if (!setStatus("network_wait")) {
          disable(false);
          return false;
        }
        if (!scheduleRetry(networkDelay)) return false;
      } finally {
        if (timeout) clearTimer(timeout);
        if (uploadOperation === uploadSequence) {
          uploadAbort = null;
          uploading = false;
        }
      }
      if (uploadOperation === uploadSequence && enabled && auth && !pageDisabled) {
        var remaining = loadQueue().envelopes.some(function (item) {
          return item.scope === auth.scope && item.next_attempt_ms <= now();
        });
        if (remaining) scheduleRetry(1000);
      }
      return true;
    }

    function parseRetryAfter(value, currentTime) {
      var seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) return Math.min(300000, Math.ceil(seconds * 1000));
      var target = Date.parse(String(value || ""));
      if (!Number.isFinite(target) || target <= currentTime) return 0;
      return Math.min(300000, target - currentTime);
    }

    async function enableInternal(generation) {
      if (!storage || !writerId || !metadataProvider) return false;
      try { storage.setItem(CONSENT_KEY, CONSENT_ENABLED); }
      catch (_) { return false; }
      enabled = true;
      installId = ensureInstallId();
      sessionId = secureUuid(cryptoObject);
      if (!installId || !sessionId) {
        enabled = false;
        try { storage.setItem(CONSENT_KEY, CONSENT_DISABLED); } catch (_) {}
        return false;
      }
      pageDisabled = false;
      var pendingMetadata = Promise.resolve().then(metadataProvider).then(safeMetadata).catch(function () { return null; });
      metadataPromise = pendingMetadata;
      var resolvedMetadata = await pendingMetadata;
      if (generation !== lifecycleVersion || !enabled || !requirePersistedConsent()) return false;
      if (!resolvedMetadata) {
        metadata = null;
        haltRuntime("metadata_unavailable");
        return false;
      }
      metadata = resolvedMetadata;
      var existingQueue = loadQueue();
      if (!enabled || generation !== lifecycleVersion) return false;
      if (existingQueue.draft) {
        if (!sealQueueDraft(existingQueue)) {
          existingQueue.draft = null;
          setStatus("invalid_dropped");
        }
        saveQueue(existingQueue);
      }
      if (!enabled || generation !== lifecycleVersion) return false;
      started = true;
      attachHandlers();
      sessionTimer = setRepeating(function () { refreshActiveSession(true); }, 10000);
      sealTimer = setRepeating(function () { if (sealDraft()) void uploadAvailable(); }, SEAL_INTERVAL_MS);
      recordInternal("session_start", "session.start", "info", { started: true, stage: "browser" }, false);
      refreshActiveSession(true);
      return true;
    }

    function enable() {
      if (enabled && started) return Promise.resolve(true);
      if (enablePromise) return enablePromise;
      var generation = lifecycleVersion + 1;
      lifecycleVersion = generation;
      var pending = enableInternal(generation);
      enablePromise = pending;
      pending.then(function () {
        if (enablePromise === pending) enablePromise = null;
      }, function () {
        if (enablePromise === pending) enablePromise = null;
      });
      return pending;
    }

    function disable(writeConsent) {
      if (writeConsent !== false) {
        try { storage.setItem(CONSENT_KEY, CONSENT_DISABLED); } catch (_) {}
      }
      haltRuntime();
      enablePromise = null;
      [INSTALL_KEY, QUEUE_KEY, STATUS_KEY, ACTIVE_KEY].forEach(function (key) {
        try { storage.removeItem(key); } catch (_) {}
      });
      installId = sessionId = null;
      metadata = null;
      metadataPromise = null;
      pageDisabled = false;
      reconnecting = false;
      credentialSeen = false;
    }

    function clearQueuedData() {
      if (!enabled || !requirePersistedConsent()) return false;
      cancelUpload();
      try { storage.removeItem(QUEUE_KEY); } catch (_) {}
      if (!setStatus("queue_cleared")) {
        disable(false);
        return false;
      }
      return true;
    }

    async function heartbeatSucceeded(context) {
      if (!enabled || !started || !context || typeof context.token !== "string" || !context.token) return false;
      var origin;
      try {
        var parsedUrl = new URL(context.controlUrl);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return false;
        origin = parsedUrl.origin;
      }
      catch (_) { return false; }
      var heartbeatAttempt = heartbeatVersion + 1;
      heartbeatVersion = heartbeatAttempt;
      if (auth && (auth.token !== context.token || auth.origin !== origin)) {
        sealDraft();
        cancelUpload();
        auth = null;
      }
      var digest;
      try { digest = await scopeDigest(context.token, installId, origin); }
      catch (_) { return false; }
      if (!digest || !/^[0-9a-f]{64}$/.test(digest)) return false;
      if (heartbeatAttempt !== heartbeatVersion || !enabled || !started) return false;
      if (auth && (auth.token !== context.token || auth.origin !== origin) && uploadAbort) uploadAbort.abort();
      auth = { token: context.token, origin: origin, scope: digest, proved_at_ms: now() };
      credentialSeen = true;
      var queue = loadQueue();
      if (!enabled) return false;
      if (queue.draft && queue.draft.session_id === sessionId && queue.draft.scope === null) {
        queue.draft.scope = digest;
      }
      queue.envelopes.forEach(function (item) {
        if (item.scope !== null) return;
        try {
          var envelope = JSON.parse(item.body);
          if (envelope.session_id === sessionId) item.scope = digest;
        } catch (_) {}
      });
      saveQueue(queue);
      refreshActiveSession(true);
      await metadataPromise;
      if (heartbeatAttempt !== heartbeatVersion || !auth || auth.token !== context.token || auth.origin !== origin) return false;
      return uploadAvailable(false);
    }

    function invalidateHeartbeat() {
      heartbeatVersion += 1;
      sealDraft();
      auth = null;
      cancelUpload();
    }

    function credentialBoundary(replacingCredential) {
      if (!enabled || !started) return false;
      if (!credentialSeen && !replacingCredential) {
        credentialSeen = true;
        return true;
      }
      credentialSeen = true;
      recordInternal("session_end", "session.end", "info", { clean: true, stage: "browser" }, false);
      sealDraft();
      removeActiveSession();
      cancelUpload();
      auth = null;
      heartbeatVersion += 1;
      var nextSessionId = secureUuid(cryptoObject);
      if (!nextSessionId) {
        haltRuntime("identifier_unavailable");
        return false;
      }
      sessionId = nextSessionId;
      lastEventCode = "";
      lastEventAt = 0;
      recordInternal("session_start", "session.start", "info", { started: true, stage: "browser" }, false);
      refreshActiveSession(false);
      return true;
    }

    function recordLegacyEvent(name) {
      var mapped = LEGACY_EVENTS[name];
      if (!mapped) return false;
      return recordInternal(mapped[0], mapped[1], mapped[2], {}, mapped[2] !== "info");
    }

    function recordPermission(kind, granted, errorName) {
      if (!MEDIA_KINDS.has(kind)) return false;
      var prefix = kind === "screen" ? "screen_share" : kind;
      return recordInternal("permission", prefix + (granted ? ".granted" : ".denied"), granted ? "info" : "error", {
        permission: kind,
        granted: !!granted,
        denied: !granted,
        error_code: granted ? "unknown" : safeErrorCode(errorName),
      }, !granted);
    }

    function recordDeviceCounts(counts) {
      counts = counts || {};
      return recordInternal("media", "media.devices_observed", "info", {
        microphone: safeInteger(counts.microphone, 100),
        camera: safeInteger(counts.camera, 100),
        output: safeInteger(counts.output, 100),
        granted: !!counts.labelsAvailable,
      }, false);
    }

    function recordMedia(kind, action, state, errorName) {
      if (!MEDIA_KINDS.has(kind) || !SAFE_ACTIONS.has(action) || !SAFE_STATES.has(state)) return false;
      var prefix = kind === "screen" ? "screen_share" : kind;
      var failed = state === "failed" || state === "error";
      return recordInternal("media", prefix + "." + action, failed ? "warning" : "info", {
        media_kind: kind,
        action: action,
        state: state,
        error_code: failed ? safeErrorCode(errorName) : "unknown",
      }, failed);
    }

    function recordConnectionState(state, errorName) {
      if (!CONNECTION_STATES.has(state)) return false;
      if (state === "reconnecting") {
        if (reconnecting) return false;
        reconnecting = true;
        return recordInternal("reconnect", "reconnect.started", "warning", { connection_state: state }, true);
      }
      if (state === "connected" && reconnecting) {
        reconnecting = false;
        return recordInternal("reconnect", "reconnect.completed", "info", { connection_state: state }, false);
      }
      if (state === "disconnected") reconnecting = false;
      var failed = state === "failed" || state === "error" || state === "disconnected";
      return recordInternal("connection", "connection." + state, failed ? "warning" : "info", {
        connection_state: state,
        error_code: failed ? safeErrorCode(errorName) : "unknown",
      }, failed);
    }

    function snapshot() {
      var queue = loadQueue();
      var status = null;
      try { status = JSON.parse(storage.getItem(STATUS_KEY) || "null"); } catch (_) {}
      return {
        consent: consentState(),
        enabled: enabled,
        queued: queue.envelopes.length + (queue.draft && queue.draft.events.length ? 1 : 0),
        sealed: queue.envelopes.length,
        status: status && typeof status.code === "string" ? status : null,
        authenticated: !!auth && auth.proved_at_ms + HEARTBEAT_AUTH_MAX_MS >= now(),
      };
    }

    return {
      enable: enable,
      disable: disable,
      consentState: consentState,
      heartbeatSucceeded: heartbeatSucceeded,
      invalidateHeartbeat: invalidateHeartbeat,
      credentialBoundary: credentialBoundary,
      recordLegacyEvent: recordLegacyEvent,
      recordPermission: recordPermission,
      recordDeviceCounts: recordDeviceCounts,
      recordMedia: recordMedia,
      recordConnectionState: recordConnectionState,
      sendNow: async function () { await metadataPromise; sealDraft(); return uploadAvailable(true); },
      clearQueuedData: clearQueuedData,
      snapshot: snapshot,
      _recordWindowError: function (event) { if (handlers) handlers.error(event); },
      _recordUnhandledRejection: function (event) { if (handlers) handlers.rejection(event); },
      _sealDraft: sealDraft,
      _constants: { CONSENT_KEY: CONSENT_KEY, INSTALL_KEY: INSTALL_KEY, QUEUE_KEY: QUEUE_KEY, STATUS_KEY: STATUS_KEY, ACTIVE_KEY: ACTIVE_KEY },
    };
  }

  function isDesktopMacBrowser(environment) {
    if (!environment || environment.__ECHO_NATIVE__ || !environment.navigator) return false;
    var navigatorObject = environment.navigator;
    var platform = String(navigatorObject.platform || "");
    var userAgent = String(navigatorObject.userAgent || "");
    var isMac = /^Mac/.test(platform) || /Macintosh|Mac OS X/.test(userAgent);
    var isIPadMasquerading = isMac && Number(navigatorObject.maxTouchPoints || 0) > 1;
    return isMac && !isIPadMasquerading;
  }

  function detectBrowserRuntime(navigatorObject, livekit) {
    var userAgent = String((navigatorObject && navigatorObject.userAgent) || "");
    var browserName = "Browser";
    var browserVersion = "unknown";
    var match = userAgent.match(/Edg\/([0-9.]+)/);
    if (match) { browserName = "Edge"; browserVersion = match[1]; }
    else if ((match = userAgent.match(/Chrome\/([0-9.]+)/))) { browserName = "Chrome"; browserVersion = match[1]; }
    else if ((match = userAgent.match(/Firefox\/([0-9.]+)/))) { browserName = "Firefox"; browserVersion = match[1]; }
    else if ((match = userAgent.match(/Version\/([0-9.]+).*Safari/))) { browserName = "Safari"; browserVersion = match[1]; }
    var runtimes = { browser_name: browserName, browser_version: browserVersion };
    if (livekit && typeof livekit.version === "string") runtimes.livekit_version = livekit.version;
    return runtimes;
  }

  function browserMetadataProvider(environment) {
    return async function () {
      var endpoint = typeof environment.apiUrl === "function" ? environment.apiUrl("/api/version") : "/api/version";
      var response = await environment.fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error("version unavailable");
      var payload = await response.json();
      return {
        app: {
          version: payload.version,
          git_sha: payload.git_sha,
          channel: "web-canary",
          runtimes: detectBrowserRuntime(environment.navigator, environment.LivekitClient),
        },
        platform: { client_kind: "browser", operating_system: "macos", architecture: "unknown" },
      };
    };
  }

  function installBrowserRuntime(environment) {
    if (!isDesktopMacBrowser(environment) || environment.EchoWebDiagnosticsRuntime) return null;
    var storage;
    var boundFetch;
    try {
      storage = environment.localStorage;
      boundFetch = environment.fetch.bind(environment);
    } catch (_) {
      return null;
    }
    var collector = createCollector({
      storage: storage,
      crypto: environment.crypto,
      fetch: boundFetch,
      metadataProvider: browserMetadataProvider(environment),
      scopeDigest: function (token, installId, origin) {
        return defaultScopeDigest(token, installId, origin, environment.crypto);
      },
      eventTarget: environment,
    });
    environment.EchoWebDiagnosticsRuntime = collector;

    var documentObject = environment.document;
    var section = documentObject.getElementById("diagnostics-settings-section");
    var toggle = documentObject.getElementById("diagnostics-enabled-toggle");
    var modal = documentObject.getElementById("diagnostics-consent-modal");
    var accept = documentObject.getElementById("diagnostics-consent-accept");
    var decline = documentObject.getElementById("diagnostics-consent-decline");
    var send = documentObject.getElementById("diagnostics-send-now");
    var clear = documentObject.getElementById("diagnostics-delete-queued");
    var lastUpload = documentObject.getElementById("diagnostics-last-upload");
    var queueCount = documentObject.getElementById("diagnostics-queue-count");
    var actionStatus = documentObject.getElementById("diagnostics-action-status");
    if (section) section.classList.remove("hidden");

    function statusLabel(status) {
      var labels = {
        accepted: "Accepted", duplicate: "Already received", auth_wait: "Waiting for a fresh heartbeat",
        server_disabled: "Unavailable on this server", conflict_dropped: "Corrupt report removed",
        invalid_dropped: "Invalid report removed", rate_limited: "Rate limited; retry scheduled",
        retry_wait: "Server unavailable; retry scheduled", network_wait: "Offline; retry scheduled",
        metadata_unavailable: "Build metadata unavailable", queue_cleared: "Queued data deleted",
        storage_unavailable: "Browser storage unavailable", identifier_unavailable: "Secure random source unavailable",
      };
      return labels[status] || "Never";
    }

    function render() {
      var snapshot = collector.snapshot();
      if (toggle) toggle.checked = snapshot.consent === "enabled";
      if (queueCount) queueCount.textContent = snapshot.queued + (snapshot.queued === 1 ? " report" : " reports");
      if (lastUpload) {
        lastUpload.textContent = snapshot.status ? statusLabel(snapshot.status.code) +
          (snapshot.status.at_ms ? " - " + new Date(snapshot.status.at_ms).toLocaleString() : "") : "Never";
      }
      if (send) send.disabled = snapshot.consent !== "enabled" || !snapshot.authenticated;
      if (clear) clear.disabled = snapshot.queued === 0;
    }

    async function setEnabled(next) {
      if (next) {
        if (actionStatus) actionStatus.textContent = "Starting private diagnostics...";
        var ready = await collector.enable();
        if (actionStatus) actionStatus.textContent = ready ? "Diagnostics are on." : "Diagnostics could not start safely.";
      } else {
        collector.disable();
        if (actionStatus) actionStatus.textContent = "Diagnostics are off. Queued browser data was deleted.";
      }
      render();
    }

    if (toggle) toggle.addEventListener("change", function () { void setEnabled(toggle.checked); });
    if (accept) accept.addEventListener("click", function () {
      modal.hidden = true;
      void setEnabled(true);
    });
    if (decline) decline.addEventListener("click", function () {
      modal.hidden = true;
      void setEnabled(false);
    });
    if (send) send.addEventListener("click", async function () {
      if (actionStatus) actionStatus.textContent = "Sending queued diagnostics...";
      var sent = await collector.sendNow();
      if (actionStatus) actionStatus.textContent = sent ? "Send attempted." : "Waiting for a connected heartbeat.";
      render();
    });
    if (clear) clear.addEventListener("click", function () {
      collector.clearQueuedData();
      if (actionStatus) actionStatus.textContent = "Queued browser data deleted. Accepted server reports are unchanged.";
      render();
    });
    environment.addEventListener("storage", function (event) {
      if (event.key !== CONSENT_KEY) return;
      if (event.newValue === CONSENT_DISABLED) collector.disable(false);
      else if (event.newValue === CONSENT_ENABLED) void collector.enable();
      render();
    });

    var start = function () {
      var state = collector.consentState();
      render();
      if (state === "enabled") void collector.enable().then(render);
      else if (state === "unset" && modal) {
        modal.hidden = false;
        if (decline) setTimeout(function () { decline.focus(); }, 0);
      }
    };
    Promise.resolve(environment._settingsReadyPromise || null).then(start, start);
    environment.setInterval(render, 1000);
    return collector;
  }

  return {
    createCollector: createCollector,
    installBrowserRuntime: installBrowserRuntime,
    isDesktopMacBrowser: isDesktopMacBrowser,
    detectBrowserRuntime: detectBrowserRuntime,
    safeMetadata: safeMetadata,
    sanitizeEvent: sanitizeEvent,
    validateSealedBody: validateSealedBody,
    parseQueue: parseQueue,
    secureUuid: secureUuid,
    decodeJwtSubject: decodeJwtSubject,
    constants: {
      CONSENT_KEY: CONSENT_KEY,
      INSTALL_KEY: INSTALL_KEY,
      QUEUE_KEY: QUEUE_KEY,
      STATUS_KEY: STATUS_KEY,
      ACTIVE_KEY: ACTIVE_KEY,
      CONSENT_ENABLED: CONSENT_ENABLED,
      CONSENT_DISABLED: CONSENT_DISABLED,
      MAX_ENVELOPES: MAX_ENVELOPES,
      MAX_ENVELOPE_BYTES: MAX_ENVELOPE_BYTES,
      MAX_QUEUE_BYTES: MAX_QUEUE_BYTES,
      QUEUE_TTL_MS: QUEUE_TTL_MS,
    },
  };
});
