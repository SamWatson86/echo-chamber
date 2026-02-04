import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import {
  app,
  BrowserWindow,
  dialog,
  desktopCapturer,
  ipcMain,
  session,
  screen,
  Menu,
  Tray,
  nativeImage,
  shell
} from "electron";
import type { ServerHandle, TlsOptions } from "@echo/server";
import type { Event } from "electron";

const bootstrapLogPath = path.join(process.env.TEMP ?? process.cwd(), "echo-chamber-bootstrap.log");

function bootstrapLog(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta ? { meta } : {})
    };
    fs.appendFileSync(bootstrapLogPath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort fallback; avoid crashing on logging failures.
  }
}

function loadEnv() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "apps/server/.env")
  ];

  if (app.isPackaged) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath) {
      candidates.push(path.join(resourcesPath, "echo-chamber.env"));
    }
    candidates.push(path.join(app.getPath("userData"), "echo-chamber.env"));
    candidates.push(path.join(app.getPath("appData"), "Echo Chamber", "echo-chamber.env"));
  }

  for (const envPath of candidates) {
    dotenv.config({ path: envPath });
  }
}

function envFilePath() {
  return path.join(app.getPath("userData"), "echo-chamber.env");
}

function parseEnvFile(contents: string) {
  const env: Record<string, string> = {};
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    if (key) env[key] = value;
  }
  return env;
}

function writeEnvFile(filePath: string, env: Record<string, string>) {
  const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join(os.EOL)}${os.EOL}`, "utf8");
}

function generatePassword() {
  return crypto.randomBytes(9).toString("base64url");
}

function ensureConfig() {
  const filePath = envFilePath();
  const existing = fs.existsSync(filePath) ? parseEnvFile(fs.readFileSync(filePath, "utf8")) : {};
  let updated = false;
  let generatedPassword: string | undefined;

  if (!existing.AUTH_PASSWORD_HASH) {
    generatedPassword = generatePassword();
    existing.AUTH_PASSWORD_HASH = bcrypt.hashSync(generatedPassword, 10);
    updated = true;
  }

  if (!existing.AUTH_JWT_SECRET) {
    existing.AUTH_JWT_SECRET = crypto.randomBytes(32).toString("hex");
    updated = true;
  }

  if (!existing.PORT) {
    existing.PORT = "5050";
    updated = true;
  }

  if (!existing.HOST) {
    existing.HOST = "0.0.0.0";
    updated = true;
  }

  if (!existing.AUTH_TOKEN_TTL_HOURS) {
    existing.AUTH_TOKEN_TTL_HOURS = "12";
    updated = true;
  }

  if (!existing.MAX_PEERS_PER_ROOM) {
    existing.MAX_PEERS_PER_ROOM = "8";
    updated = true;
  }

  if (!existing.SERVER_NAME) {
    existing.SERVER_NAME = "Echo Chamber";
    updated = true;
  }

  if (!existing.ICE_SERVERS_JSON) {
    existing.ICE_SERVERS_JSON = "";
    updated = true;
  }

  if (!existing.TLS_CERT_PATH) {
    existing.TLS_CERT_PATH = "";
    updated = true;
  }

  if (!existing.TLS_KEY_PATH) {
    existing.TLS_KEY_PATH = "";
    updated = true;
  }

  if (updated) {
    writeEnvFile(filePath, existing);
  }

  dotenv.config({ path: filePath, override: true });

  if (generatedPassword) {
    dialog.showMessageBox({
      type: "info",
      title: "Echo Chamber setup",
      message: "A new password has been generated for this host.",
      detail: `Password: ${generatedPassword}\nConfig: ${filePath}`,
      buttons: ["OK"]
    });
  }
}

let serverHandle: ServerHandle | undefined;
let serverModule: ServerModule | null = null;
let appLogStream: fs.WriteStream | undefined;
let appLogFilePath: string | undefined;
let appLogBytes = 0;
const appLogMaxBytes = (() => {
  const raw = process.env.LOG_MAX_BYTES;
  if (!raw) return 5_000_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000_000;
  return parsed;
})();
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pickerInFlight: Promise<Electron.DesktopCapturerSource | undefined> | null = null;
const windowStatePath = path.join(app.getPath("userData"), "window-state.json");
let windowStateSaveTimer: NodeJS.Timeout | null = null;
const desktopPrefsPath = path.join(app.getPath("userData"), "desktop-prefs.json");
let quitInProgress = false;
const trayModeEnabled = true;

type ServerStatus = "stopped" | "starting" | "running" | "stopping";
let serverStatus: ServerStatus = "stopped";

type RuntimeConfig = {
  port: number;
  host: string;
  passwordHash: string;
  jwtSecret: string;
  tokenTtlHours: number;
  adminPasswordHash?: string;
  adminTokenTtlHours?: number;
  maxPeersPerRoom?: number;
  serverName?: string;
  logFile?: string;
  tls?: TlsOptions;
};

let runtimeConfig: RuntimeConfig | null = null;

type DesktopPrefs = {
  password?: string;
  avatar?: string;
};

function readDesktopPrefs(): DesktopPrefs {
  try {
    if (!fs.existsSync(desktopPrefsPath)) return {};
    const raw = fs.readFileSync(desktopPrefsPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      password: typeof parsed.password === "string" ? parsed.password : undefined,
      avatar: typeof parsed.avatar === "string" ? parsed.avatar : undefined
    };
  } catch {
    return {};
  }
}

function writeDesktopPrefs(prefs: DesktopPrefs) {
  try {
    fs.mkdirSync(path.dirname(desktopPrefsPath), { recursive: true });
    fs.writeFileSync(desktopPrefsPath, JSON.stringify(prefs), "utf8");
  } catch {
    // best effort
  }
}

function updateDesktopPrefs(updates: DesktopPrefs) {
  const current = readDesktopPrefs();
  const next: DesktopPrefs = { ...current, ...updates };
  if (typeof next.password !== "string" || next.password.length === 0) {
    delete next.password;
  }
  if (typeof next.avatar !== "string" || next.avatar.length === 0) {
    delete next.avatar;
  }
  writeDesktopPrefs(next);
  return next;
}

ipcMain.handle("audio-output:supported", (event) => {
  const sender = event.sender as Electron.WebContents & {
    setAudioOutputDevice?: (id: string) => Promise<void>;
  };
  return typeof sender.setAudioOutputDevice === "function";
});

ipcMain.handle("audio-output:set", async (event, deviceId: string) => {
  const sinkId = deviceId && deviceId.length > 0 ? deviceId : "default";
  const sender = event.sender as Electron.WebContents & {
    setAudioOutputDevice?: (id: string) => Promise<void>;
  };
  if (typeof sender.setAudioOutputDevice !== "function") {
    appLog("warn", "audio_output_unsupported");
    return false;
  }
  await sender.setAudioOutputDevice(sinkId);
  appLog("info", "audio_output_set", { sinkId });
  return true;
});

ipcMain.handle("app:restart", async () => {
  app.relaunch();
  app.exit(0);
  return true;
});

ipcMain.handle("desktop:prefs:get", () => readDesktopPrefs());

ipcMain.handle("desktop:prefs:set", (event, updates: DesktopPrefs) => {
  const safeUpdates: DesktopPrefs = {};
  if (updates && typeof updates.password === "string") {
    safeUpdates.password = updates.password;
  }
  if (updates && typeof updates.avatar === "string") {
    safeUpdates.avatar = updates.avatar;
  }
  return updateDesktopPrefs(safeUpdates);
});

function resolveLogDir(): string | undefined {
  const candidates = [
    process.env.LOG_DIR,
    path.join(app.getPath("userData"), "logs"),
    path.join(app.getPath("appData"), "Echo Chamber", "logs"),
    path.join(process.env.TEMP ?? process.cwd(), "EchoChamberLogs")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  bootstrapLog("error", "log_dir_unavailable", { candidates });
  return undefined;
}

function initLogging() {
  const logDir = resolveLogDir();
  if (!logDir) {
    return;
  }

  try {
    const appLogFile = path.join(logDir, "echo-chamber-app.log");
    appLogFilePath = appLogFile;
    try {
      appLogBytes = fs.existsSync(appLogFile) ? fs.statSync(appLogFile).size : 0;
    } catch {
      appLogBytes = 0;
    }
    appLogStream = fs.createWriteStream(appLogFile, { flags: "a" });
    if (!process.env.LOG_DIR) {
      process.env.LOG_DIR = logDir;
    }
    if (!process.env.LOG_FILE) {
      process.env.LOG_FILE = path.join(logDir, "echo-chamber-server.log");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootstrapLog("error", "log_stream_failed", { message, logDir });
  }
}

function appLog(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta ? { meta } : {})
  };
  const line = `${JSON.stringify(entry)}\n`;
  const lineBytes = Buffer.byteLength(line);
  if (level === "error") {
    console.error(message, meta ?? "");
  } else if (level === "warn") {
    console.warn(message, meta ?? "");
  } else {
    console.log(message, meta ?? "");
  }
  if (appLogStream) {
    if (appLogMaxBytes > 0 && appLogFilePath && appLogBytes + lineBytes > appLogMaxBytes) {
      try {
        appLogStream.end();
      } catch {
        // ignore
      }
      try {
        fs.writeFileSync(appLogFilePath, "");
      } catch {
        // ignore
      }
      appLogStream = fs.createWriteStream(appLogFilePath, { flags: "a" });
      appLogBytes = 0;
    }
    appLogStream.write(line);
    appLogBytes += lineBytes;
  } else {
    bootstrapLog(level, message, meta);
  }
}

type ServerModule = typeof import("@echo/server");

type WindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized?: boolean;
};

function loadWindowState(): WindowState | null {
  try {
    if (!fs.existsSync(windowStatePath)) {
      return null;
    }
    const raw = fs.readFileSync(windowStatePath, "utf8");
    const parsed = JSON.parse(raw) as WindowState;
    if (!parsed || typeof parsed.width !== "number" || typeof parsed.height !== "number") {
      return null;
    }
    const displays = screen.getAllDisplays();
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      const visible = displays.some((display) => {
        const bounds = display.workArea;
        return (
          parsed.x! >= bounds.x - 50 &&
          parsed.y! >= bounds.y - 50 &&
          parsed.x! <= bounds.x + bounds.width - 50 &&
          parsed.y! <= bounds.y + bounds.height - 50
        );
      });
      if (!visible) {
        delete parsed.x;
        delete parsed.y;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveWindowState(win: BrowserWindow) {
  try {
    if (win.isMinimized()) {
      return;
    }
    const bounds = win.getBounds();
    const state: WindowState = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: win.isMaximized()
    };
    fs.writeFileSync(windowStatePath, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function scheduleWindowStateSave(win: BrowserWindow) {
  if (windowStateSaveTimer) {
    clearTimeout(windowStateSaveTimer);
  }
  windowStateSaveTimer = setTimeout(() => saveWindowState(win), 200);
}

function wireWindowState(win: BrowserWindow) {
  win.on("resize", () => scheduleWindowStateSave(win));
  win.on("move", () => scheduleWindowStateSave(win));
  win.on("close", () => saveWindowState(win));
}

async function loadServerModule(): Promise<ServerModule> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@echo/server") as ServerModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bootstrapLog("warn", "require_server_failed", { message });
    const mod = (await import("@echo/server")) as ServerModule & { default?: ServerModule };
    return mod.default ?? mod;
  }
}

async function getServerModule(): Promise<ServerModule> {
  if (serverModule) return serverModule;
  serverModule = await loadServerModule();
  return serverModule;
}

function resolveTrayIcon() {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (app.isPackaged && resourcesPath) {
    const packedIcon = path.join(resourcesPath, "assets", "icon.png");
    if (fs.existsSync(packedIcon)) {
      return nativeImage.createFromPath(packedIcon);
    }
  }
  const devIcon = path.join(__dirname, "../build/icon.png");
  if (fs.existsSync(devIcon)) {
    return nativeImage.createFromPath(devIcon);
  }
  return nativeImage.createEmpty();
}

function serverStatusLabel() {
  if (serverStatus === "running") return "Running";
  if (serverStatus === "starting") return "Starting";
  if (serverStatus === "stopping") return "Stopping";
  return "Stopped";
}

function serverUrl() {
  const port = runtimeConfig?.port ?? 5050;
  const protocol = runtimeConfig?.tls ? "https" : "http";
  return `${protocol}://localhost:${port}`;
}

function openAdminUi() {
  void shell.openExternal(serverUrl());
}

function openLogsFolder() {
  const logFile = runtimeConfig?.logFile ?? appLogFilePath;
  if (!logFile) return;
  const dir = path.dirname(logFile);
  void shell.openPath(dir);
}

function updateTrayMenu() {
  if (!tray) return;
  const isRunning = serverStatus === "running";
  const isStarting = serverStatus === "starting";
  const isStopping = serverStatus === "stopping";
  const menu = Menu.buildFromTemplate([
    { label: `Echo Chamber Server (${serverStatusLabel()})`, enabled: false },
    { type: "separator" },
    { label: "Open Admin UI", click: openAdminUi },
    { type: "separator" },
    { label: "Start Server", enabled: !isRunning && !isStarting && !isStopping, click: () => void startServerProcess() },
    { label: "Stop Server", enabled: isRunning, click: () => void stopServerProcess() },
    { label: "Restart Server", enabled: isRunning, click: () => void restartServerProcess() },
    { type: "separator" },
    { label: "Open Logs Folder", click: openLogsFolder },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Echo Chamber (${serverStatusLabel()})`);
}

function createTray() {
  if (tray) return tray;
  const icon = resolveTrayIcon();
  tray = new Tray(icon);
  tray.on("click", openAdminUi);
  updateTrayMenu();
  return tray;
}

async function startServerProcess() {
  if (serverHandle || !runtimeConfig) return;
  serverStatus = "starting";
  updateTrayMenu();
  const {
    port,
    host,
    passwordHash,
    jwtSecret,
    tokenTtlHours,
    adminPasswordHash,
    adminTokenTtlHours,
    tls,
    maxPeersPerRoom,
    serverName,
    logFile
  } = runtimeConfig;
  try {
    const module = await getServerModule();
    const staticDir = app.isPackaged && (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
      ? path.join((process as NodeJS.Process & { resourcesPath?: string }).resourcesPath!, "server", "public")
      : module.resolveStaticDir();
    serverHandle = await module.startServer({
      port,
      host,
      staticDir,
      passwordHash,
      jwtSecret,
      tokenTtlHours,
      adminPasswordHash,
      adminTokenTtlHours,
      tls,
      maxPeersPerRoom,
      serverName,
      logFile
    });
    serverStatus = "running";
    appLog("info", "server_started", { port, tls: Boolean(tls) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    serverStatus = "stopped";
    appLog("error", "server_start_failed", { message });
    dialog.showErrorBox("Echo Chamber failed to start", message);
  } finally {
    updateTrayMenu();
  }
}

async function stopServerProcess() {
  if (!serverHandle) return;
  serverStatus = "stopping";
  updateTrayMenu();
  try {
    await serverHandle.close();
    appLog("info", "server_stopped");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appLog("error", "server_stop_failed", { message });
  } finally {
    serverHandle = undefined;
    serverStatus = "stopped";
    updateTrayMenu();
  }
}

async function restartServerProcess() {
  await stopServerProcess();
  await startServerProcess();
}

async function createWindow(port: number, useHttps: boolean) {
  const savedState = loadWindowState();
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: savedState?.width ?? 1280,
    height: savedState?.height ?? 820,
    backgroundColor: "#0f172a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true
    }
  };
  if (savedState && typeof savedState.x === "number" && typeof savedState.y === "number") {
    windowOptions.x = savedState.x;
    windowOptions.y = savedState.y;
  }
  const win = new BrowserWindow(windowOptions);

  const protocol = useHttps ? "https" : "http";
  await win.loadURL(`${protocol}://localhost:${port}`);
  if (savedState?.isMaximized) {
    win.maximize();
  }
  wireWindowState(win);
  mainWindow = win;
}

function buildPickerHtml(sources: Array<{ id: string; name: string; thumbnail: string }>) {
  const payload = JSON.stringify(sources).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Select a screen</title>
    <style>
      body { font-family: "Segoe UI", system-ui, sans-serif; margin: 0; background: #0f172a; color: #f8fafc; }
      header { padding: 16px 20px; border-bottom: 1px solid #1e293b; }
      h1 { margin: 0; font-size: 18px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; padding: 16px 20px 24px; }
      .card { background: #111827; border: 1px solid #1e293b; border-radius: 12px; overflow: hidden; cursor: pointer; }
      .thumb { width: 100%; height: 140px; background: #0b1220; object-fit: cover; display: block; }
      .label { padding: 10px 12px; font-size: 13px; color: #e2e8f0; }
      .actions { display: flex; justify-content: flex-end; padding: 0 20px 16px; }
      button { background: transparent; border: 1px solid #334155; color: #e2e8f0; border-radius: 10px; padding: 8px 14px; cursor: pointer; }
      button:hover { border-color: #64748b; }
    </style>
  </head>
  <body>
    <header><h1>Select a screen or window to share</h1></header>
    <div class="grid" id="grid"></div>
    <div class="actions"><button id="cancel">Cancel</button></div>
    <script>
      const { ipcRenderer } = require("electron");
      const sources = ${payload};
      const grid = document.getElementById("grid");
      for (const source of sources) {
        const card = document.createElement("div");
        card.className = "card";
        card.dataset.id = source.id;
        card.innerHTML = \`
          <img class="thumb" src="\${source.thumbnail}" alt="" />
          <div class="label">\${source.name}</div>
        \`;
        card.addEventListener("click", () => ipcRenderer.send("screen-picker:selected", source.id));
        grid.appendChild(card);
      }
      document.getElementById("cancel").addEventListener("click", () => ipcRenderer.send("screen-picker:cancel"));
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          ipcRenderer.send("screen-picker:cancel");
        }
      });
    </script>
  </body>
</html>`;
}

async function chooseDisplaySource() {
  if (pickerInFlight) {
    return pickerInFlight;
  }

  pickerInFlight = (async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 360, height: 202 },
      fetchWindowIcons: true
    });
    if (!sources.length) {
      return undefined;
    }

    const pickerWindow = new BrowserWindow({
      width: 820,
      height: 620,
      resizable: true,
      modal: true,
      parent: mainWindow ?? undefined,
      backgroundColor: "#0f172a",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    const sourceCards = sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));

    const html = buildPickerHtml(sourceCards);
    await pickerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    return new Promise<Electron.DesktopCapturerSource | undefined>((resolve) => {
      const cleanup = () => {
        ipcMain.removeAllListeners("screen-picker:selected");
        ipcMain.removeAllListeners("screen-picker:cancel");
      };

      ipcMain.once("screen-picker:selected", (_event, id: string) => {
        cleanup();
        pickerWindow.close();
        resolve(sources.find((source) => source.id === id));
      });

      ipcMain.once("screen-picker:cancel", () => {
        cleanup();
        pickerWindow.close();
        resolve(undefined);
      });

      pickerWindow.on("closed", () => {
        cleanup();
        resolve(undefined);
      });
    });
  })();

  try {
    return await pickerInFlight;
  } finally {
    pickerInFlight = null;
  }
}

function configureCapturePermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_, permission, callback) => {
    if (permission === "media" || permission === "display-capture") {
      callback(true);
      return;
    }
    callback(false);
  });

  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const selected = await chooseDisplaySource();
      if (!selected) {
        appLog("info", "display_media_cancelled");
        callback({});
        return;
      }
      callback({ video: selected });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appLog("error", "display_media_failed", { message });
      callback({});
    }
  });
}

async function start() {
  bootstrapLog("info", "app_bootstrap_start");
  loadEnv();
  ensureConfig();
  initLogging();
  appLog("info", "app_starting", { cwd: process.cwd() });
  configureCapturePermissions();

  const port = Number(process.env.PORT ?? 5050);
  const host = process.env.HOST ?? "0.0.0.0";
  const passwordHash = process.env.AUTH_PASSWORD_HASH ?? "";
  const jwtSecret = process.env.AUTH_JWT_SECRET ?? "";
  const tokenTtlHours = Number(process.env.AUTH_TOKEN_TTL_HOURS ?? 12);
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
  const adminTokenTtlHours = Number(process.env.ADMIN_TOKEN_TTL_HOURS ?? 12);
  const maxPeersPerRoom = process.env.MAX_PEERS_PER_ROOM
    ? Number(process.env.MAX_PEERS_PER_ROOM)
    : undefined;
  const serverName = process.env.SERVER_NAME;

  if (!passwordHash || !jwtSecret) {
    dialog.showErrorBox(
      "Echo Chamber configuration",
      "Missing AUTH_PASSWORD_HASH or AUTH_JWT_SECRET. Set them in a .env file."
    );
    appLog("error", "missing_env", { passwordHash: Boolean(passwordHash), jwtSecret: Boolean(jwtSecret) });
    app.quit();
    return;
  }

  const tlsCertPath = process.env.TLS_CERT_PATH;
  const tlsKeyPath = process.env.TLS_KEY_PATH;
  const tls: TlsOptions | undefined = tlsCertPath && tlsKeyPath ? { certPath: tlsCertPath, keyPath: tlsKeyPath } : undefined;

  runtimeConfig = {
    port,
    host,
    passwordHash,
    jwtSecret,
    tokenTtlHours,
    adminPasswordHash,
    adminTokenTtlHours,
    maxPeersPerRoom,
    serverName,
    logFile: process.env.LOG_FILE,
    tls
  };

  createTray();
  await startServerProcess();
  appLog("info", "app_ready", { port, tls: Boolean(tls) });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  bootstrapLog("warn", "single_instance_lock_failed");
  app.quit();
} else {
  app.on("second-instance", () => {
    openAdminUi();
  });
}

app.whenReady().then(start);

process.on("uncaughtException", (error) => {
  appLog("error", "uncaught_exception", { message: error.message });
  bootstrapLog("error", "uncaught_exception", { message: error.message });
});

process.on("unhandledRejection", (reason) => {
  appLog("error", "unhandled_rejection", { reason: String(reason) });
  bootstrapLog("error", "unhandled_rejection", { reason: String(reason) });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && !trayModeEnabled && !tray) {
    app.quit();
  }
});

app.on("activate", () => {
  openAdminUi();
});

app.on("before-quit", async (event: Event) => {
  if (quitInProgress) {
    return;
  }
  if (serverHandle) {
    event.preventDefault();
    quitInProgress = true;
    await stopServerProcess();
    app.quit();
  }
});
