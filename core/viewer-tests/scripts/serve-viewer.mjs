import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(scriptDirectory, "..", "..", "viewer");
const adminRoot = path.resolve(scriptDirectory, "..", "..", "admin");
const previewFixture = path.resolve(scriptDirectory, "..", "fixtures", "install-scenario.js");
const port = Number.parseInt(process.env.PORT || "4175", 10);
const isolatedThemePreview = process.env.ECHO_THEME_PREVIEW === "1";
const isolatedJamPreview = process.env.ECHO_JAM_PREVIEW === "1";
const isolatedHistoryPreview = process.env.ECHO_HISTORY_PREVIEW === "1";
const isolatedPreview = isolatedThemePreview || isolatedJamPreview || isolatedHistoryPreview;
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

const historyPreviewNow = Math.floor(Date.now() / 1000);
const historyPreviewPeople = ["Sam", "David", "Decker", "Zane", "Spencer", "Brad"];
const historyPreviewOffsets = [
  45 * 60,
  2 * 60 * 60,
  8 * 60 * 60,
  24 * 60 * 60,
  2 * 24 * 60 * 60,
  4 * 24 * 60 * 60,
  8 * 24 * 60 * 60,
  18 * 24 * 60 * 60,
  27 * 24 * 60 * 60,
  45 * 24 * 60 * 60,
  75 * 24 * 60 * 60,
  140 * 24 * 60 * 60,
  300 * 24 * 60 * 60,
  430 * 24 * 60 * 60,
  800 * 24 * 60 * 60,
];
const historyPreviewEvents = historyPreviewOffsets.map((offset, index) => ({
  event_type: index % 2 === 0 ? "join" : "leave",
  identity: `preview-${index + 1}`,
  name: historyPreviewPeople[index % historyPreviewPeople.length],
  room_id: index % 4 === 0 ? "Game Room" : index % 3 === 0 ? "Music Room" : "Main",
  timestamp: historyPreviewNow - offset,
  ...(index % 2 === 0 ? {} : { duration_secs: 900 + index * 420 }),
}));

const historyPreviewHeatmapJoins = [];
for (let dayOffset = 29; dayOffset >= 0; dayOffset -= 1) {
  const joinsForDay = 2 + (dayOffset % 4);
  for (let index = 0; index < joinsForDay; index += 1) {
    const joinedAt = new Date(historyPreviewNow * 1000);
    const hour = [8, 12, 18, 21, 23][(dayOffset + index) % 5];
    joinedAt.setDate(joinedAt.getDate() - dayOffset);
    joinedAt.setHours(hour, (index * 13 + dayOffset * 3) % 60, 0, 0);
    const timestamp = Math.floor(joinedAt.getTime() / 1000);
    if (timestamp <= historyPreviewNow) {
      historyPreviewHeatmapJoins.push({
        timestamp,
        name: historyPreviewPeople[(dayOffset + index) % historyPreviewPeople.length],
      });
    }
  }
}

function historyPreviewMetricsPayload() {
  const counts = new Map();
  historyPreviewHeatmapJoins.forEach((join) => {
    counts.set(join.name, (counts.get(join.name) || 0) + 1);
  });
  const perUser = Array.from(counts.entries())
    .map(([name, sessionCount], index) => ({
      identity: `preview-metric-${index + 1}`,
      name,
      session_count: sessionCount,
      total_hours: Math.round(sessionCount * 7.5) / 10,
    }))
    .sort((left, right) => right.session_count - left.session_count);

  const localNow = new Date(historyPreviewNow * 1000);
  const todayStart = Math.floor(new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate(),
  ).getTime() / 1000);
  const elapsedToday = Math.max(60, historyPreviewNow - todayStart);
  const timelinePoint = (fraction) => todayStart + Math.floor(elapsedToday * fraction);

  return {
    summary: {
      total_sessions: historyPreviewHeatmapJoins.length,
      unique_users: counts.size,
      total_hours: Math.round(historyPreviewHeatmapJoins.length * 7.5) / 10,
      avg_duration_mins: 45,
    },
    per_user: perUser,
    heatmap_joins: historyPreviewHeatmapJoins,
    timeline_events: [
      { event_type: "join", identity: "preview-timeline-sam", name: "Sam", timestamp: timelinePoint(0.12) },
      { event_type: "leave", identity: "preview-timeline-sam", name: "Sam", timestamp: timelinePoint(0.38) },
      { event_type: "join", identity: "preview-timeline-david", name: "David", timestamp: timelinePoint(0.28) },
      { event_type: "leave", identity: "preview-timeline-david", name: "David", timestamp: timelinePoint(0.66) },
      { event_type: "join", identity: "preview-timeline-decker", name: "Decker", timestamp: timelinePoint(0.54) },
    ],
  };
}

function historyPreviewPayload(requestUrl) {
  const range = requestUrl.searchParams.get("range") || "month";
  const cursor = requestUrl.searchParams.get("cursor") || "";
  let filtered = historyPreviewEvents;
  const rollingDays = { week: 7, month: 30, quarter: 90, year: 365 }[range];
  if (rollingDays) {
    const cutoff = historyPreviewNow - rollingDays * 24 * 60 * 60;
    filtered = filtered.filter((event) => event.timestamp >= cutoff);
  } else if (range.startsWith("year:")) {
    const year = Number.parseInt(range.slice(5), 10);
    filtered = filtered.filter((event) => new Date(event.timestamp * 1000).getUTCFullYear() === year);
  } else if (range !== "all") {
    filtered = [];
  }

  const pageSize = 6;
  const offset = cursor.startsWith("preview:")
    ? Math.max(0, Number.parseInt(cursor.slice("preview:".length), 10) || 0)
    : 0;
  const events = filtered.slice(offset, offset + pageSize);
  const nextOffset = offset + events.length;
  const availableYears = Array.from(new Set(
    historyPreviewEvents.map((event) => new Date(event.timestamp * 1000).getUTCFullYear()),
  )).sort((a, b) => b - a);

  return {
    events,
    next_cursor: nextOffset < filtered.length ? `preview:${nextOffset}` : null,
    total_count: filtered.length,
    available_from: historyPreviewEvents.at(-1)?.timestamp || null,
    available_to: historyPreviewEvents[0]?.timestamp || null,
    available_years: availableYears,
  };
}

function send(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function resolveStaticFile(requestUrl) {
  const url = new URL(requestUrl, `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  if (isolatedPreview && pathname === "/__echo-preview-fixture.js") {
    return previewFixture;
  }
  const isAdminRequest = pathname === "/admin" || pathname.startsWith("/admin/");
  const root = isAdminRequest ? adminRoot : viewerRoot;
  let relativePath = isAdminRequest
    ? pathname.slice("/admin".length).replace(/^\/+/, "")
    : pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (isAdminRequest && (!relativePath || pathname.endsWith("/"))) {
    relativePath = path.join(relativePath, "index.html");
  }

  const candidate = path.resolve(root, relativePath);
  const rootPrefix = `${root}${path.sep}`;

  if (candidate !== root && !candidate.startsWith(rootPrefix)) {
    return null;
  }
  return candidate;
}

function injectIsolatedPreview(html) {
  const previewName = isolatedJamPreview
    ? "Isolated Jam Preview"
    : isolatedHistoryPreview
      ? "Isolated Dashboard History Preview"
      : "Isolated Theme Preview";
  const earlyBootstrap = `
    <script>
      (function () {
        document.documentElement.dataset.echoIsolatedPreview = "true";
        try {
          localStorage.setItem("echo-core-theme-motion", "full");
        } catch (_storageError) {}
        var nativeMatchMedia = typeof window.matchMedia === "function"
          ? window.matchMedia.bind(window)
          : null;
        window.matchMedia = function (query) {
          if (query === "(prefers-reduced-motion: reduce)") {
            return {
              matches: false,
              media: query,
              onchange: null,
              addEventListener: function () {},
              removeEventListener: function () {},
              addListener: function () {},
              removeListener: function () {},
              dispatchEvent: function () { return false; }
            };
          }
          return nativeMatchMedia
            ? nativeMatchMedia(query)
            : {
                matches: false,
                media: query,
                onchange: null,
                addEventListener: function () {},
                removeEventListener: function () {},
                addListener: function () {},
                removeListener: function () {},
                dispatchEvent: function () { return false; }
              };
        };
      })();
    </script>
    <style>
      #echo-isolated-preview-banner {
        position: fixed;
        top: 10px;
        left: 50%;
        z-index: 2147483647;
        transform: translateX(-50%);
        min-width: min(680px, calc(100vw - 24px));
        padding: 9px 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        color: #fff8df;
        border: 2px solid #ffcc47;
        border-radius: 999px;
        background: rgb(94 26 12 / 0.96);
        box-shadow: 0 10px 40px rgb(0 0 0 / 0.58), 0 0 0 3px rgb(255 204 71 / 0.18);
        font: 800 12px/1.2 Inter, ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.08em;
        text-align: center;
        text-transform: uppercase;
        pointer-events: none;
      }
      #echo-isolated-preview-banner strong {
        padding: 3px 8px;
        color: #250500;
        border-radius: 999px;
        background: #ffcc47;
      }
      #echo-isolated-preview-banner small {
        color: #ffdca0;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      @media (max-width: 720px) {
        #echo-isolated-preview-banner {
          min-width: calc(100vw - 16px);
          gap: 6px;
          flex-wrap: wrap;
          border-radius: 16px;
        }
      }
    </style>
  `;
  const banner = `
    <div id="echo-isolated-preview-banner" role="status" aria-label="${previewName}. Not live Echo.">
      <span>${previewName}</span>
      <strong>Not Live Echo</strong>
      <small>localhost fixture · no production connection</small>
    </div>
  `;
  const openPreview = isolatedJamPreview
    ? `
          if (typeof setThemeStudioOpen === "function") setThemeStudioOpen(false);
          if (typeof adminToken !== "undefined") adminToken = "isolated-jam-preview-admin";
          if (typeof currentAccessToken !== "undefined") currentAccessToken = "isolated-jam-preview-participant";
          var jamButton = document.getElementById("open-jam");
          if (jamButton) jamButton.disabled = false;
          if (typeof openJamPanel === "function") openJamPanel(jamButton);
          if (typeof setJamView === "function") setJamView("library", false);
      `
    : isolatedHistoryPreview
      ? `
          if (typeof setThemeStudioOpen === "function") setThemeStudioOpen(false);
          if (typeof adminToken !== "undefined") adminToken = "isolated-history-preview-admin";
          if (typeof currentAccessToken !== "undefined") currentAccessToken = "isolated-history-preview-participant";
          var dashboardPanel = document.getElementById("admin-dash-panel");
          if (dashboardPanel && dashboardPanel.classList.contains("hidden") && typeof toggleAdminDash === "function") {
            toggleAdminDash();
          }
          var historyTab = document.getElementById("admin-dash-history-tab");
          if (historyTab && typeof switchAdminTab === "function") {
            switchAdminTab(historyTab, "admin-dash-history");
          }
      `
      : `
          if (typeof setThemeStudioOpen === "function") setThemeStudioOpen(true);
      `;
  const scenario = `
    <script src="/__echo-preview-fixture.js"></script>
    <script>
      window.addEventListener("load", function () {
        var fixture = window.EchoLayoutTestScenario;
        if (!fixture) return;
        fixture.install({
          participants: 5,
          cameras: 3,
          screenShares: 1,
          shareAspects: [16 / 9],
          chatOpen: false,
          localCamera: true,
          screenOwners: [0]
        }).then(function () {
          document.documentElement.dataset.echoIsolatedPreviewReady = "true";
          ${openPreview}
        }).catch(function (error) {
          console.error("[isolated-preview] fixture failed", error);
        });
      });
    </script>
  `;

  return html
    .replace("<head>", `<head>${earlyBootstrap}`)
    .replace("<title>Echo Chamber</title>", "<title>[ISOLATED PREVIEW] Echo Chamber</title>")
    .replace("<body>", `<body>${banner}`)
    .replace("</body>", `${scenario}</body>`);
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/healthz") {
    send(response, 200, "ok", "text/plain; charset=utf-8");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "method not allowed", "text/plain; charset=utf-8");
    return;
  }

  if (isolatedPreview) {
    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/api/online") {
      send(response, 200, "[]", "application/json; charset=utf-8");
      return;
    }
    if (requestUrl.pathname === "/api/version") {
      send(response, 200, JSON.stringify({ latest_client: "" }), "application/json; charset=utf-8");
      return;
    }
    if (isolatedHistoryPreview && requestUrl.pathname === "/admin/api/dashboard") {
      send(response, 200, JSON.stringify({
        rooms: [],
        total_online: 6,
        server_version: "history-preview",
      }), "application/json; charset=utf-8");
      return;
    }
    if (isolatedHistoryPreview && requestUrl.pathname === "/admin/api/sessions") {
      send(response, 200, JSON.stringify(historyPreviewPayload(requestUrl)), "application/json; charset=utf-8");
      return;
    }
    if (isolatedHistoryPreview && requestUrl.pathname === "/admin/api/metrics/dashboard") {
      send(response, 200, JSON.stringify(historyPreviewMetricsPayload()), "application/json; charset=utf-8");
      return;
    }
    if (isolatedHistoryPreview && requestUrl.pathname === "/admin/api/metrics") {
      send(response, 200, JSON.stringify({ users: [] }), "application/json; charset=utf-8");
      return;
    }
    if (isolatedHistoryPreview && requestUrl.pathname === "/admin/api/bugs") {
      send(response, 200, JSON.stringify({ reports: [] }), "application/json; charset=utf-8");
      return;
    }
    if (requestUrl.pathname.startsWith("/api/avatar/")) {
      send(response, 200, transparentPng, "image/png");
      return;
    }
    if (isolatedJamPreview && requestUrl.pathname === "/api/jam/state") {
      send(response, 200, JSON.stringify({
        jam_protocol_version: 3,
        active: true,
        generation: 7,
        spotify_connected: true,
        spotify_library_authorized: false,
        spotify_is_playing: true,
        playback_stop_supported: true,
        playlist_selection_supported: true,
        source_enabled: true,
        source_availability_known: true,
        source_status: "live",
        source_ready: true,
        source_last_frame_ms: 18,
        source_peak: 0.42,
        host_identity: "layout-fixture-1",
        listener_count: 1,
        listeners: ["layout-fixture-1"],
        now_playing: {
          spotify_id: "0VjIjW4GlUZAMYd2vXMi3b",
          spotify_uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
          spotify_url: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
          name: "Blinding Lights",
          artist: "The Weeknd",
          duration_ms: 200040,
          progress_ms: 86000,
          is_playing: true,
        },
        queue: [],
      }), "application/json; charset=utf-8");
      return;
    }
    if (isolatedJamPreview && requestUrl.pathname === "/api/jam/favorites") {
      send(response, 200, JSON.stringify({
        schema_version: 1,
        items: [],
        contributors: [],
        counts: { tracks: 0, playlists: 0, contributors: 0 },
        offset: 0,
        limit: 20,
        total: 0,
        next_offset: null,
      }), "application/json; charset=utf-8");
      return;
    }
  }

  let filePath;
  try {
    filePath = resolveStaticFile(request.url || "/");
  } catch {
    send(response, 400, "bad request", "text/plain; charset=utf-8");
    return;
  }
  if (!filePath) {
    send(response, 403, "forbidden", "text/plain; charset=utf-8");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("not a file");
    let body = await readFile(filePath);
    if (
      isolatedPreview &&
      filePath === path.join(viewerRoot, "index.html")
    ) {
      body = injectIsolatedPreview(body.toString("utf8"));
    }
    const contentType = contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    send(response, 404, "not found", "text/plain; charset=utf-8");
  }
});

server.listen(port, "127.0.0.1", () => {
  const previewLabel = isolatedJamPreview
    ? " [ISOLATED JAM PREVIEW]"
    : isolatedThemePreview
      ? " [ISOLATED THEME PREVIEW]"
      : isolatedHistoryPreview
        ? " [ISOLATED HISTORY PREVIEW]"
        : "";
  console.log(
    `[viewer-tests] serving ${viewerRoot} and ${adminRoot} at http://127.0.0.1:${port}${previewLabel}`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
