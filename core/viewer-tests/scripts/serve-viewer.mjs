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
  if (isolatedThemePreview && pathname === "/__echo-theme-preview-fixture.js") {
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

function injectIsolatedThemePreview(html) {
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
    <div id="echo-isolated-preview-banner" role="status" aria-label="Isolated theme preview. Not live Echo.">
      <span>Isolated Theme Preview</span>
      <strong>Not Live Echo</strong>
      <small>localhost fixture · no production connection</small>
    </div>
  `;
  const scenario = `
    <script src="/__echo-theme-preview-fixture.js"></script>
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
          localCamera: true
        }).then(function () {
          document.documentElement.dataset.echoIsolatedPreviewReady = "true";
          if (typeof setThemeStudioOpen === "function") setThemeStudioOpen(true);
        }).catch(function (error) {
          console.error("[isolated-theme-preview] fixture failed", error);
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

  if (isolatedThemePreview) {
    const requestUrl = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/api/online") {
      send(response, 200, "[]", "application/json; charset=utf-8");
      return;
    }
    if (requestUrl.pathname === "/api/version") {
      send(response, 200, JSON.stringify({ latest_client: "" }), "application/json; charset=utf-8");
      return;
    }
    if (requestUrl.pathname.startsWith("/api/avatar/")) {
      send(response, 200, transparentPng, "image/png");
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
      isolatedThemePreview &&
      filePath === path.join(viewerRoot, "index.html")
    ) {
      body = injectIsolatedThemePreview(body.toString("utf8"));
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
  console.log(
    `[viewer-tests] serving ${viewerRoot} and ${adminRoot} at http://127.0.0.1:${port}` +
      (isolatedThemePreview ? " [ISOLATED THEME PREVIEW]" : ""),
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
