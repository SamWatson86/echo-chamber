import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(scriptDirectory, "..", "..", "viewer");
const port = Number.parseInt(process.env.PORT || "4175", 10);

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

function resolveViewerFile(requestUrl) {
  const url = new URL(requestUrl, `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(viewerRoot, relativePath);
  const rootPrefix = `${viewerRoot}${path.sep}`;

  if (candidate !== viewerRoot && !candidate.startsWith(rootPrefix)) {
    return null;
  }
  return candidate;
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

  let filePath;
  try {
    filePath = resolveViewerFile(request.url || "/");
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
    const body = await readFile(filePath);
    const contentType = contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": body.length,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    send(response, 404, "not found", "text/plain; charset=utf-8");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[viewer-tests] serving ${viewerRoot} at http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
