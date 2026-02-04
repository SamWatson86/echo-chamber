"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const crypto_1 = __importDefault(require("crypto"));
const dotenv_1 = __importDefault(require("dotenv"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const electron_1 = require("electron");
const bootstrapLogPath = path_1.default.join(process.env.TEMP ?? process.cwd(), "echo-chamber-bootstrap.log");
function bootstrapLog(level, message, meta) {
    try {
        const entry = {
            ts: new Date().toISOString(),
            level,
            message,
            ...(meta ? { meta } : {})
        };
        fs_1.default.appendFileSync(bootstrapLogPath, `${JSON.stringify(entry)}\n`);
    }
    catch {
        // Best-effort fallback; avoid crashing on logging failures.
    }
}
function loadEnv() {
    const candidates = [
        path_1.default.resolve(process.cwd(), ".env"),
        path_1.default.resolve(process.cwd(), "apps/server/.env")
    ];
    if (electron_1.app.isPackaged) {
        const resourcesPath = process.resourcesPath;
        if (resourcesPath) {
            candidates.push(path_1.default.join(resourcesPath, "echo-chamber.env"));
        }
        candidates.push(path_1.default.join(electron_1.app.getPath("userData"), "echo-chamber.env"));
        candidates.push(path_1.default.join(electron_1.app.getPath("appData"), "Echo Chamber", "echo-chamber.env"));
    }
    for (const envPath of candidates) {
        dotenv_1.default.config({ path: envPath });
    }
}
function envFilePath() {
    return path_1.default.join(electron_1.app.getPath("userData"), "echo-chamber.env");
}
function parseEnvFile(contents) {
    const env = {};
    const lines = contents.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const idx = trimmed.indexOf("=");
        if (idx <= 0)
            continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1);
        if (key)
            env[key] = value;
    }
    return env;
}
function writeEnvFile(filePath, env) {
    const lines = Object.entries(env).map(([key, value]) => `${key}=${value}`);
    fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
    fs_1.default.writeFileSync(filePath, `${lines.join(os_1.default.EOL)}${os_1.default.EOL}`, "utf8");
}
function generatePassword() {
    return crypto_1.default.randomBytes(9).toString("base64url");
}
function ensureConfig() {
    const filePath = envFilePath();
    const existing = fs_1.default.existsSync(filePath) ? parseEnvFile(fs_1.default.readFileSync(filePath, "utf8")) : {};
    let updated = false;
    let generatedPassword;
    if (!existing.AUTH_PASSWORD_HASH) {
        generatedPassword = generatePassword();
        existing.AUTH_PASSWORD_HASH = bcryptjs_1.default.hashSync(generatedPassword, 10);
        updated = true;
    }
    if (!existing.AUTH_JWT_SECRET) {
        existing.AUTH_JWT_SECRET = crypto_1.default.randomBytes(32).toString("hex");
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
    dotenv_1.default.config({ path: filePath, override: true });
    if (generatedPassword) {
        electron_1.dialog.showMessageBox({
            type: "info",
            title: "Echo Chamber setup",
            message: "A new password has been generated for this host.",
            detail: `Password: ${generatedPassword}\nConfig: ${filePath}`,
            buttons: ["OK"]
        });
    }
}
let serverHandle;
let serverModule = null;
let appLogStream;
let appLogFilePath;
let appLogBytes = 0;
const appLogMaxBytes = (() => {
    const raw = process.env.LOG_MAX_BYTES;
    if (!raw)
        return 5000000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 5000000;
    return parsed;
})();
let mainWindow = null;
let tray = null;
let pickerInFlight = null;
const windowStatePath = path_1.default.join(electron_1.app.getPath("userData"), "window-state.json");
let windowStateSaveTimer = null;
const desktopPrefsPath = path_1.default.join(electron_1.app.getPath("userData"), "desktop-prefs.json");
let quitInProgress = false;
const trayModeEnabled = true;
let serverStatus = "stopped";
let runtimeConfig = null;
function readDesktopPrefs() {
    try {
        if (!fs_1.default.existsSync(desktopPrefsPath))
            return {};
        const raw = fs_1.default.readFileSync(desktopPrefsPath, "utf8");
        const parsed = JSON.parse(raw);
        return {
            password: typeof parsed.password === "string" ? parsed.password : undefined,
            avatar: typeof parsed.avatar === "string" ? parsed.avatar : undefined
        };
    }
    catch {
        return {};
    }
}
function writeDesktopPrefs(prefs) {
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(desktopPrefsPath), { recursive: true });
        fs_1.default.writeFileSync(desktopPrefsPath, JSON.stringify(prefs), "utf8");
    }
    catch {
        // best effort
    }
}
function updateDesktopPrefs(updates) {
    const current = readDesktopPrefs();
    const next = { ...current, ...updates };
    if (typeof next.password !== "string" || next.password.length === 0) {
        delete next.password;
    }
    if (typeof next.avatar !== "string" || next.avatar.length === 0) {
        delete next.avatar;
    }
    writeDesktopPrefs(next);
    return next;
}
electron_1.ipcMain.handle("audio-output:supported", (event) => {
    const sender = event.sender;
    return typeof sender.setAudioOutputDevice === "function";
});
electron_1.ipcMain.handle("audio-output:set", async (event, deviceId) => {
    const sinkId = deviceId && deviceId.length > 0 ? deviceId : "default";
    const sender = event.sender;
    if (typeof sender.setAudioOutputDevice !== "function") {
        appLog("warn", "audio_output_unsupported");
        return false;
    }
    await sender.setAudioOutputDevice(sinkId);
    appLog("info", "audio_output_set", { sinkId });
    return true;
});
electron_1.ipcMain.handle("app:restart", async () => {
    electron_1.app.relaunch();
    electron_1.app.exit(0);
    return true;
});
electron_1.ipcMain.handle("desktop:prefs:get", () => readDesktopPrefs());
electron_1.ipcMain.handle("desktop:prefs:set", (event, updates) => {
    const safeUpdates = {};
    if (updates && typeof updates.password === "string") {
        safeUpdates.password = updates.password;
    }
    if (updates && typeof updates.avatar === "string") {
        safeUpdates.avatar = updates.avatar;
    }
    return updateDesktopPrefs(safeUpdates);
});
function resolveLogDir() {
    const candidates = [
        process.env.LOG_DIR,
        path_1.default.join(electron_1.app.getPath("userData"), "logs"),
        path_1.default.join(electron_1.app.getPath("appData"), "Echo Chamber", "logs"),
        path_1.default.join(process.env.TEMP ?? process.cwd(), "EchoChamberLogs")
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            fs_1.default.mkdirSync(candidate, { recursive: true });
            return candidate;
        }
        catch {
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
        const appLogFile = path_1.default.join(logDir, "echo-chamber-app.log");
        appLogFilePath = appLogFile;
        try {
            appLogBytes = fs_1.default.existsSync(appLogFile) ? fs_1.default.statSync(appLogFile).size : 0;
        }
        catch {
            appLogBytes = 0;
        }
        appLogStream = fs_1.default.createWriteStream(appLogFile, { flags: "a" });
        if (!process.env.LOG_DIR) {
            process.env.LOG_DIR = logDir;
        }
        if (!process.env.LOG_FILE) {
            process.env.LOG_FILE = path_1.default.join(logDir, "echo-chamber-server.log");
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bootstrapLog("error", "log_stream_failed", { message, logDir });
    }
}
function appLog(level, message, meta) {
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
    }
    else if (level === "warn") {
        console.warn(message, meta ?? "");
    }
    else {
        console.log(message, meta ?? "");
    }
    if (appLogStream) {
        if (appLogMaxBytes > 0 && appLogFilePath && appLogBytes + lineBytes > appLogMaxBytes) {
            try {
                appLogStream.end();
            }
            catch {
                // ignore
            }
            try {
                fs_1.default.writeFileSync(appLogFilePath, "");
            }
            catch {
                // ignore
            }
            appLogStream = fs_1.default.createWriteStream(appLogFilePath, { flags: "a" });
            appLogBytes = 0;
        }
        appLogStream.write(line);
        appLogBytes += lineBytes;
    }
    else {
        bootstrapLog(level, message, meta);
    }
}
function loadWindowState() {
    try {
        if (!fs_1.default.existsSync(windowStatePath)) {
            return null;
        }
        const raw = fs_1.default.readFileSync(windowStatePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.width !== "number" || typeof parsed.height !== "number") {
            return null;
        }
        const displays = electron_1.screen.getAllDisplays();
        if (typeof parsed.x === "number" && typeof parsed.y === "number") {
            const visible = displays.some((display) => {
                const bounds = display.workArea;
                return (parsed.x >= bounds.x - 50 &&
                    parsed.y >= bounds.y - 50 &&
                    parsed.x <= bounds.x + bounds.width - 50 &&
                    parsed.y <= bounds.y + bounds.height - 50);
            });
            if (!visible) {
                delete parsed.x;
                delete parsed.y;
            }
        }
        return parsed;
    }
    catch {
        return null;
    }
}
function saveWindowState(win) {
    try {
        if (win.isMinimized()) {
            return;
        }
        const bounds = win.getBounds();
        const state = {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y,
            isMaximized: win.isMaximized()
        };
        fs_1.default.writeFileSync(windowStatePath, JSON.stringify(state));
    }
    catch {
        // ignore
    }
}
function scheduleWindowStateSave(win) {
    if (windowStateSaveTimer) {
        clearTimeout(windowStateSaveTimer);
    }
    windowStateSaveTimer = setTimeout(() => saveWindowState(win), 200);
}
function wireWindowState(win) {
    win.on("resize", () => scheduleWindowStateSave(win));
    win.on("move", () => scheduleWindowStateSave(win));
    win.on("close", () => saveWindowState(win));
}
async function loadServerModule() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("@echo/server");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        bootstrapLog("warn", "require_server_failed", { message });
        const mod = (await Promise.resolve().then(() => __importStar(require("@echo/server"))));
        return mod.default ?? mod;
    }
}
async function getServerModule() {
    if (serverModule)
        return serverModule;
    serverModule = await loadServerModule();
    return serverModule;
}
function resolveTrayIcon() {
    const resourcesPath = process.resourcesPath;
    if (electron_1.app.isPackaged && resourcesPath) {
        const packedIcon = path_1.default.join(resourcesPath, "assets", "icon.png");
        if (fs_1.default.existsSync(packedIcon)) {
            return electron_1.nativeImage.createFromPath(packedIcon);
        }
    }
    const devIcon = path_1.default.join(__dirname, "../build/icon.png");
    if (fs_1.default.existsSync(devIcon)) {
        return electron_1.nativeImage.createFromPath(devIcon);
    }
    return electron_1.nativeImage.createEmpty();
}
function serverStatusLabel() {
    if (serverStatus === "running")
        return "Running";
    if (serverStatus === "starting")
        return "Starting";
    if (serverStatus === "stopping")
        return "Stopping";
    return "Stopped";
}
function serverUrl() {
    const port = runtimeConfig?.port ?? 5050;
    const protocol = runtimeConfig?.tls ? "https" : "http";
    return `${protocol}://localhost:${port}`;
}
function openAdminUi() {
    void electron_1.shell.openExternal(serverUrl());
}
function openLogsFolder() {
    const logFile = runtimeConfig?.logFile ?? appLogFilePath;
    if (!logFile)
        return;
    const dir = path_1.default.dirname(logFile);
    void electron_1.shell.openPath(dir);
}
function updateTrayMenu() {
    if (!tray)
        return;
    const isRunning = serverStatus === "running";
    const isStarting = serverStatus === "starting";
    const isStopping = serverStatus === "stopping";
    const menu = electron_1.Menu.buildFromTemplate([
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
        { label: "Quit", click: () => electron_1.app.quit() }
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`Echo Chamber (${serverStatusLabel()})`);
}
function createTray() {
    if (tray)
        return tray;
    const icon = resolveTrayIcon();
    tray = new electron_1.Tray(icon);
    tray.on("click", openAdminUi);
    updateTrayMenu();
    return tray;
}
async function startServerProcess() {
    if (serverHandle || !runtimeConfig)
        return;
    serverStatus = "starting";
    updateTrayMenu();
    const { port, host, passwordHash, jwtSecret, tokenTtlHours, adminPasswordHash, adminTokenTtlHours, tls, maxPeersPerRoom, serverName, logFile } = runtimeConfig;
    try {
        const module = await getServerModule();
        const staticDir = electron_1.app.isPackaged && process.resourcesPath
            ? path_1.default.join(process.resourcesPath, "server", "public")
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
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        serverStatus = "stopped";
        appLog("error", "server_start_failed", { message });
        electron_1.dialog.showErrorBox("Echo Chamber failed to start", message);
    }
    finally {
        updateTrayMenu();
    }
}
async function stopServerProcess() {
    if (!serverHandle)
        return;
    serverStatus = "stopping";
    updateTrayMenu();
    try {
        await serverHandle.close();
        appLog("info", "server_stopped");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appLog("error", "server_stop_failed", { message });
    }
    finally {
        serverHandle = undefined;
        serverStatus = "stopped";
        updateTrayMenu();
    }
}
async function restartServerProcess() {
    await stopServerProcess();
    await startServerProcess();
}
async function createWindow(port, useHttps) {
    const savedState = loadWindowState();
    const windowOptions = {
        width: savedState?.width ?? 1280,
        height: savedState?.height ?? 820,
        backgroundColor: "#0f172a",
        webPreferences: {
            preload: path_1.default.join(__dirname, "preload.js"),
            contextIsolation: true,
            sandbox: true
        }
    };
    if (savedState && typeof savedState.x === "number" && typeof savedState.y === "number") {
        windowOptions.x = savedState.x;
        windowOptions.y = savedState.y;
    }
    const win = new electron_1.BrowserWindow(windowOptions);
    const protocol = useHttps ? "https" : "http";
    await win.loadURL(`${protocol}://localhost:${port}`);
    if (savedState?.isMaximized) {
        win.maximize();
    }
    wireWindowState(win);
    mainWindow = win;
}
function buildPickerHtml(sources) {
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
        const sources = await electron_1.desktopCapturer.getSources({
            types: ["screen", "window"],
            thumbnailSize: { width: 360, height: 202 },
            fetchWindowIcons: true
        });
        if (!sources.length) {
            return undefined;
        }
        const pickerWindow = new electron_1.BrowserWindow({
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
        return new Promise((resolve) => {
            const cleanup = () => {
                electron_1.ipcMain.removeAllListeners("screen-picker:selected");
                electron_1.ipcMain.removeAllListeners("screen-picker:cancel");
            };
            electron_1.ipcMain.once("screen-picker:selected", (_event, id) => {
                cleanup();
                pickerWindow.close();
                resolve(sources.find((source) => source.id === id));
            });
            electron_1.ipcMain.once("screen-picker:cancel", () => {
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
    }
    finally {
        pickerInFlight = null;
    }
}
function configureCapturePermissions() {
    const ses = electron_1.session.defaultSession;
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
        }
        catch (error) {
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
        electron_1.dialog.showErrorBox("Echo Chamber configuration", "Missing AUTH_PASSWORD_HASH or AUTH_JWT_SECRET. Set them in a .env file.");
        appLog("error", "missing_env", { passwordHash: Boolean(passwordHash), jwtSecret: Boolean(jwtSecret) });
        electron_1.app.quit();
        return;
    }
    const tlsCertPath = process.env.TLS_CERT_PATH;
    const tlsKeyPath = process.env.TLS_KEY_PATH;
    const tls = tlsCertPath && tlsKeyPath ? { certPath: tlsCertPath, keyPath: tlsKeyPath } : undefined;
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
const gotLock = electron_1.app.requestSingleInstanceLock();
if (!gotLock) {
    bootstrapLog("warn", "single_instance_lock_failed");
    electron_1.app.quit();
}
else {
    electron_1.app.on("second-instance", () => {
        openAdminUi();
    });
}
electron_1.app.whenReady().then(start);
process.on("uncaughtException", (error) => {
    appLog("error", "uncaught_exception", { message: error.message });
    bootstrapLog("error", "uncaught_exception", { message: error.message });
});
process.on("unhandledRejection", (reason) => {
    appLog("error", "unhandled_rejection", { reason: String(reason) });
    bootstrapLog("error", "unhandled_rejection", { reason: String(reason) });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin" && !trayModeEnabled && !tray) {
        electron_1.app.quit();
    }
});
electron_1.app.on("activate", () => {
    openAdminUi();
});
electron_1.app.on("before-quit", async (event) => {
    if (quitInProgress) {
        return;
    }
    if (serverHandle) {
        event.preventDefault();
        quitInProgress = true;
        await stopServerProcess();
        electron_1.app.quit();
    }
});
