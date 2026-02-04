import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { signToken, verifyPassword, verifyToken, isAdminPayload } from "./auth.js";
import { createLogger } from "./logger.js";

export type TlsOptions = {
  keyPath: string;
  certPath: string;
};

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type ServerOptions = {
  port: number;
  host: string;
  staticDir: string;
  passwordHash: string;
  jwtSecret: string;
  tokenTtlHours?: number;
  adminPasswordHash?: string;
  adminTokenTtlHours?: number;
  tls?: TlsOptions;
  iceServers?: IceServer[];
  maxPeersPerRoom?: number;
  serverName?: string;
  logFile?: string;
  soundboardDir?: string;
  soundboardMaxBytes?: number;
  soundboardMaxSoundsPerRoom?: number;
};

export type ServerHandle = {
  httpServer: http.Server | https.Server;
  close: () => Promise<void>;
};

type Peer = {
  id: string;
  name: string;
  roomId: string;
  ws: WebSocket;
  avatar?: string;
};

type SoundboardSound = {
  id: string;
  roomId: string;
  name: string;
  icon: string;
  volume: number;
  fileName: string;
  mime: string;
  size: number;
  uploadedAt: number;
  uploadedBy: {
    id: string;
    name: string;
  };
};

const loginSchema = z.object({
  password: z.string().min(1)
});

const joinSchema = z.object({
  type: z.literal("join"),
  roomId: z.string().min(1),
  displayName: z.string().min(1).max(64),
  avatar: z.string().max(6_000_000).optional()
});

const signalSchema = z.object({
  type: z.literal("signal"),
  to: z.string().min(1),
  data: z.any()
});

const updateSchema = z.object({
  type: z.literal("update"),
  displayName: z.string().min(1).max(64),
  avatar: z.string().max(6_000_000).optional()
});

const leaveSchema = z.object({
  type: z.literal("leave")
});

const pingSchema = z.object({
  type: z.literal("ping")
});

const trackMetaSchema = z.object({
  type: z.literal("track-meta"),
  trackId: z.string().min(1),
  mediaType: z.enum(["mic", "screenAudio", "screen", "camera"]),
  streamId: z.string().min(1).optional()
});

const trackEndedSchema = z.object({
  type: z.literal("track-ended"),
  trackId: z.string().min(1),
  mediaType: z.enum(["mic", "screenAudio", "screen", "camera"]).optional()
});

const clientLogSchema = z.object({
  type: z.literal("client-log"),
  level: z.enum(["info", "warn", "error"]),
  message: z.string().min(1).max(200),
  meta: z.record(z.any()).optional()
});

const soundPlaySchema = z.object({
  type: z.literal("sound-play"),
  soundId: z.string().min(1)
});

const messageSchema = z.discriminatedUnion("type", [
  joinSchema,
  signalSchema,
  updateSchema,
  leaveSchema,
  pingSchema,
  trackMetaSchema,
  trackEndedSchema,
  clientLogSchema,
  soundPlaySchema
]);

const rooms = new Map<string, Map<string, Peer>>();
const soundboard = new Map<string, Map<string, SoundboardSound>>();
const soundboardIndex = new Map<string, SoundboardSound>();

function sanitizeRoomKey(roomId: string) {
  return roomId.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "main";
}

function resolveSoundboardRoom(roomId: string): Map<string, SoundboardSound> {
  let room = soundboard.get(roomId);
  if (!room) {
    room = new Map();
    soundboard.set(roomId, room);
  }
  return room;
}

function resolveRoom(roomId: string): Map<string, Peer> {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Map();
    rooms.set(roomId, room);
  }
  return room;
}

function send(ws: WebSocket, message: unknown) {
  ws.send(JSON.stringify(message));
}

function currentRoomsList() {
  return Array.from(rooms.entries())
    .filter(([, room]) => room.size > 0)
    .map(([id, room]) => ({ id, count: room.size }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function currentRoomsDetail() {
  return Array.from(rooms.entries())
    .filter(([, room]) => room.size > 0)
    .map(([id, room]) => ({
      id,
      count: room.size,
      peers: Array.from(room.values()).map((peer) => ({
        id: peer.id,
        name: peer.name,
        avatar: peer.avatar
      }))
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function broadcast(room: Map<string, Peer>, message: unknown, excludeId?: string) {
  for (const peer of room.values()) {
    if (excludeId && peer.id === excludeId) continue;
    send(peer.ws, message);
  }
}

function getTokenFromRequest(req: express.Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  if (typeof req.query.token === "string") return req.query.token;
  return null;
}

function getTokenFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.searchParams.get("token");
  } catch {
    return null;
  }
}

export function resolveStaticDir(): string {
  return path.resolve(__dirname, "../public");
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  const {
    port,
    host,
    staticDir,
    passwordHash,
    jwtSecret,
    tokenTtlHours = 12,
    adminPasswordHash,
    adminTokenTtlHours = 12,
    tls,
    iceServers = [{ urls: "stun:stun.l.google.com:19302" }],
    maxPeersPerRoom,
    serverName = "Echo Chamber",
    logFile,
    soundboardDir,
    soundboardMaxBytes = 8 * 1024 * 1024,
    soundboardMaxSoundsPerRoom = 60
  } = options;

  const logger = createLogger(logFile);
  logger.info("server_starting", { port, host, tls: Boolean(tls) });

  if (!passwordHash) {
    throw new Error("AUTH_PASSWORD_HASH is required.");
  }
  if (!jwtSecret) {
    throw new Error("AUTH_JWT_SECRET is required.");
  }

  const app = express();
  app.set("etag", false);
  app.disable("x-powered-by");
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "same-site" }
    })
  );
  app.use(express.json());

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      next();
      return;
    }
    const start = Date.now();
    res.on("finish", () => {
      logger.info("http_request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - start,
        ip: req.socket.remoteAddress
      });
    });
    next();
  });

  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false
  });

  const adminLimiter = rateLimit({
    windowMs: 60_000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false
  });

  const adminEnabled = Boolean(adminPasswordHash);
  const startedAt = Date.now();
  const resolvedSoundboardDir = soundboardDir ?? path.resolve(process.cwd(), "logs", "soundboard");
  const soundboardMetaFile = path.join(resolvedSoundboardDir, "soundboard.json");

  fs.mkdirSync(resolvedSoundboardDir, { recursive: true });

  function soundboardFilePath(roomId: string, fileName: string) {
    const roomKey = sanitizeRoomKey(roomId);
    return path.join(resolvedSoundboardDir, roomKey, fileName);
  }

  function persistSoundboard() {
    try {
      const sounds = Array.from(soundboardIndex.values()).map((sound) => ({
        id: sound.id,
        roomId: sound.roomId,
        name: sound.name,
        icon: sound.icon,
        volume: sound.volume,
        fileName: sound.fileName,
        mime: sound.mime,
        size: sound.size,
        uploadedAt: sound.uploadedAt,
        uploadedBy: sound.uploadedBy
      }));
      fs.writeFileSync(soundboardMetaFile, JSON.stringify(sounds, null, 2), "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("soundboard_persist_failed", { message });
    }
  }

  function loadSoundboard() {
    try {
      if (!fs.existsSync(soundboardMetaFile)) return;
      const contents = fs.readFileSync(soundboardMetaFile, "utf8");
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) return;
      for (const rawSound of parsed) {
        if (!rawSound || typeof rawSound !== "object") continue;
        const sound = rawSound as Partial<SoundboardSound>;
        if (
          !sound.id ||
          !sound.roomId ||
          !sound.name ||
          !sound.fileName ||
          !sound.mime ||
          typeof sound.size !== "number" ||
          typeof sound.uploadedAt !== "number"
        ) {
          continue;
        }
        const roomId = String(sound.roomId);
        const fileName = String(sound.fileName);
        const filePath = soundboardFilePath(roomId, fileName);
        if (!fs.existsSync(filePath)) continue;
        const loaded: SoundboardSound = {
          id: String(sound.id),
          roomId,
          name: String(sound.name),
          icon: String(sound.icon ?? "\u{1F50A}"),
          volume:
            typeof sound.volume === "number" && Number.isFinite(sound.volume)
              ? Math.min(200, Math.max(0, Math.round(sound.volume)))
              : 100,
          fileName,
          mime: String(sound.mime),
          size: sound.size,
          uploadedAt: sound.uploadedAt,
          uploadedBy: {
            id: String(sound.uploadedBy?.id ?? "unknown"),
            name: String(sound.uploadedBy?.name ?? "Guest")
          }
        };
        resolveSoundboardRoom(roomId).set(loaded.id, loaded);
        soundboardIndex.set(loaded.id, loaded);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("soundboard_load_failed", { message });
    }
  }

  loadSoundboard();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/login", loginLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }

    const ok = await verifyPassword(parsed.data.password, passwordHash);
    if (!ok) {
      logger.warn("login_failed", { ip: req.socket.remoteAddress });
      res.status(401).json({ ok: false, error: "Invalid password" });
      return;
    }

    const token = signToken(jwtSecret, tokenTtlHours, "room");
    res.json({ ok: true, token, expiresInHours: tokenTtlHours });
  });

  app.post("/api/admin/login", adminLimiter, async (req, res) => {
    if (!adminEnabled || !adminPasswordHash) {
      res.status(404).json({ ok: false, error: "Admin disabled" });
      return;
    }
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }

    const ok = await verifyPassword(parsed.data.password, adminPasswordHash);
    if (!ok) {
      logger.warn("admin_login_failed", { ip: req.socket.remoteAddress });
      res.status(401).json({ ok: false, error: "Invalid password" });
      return;
    }

    const token = signToken(jwtSecret, adminTokenTtlHours, "admin");
    logger.info("admin_login_ok", { ip: req.socket.remoteAddress });
    res.json({ ok: true, token, expiresInHours: adminTokenTtlHours });
  });

  app.get("/api/config", (req, res) => {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Missing token" });
      return;
    }

    try {
      verifyToken(token, jwtSecret);
      res.json({ ok: true, iceServers, maxPeersPerRoom, serverName, adminEnabled });
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
    }
  });

  app.get("/api/me", (req, res) => {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Missing token" });
      return;
    }

    try {
      verifyToken(token, jwtSecret);
      res.json({ ok: true });
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
    }
  });

  app.post("/api/logout", (_req, res) => {
    res.json({ ok: true });
  });

  function requireToken(req: express.Request, res: express.Response): boolean {
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Missing token" });
      return false;
    }
    try {
      verifyToken(token, jwtSecret);
      return true;
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
      return false;
    }
  }

  function requireAdmin(req: express.Request, res: express.Response): boolean {
    if (!adminEnabled) {
      res.status(404).json({ ok: false, error: "Admin disabled" });
      return false;
    }
    const token = getTokenFromRequest(req);
    if (!token) {
      res.status(401).json({ ok: false, error: "Missing token" });
      return false;
    }
    try {
      const payload = verifyToken(token, jwtSecret);
      if (!isAdminPayload(payload)) {
        res.status(403).json({ ok: false, error: "Forbidden" });
        return false;
      }
      return true;
    } catch {
      res.status(401).json({ ok: false, error: "Invalid token" });
      return false;
    }
  }

  app.get("/api/admin/status", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const roomsDetail = currentRoomsDetail();
    const totalPeers = roomsDetail.reduce((sum, room) => sum + room.count, 0);
    res.json({
      ok: true,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      rooms: roomsDetail,
      totalRooms: roomsDetail.length,
      totalPeers
    });
  });

  app.get("/api/admin/logs", (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!logFile) {
      res.status(404).json({ ok: false, error: "Log file not configured" });
      return;
    }
    const rawLines = Number(req.query.lines ?? 200);
    const lines = Number.isFinite(rawLines) ? Math.min(Math.max(rawLines, 20), 500) : 200;
    try {
      const contents = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
      const split = contents.trim().split(/\r?\n/);
      const tail = split.slice(-lines);
      res.json({ ok: true, lines: tail });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ ok: false, error: message });
    }
  });

  app.post("/api/admin/restart", (req, res) => {
    if (!requireAdmin(req, res)) return;
    logger.warn("admin_restart_requested", { ip: req.socket.remoteAddress });
    for (const client of wss.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          send(client, { type: "error", message: "Server restarting. Please reconnect." });
          client.close(1012, "Server restart");
        }
      } catch {
        // ignore
      }
    }
    rooms.clear();
    res.json({ ok: true });
  });

  const adminKickSchema = z
    .object({
      peerId: z.string().min(1).optional(),
      roomId: z.string().min(1).optional()
    })
    .refine((data) => Boolean(data.peerId || data.roomId), {
      message: "peerId or roomId required"
    });

  app.post("/api/admin/kick", (req, res) => {
    if (!requireAdmin(req, res)) return;
    const parsed = adminKickSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }
    let kicked = 0;
    let roomCleared: string | null = null;
    if (parsed.data.roomId) {
      const room = rooms.get(parsed.data.roomId);
      if (room) {
        for (const peer of room.values()) {
          try {
            send(peer.ws, { type: "error", message: "You were disconnected by the host." });
            peer.ws.close(4001, "Admin kick");
          } catch {
            // ignore
          }
          kicked += 1;
        }
        rooms.delete(parsed.data.roomId);
        roomCleared = parsed.data.roomId;
        broadcastRooms();
      }
      res.json({ ok: true, kicked, roomId: roomCleared });
      return;
    }

    if (parsed.data.peerId) {
      for (const [roomId, room] of rooms.entries()) {
        const peer = room.get(parsed.data.peerId);
        if (!peer) continue;
        room.delete(parsed.data.peerId);
        broadcast(room, { type: "peer-left", id: parsed.data.peerId });
        if (room.size === 0) {
          rooms.delete(roomId);
        }
        try {
          send(peer.ws, { type: "error", message: "You were disconnected by the host." });
          peer.ws.close(4001, "Admin kick");
        } catch {
          // ignore
        }
        kicked = 1;
        broadcastRooms();
        res.json({ ok: true, kicked, roomId });
        return;
      }
    }

    res.json({ ok: true, kicked });
  });

  const soundboardListSchema = z.object({
    roomId: z.string().min(1).max(64)
  });

  const soundboardUploadSchema = z.object({
    roomId: z.string().min(1).max(64),
    peerId: z.string().min(1),
    name: z.string().min(1).max(60),
    icon: z.string().min(1).max(12),
    volume: z.coerce.number().min(0).max(200).default(100)
  });

  const soundboardUpdateSchema = z.object({
    roomId: z.string().min(1).max(64),
    peerId: z.string().min(1),
    soundId: z.string().min(1),
    name: z.string().min(1).max(60),
    icon: z.string().min(1).max(12),
    volume: z.coerce.number().min(0).max(200).optional()
  });

  function soundboardPublic(sound: SoundboardSound) {
    return {
      id: sound.id,
      roomId: sound.roomId,
      name: sound.name,
      icon: sound.icon,
      volume: sound.volume,
      mime: sound.mime,
      size: sound.size,
      uploadedAt: sound.uploadedAt,
      uploadedBy: sound.uploadedBy
    };
  }

  function extensionFromMime(mime: string) {
    const normalized = mime.toLowerCase().split(";")[0].trim();
    if (normalized === "audio/mpeg") return ".mp3";
    if (normalized === "audio/mp4") return ".m4a";
    if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return ".wav";
    if (normalized === "audio/ogg") return ".ogg";
    if (normalized === "audio/webm") return ".webm";
    if (normalized === "audio/aac") return ".aac";
    return ".bin";
  }

  const soundboardRawParser = express.raw({
    type: (req) => {
      const contentType = req.headers["content-type"];
      if (typeof contentType !== "string") return false;
      return contentType.toLowerCase().startsWith("audio/") || contentType.toLowerCase() === "application/octet-stream";
    },
    limit: soundboardMaxBytes
  });

  app.get("/api/soundboard/list", (req, res) => {
    if (!requireToken(req, res)) return;
    const parsed = soundboardListSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }
    const roomId = parsed.data.roomId;
    const roomSounds = soundboard.get(roomId);
    const sounds = roomSounds ? Array.from(roomSounds.values()) : [];
    sounds.sort((a, b) => b.uploadedAt - a.uploadedAt);
    res.json({ ok: true, sounds: sounds.map(soundboardPublic) });
  });

  app.get("/api/soundboard/file/:soundId", (req, res) => {
    if (!requireToken(req, res)) return;
    const sound = soundboardIndex.get(req.params.soundId);
    if (!sound) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    const filePath = soundboardFilePath(sound.roomId, sound.fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=31536000");
    res.type(sound.mime);
    res.sendFile(filePath);
  });

  app.post("/api/soundboard/upload", soundboardRawParser, (req, res) => {
    if (!requireToken(req, res)) return;
    const parsed = soundboardUploadSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }
    const { roomId, peerId, name, icon, volume } = parsed.data;
    const room = rooms.get(roomId);
    const peer = room?.get(peerId);
    if (!room || !peer) {
      res.status(403).json({ ok: false, error: "Must be connected to the room to upload" });
      return;
    }

    const roomSounds = resolveSoundboardRoom(roomId);
    if (roomSounds.size >= soundboardMaxSoundsPerRoom) {
      res.status(400).json({ ok: false, error: "Soundboard is full for this room" });
      return;
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ ok: false, error: "Missing audio payload" });
      return;
    }

    const mime = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream";
    const ext = extensionFromMime(mime);
    const id = randomUUID();
    const fileName = `${id}${ext}`;
    const filePath = soundboardFilePath(roomId, fileName);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body);

    const sound: SoundboardSound = {
      id,
      roomId,
      name,
      icon,
      volume,
      fileName,
      mime,
      size: body.length,
      uploadedAt: Date.now(),
      uploadedBy: { id: peer.id, name: peer.name }
    };

    roomSounds.set(id, sound);
    soundboardIndex.set(id, sound);
    persistSoundboard();

    logger.info("sound_uploaded", { roomId, peerId, soundId: id, size: body.length, volume });
    broadcast(room, { type: "sound-added", sound: soundboardPublic(sound) });
    res.json({ ok: true, sound: soundboardPublic(sound) });
  });

  app.post("/api/soundboard/update", (req, res) => {
    if (!requireToken(req, res)) return;
    const parsed = soundboardUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid payload" });
      return;
    }

    const { roomId, peerId, soundId, name, icon, volume } = parsed.data;
    const room = rooms.get(roomId);
    const peer = room?.get(peerId);
    if (!room || !peer) {
      res.status(403).json({ ok: false, error: "Must be connected to the room to edit" });
      return;
    }

    const sound = soundboardIndex.get(soundId);
    if (!sound || sound.roomId !== roomId) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }

    sound.name = name;
    sound.icon = icon;
    if (typeof volume === "number" && Number.isFinite(volume)) {
      sound.volume = Math.min(200, Math.max(0, Math.round(volume)));
    }
    persistSoundboard();

    logger.info("sound_updated", { roomId, peerId, soundId });
    broadcast(room, { type: "sound-updated", sound: soundboardPublic(sound) });
    res.json({ ok: true, sound: soundboardPublic(sound) });
  });

  app.use(express.static(staticDir));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const server = tls
    ? https.createServer(
        {
          key: fs.readFileSync(tls.keyPath),
          cert: fs.readFileSync(tls.certPath)
        },
        app
      )
    : http.createServer(app);

  const wss = new WebSocketServer({ noServer: true });

  function broadcastRooms() {
    const payload = { type: "rooms", rooms: currentRoomsList() };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        send(client, payload);
      }
    });
  }

  server.on("upgrade", (req, socket, head) => {
    const token = getTokenFromUrl(req.url);
    if (!token) {
      logger.warn("ws_upgrade_missing_token", { ip: req.socket.remoteAddress });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      verifyToken(token, jwtSecret);
    } catch {
      logger.warn("ws_upgrade_invalid_token", { ip: req.socket.remoteAddress });
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    const peerId = randomUUID();
    let currentRoom: Map<string, Peer> | null = null;
    let currentRoomId: string | null = null;

    logger.info("ws_connected", { peerId, ip: req.socket.remoteAddress });
    send(ws, { type: "welcome", peerId });
    send(ws, { type: "rooms", rooms: currentRoomsList() });

    ws.on("message", (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        logger.warn("ws_invalid_message", { peerId });
        return;
      }

      const parsedResult = messageSchema.safeParse(raw);
      if (!parsedResult.success) {
        logger.warn("ws_invalid_message", { peerId });
        return;
      }
      const parsed = parsedResult.data;

      if (parsed.type === "ping") {
        send(ws, { type: "pong", at: Date.now() });
        return;
      }

      if (parsed.type === "join") {
        if (currentRoom) {
          return;
        }

        currentRoomId = parsed.roomId;
        currentRoom = resolveRoom(parsed.roomId);
        if (typeof maxPeersPerRoom === "number" && maxPeersPerRoom > 0 && currentRoom.size >= maxPeersPerRoom) {
          send(ws, { type: "error", message: "Room is full. Ask the host to open another room." });
          ws.close(1008, "Room full");
          currentRoom = null;
          currentRoomId = null;
          return;
        }
        const peer: Peer = {
          id: peerId,
          name: parsed.displayName,
          roomId: parsed.roomId,
          ws,
          avatar: parsed.avatar
        };

        const existingPeers = Array.from(currentRoom.values()).map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar
        }));

        currentRoom.set(peerId, peer);
        logger.info("ws_joined", { peerId, roomId: parsed.roomId, name: parsed.displayName });

        send(ws, {
          type: "joined",
          peerId,
          roomId: parsed.roomId,
          peers: existingPeers
        });

        broadcast(
          currentRoom,
          { type: "peer-joined", id: peerId, name: parsed.displayName, avatar: parsed.avatar },
          peerId
        );
        broadcastRooms();
        return;
      }

      if (parsed.type === "update") {
        if (!currentRoom || !currentRoomId) return;
        const peer = currentRoom.get(peerId);
        if (!peer) return;
        peer.name = parsed.displayName;
        if (parsed.avatar !== undefined) {
          peer.avatar = parsed.avatar;
        }
        broadcast(
          currentRoom,
          { type: "peer-updated", id: peerId, name: parsed.displayName, avatar: peer.avatar },
          peerId
        );
        return;
      }

      if (parsed.type === "track-meta") {
        if (!currentRoom) return;
        logger.info("ws_track_meta", {
          peerId,
          roomId: currentRoomId ?? undefined,
          trackId: parsed.trackId,
          mediaType: parsed.mediaType
        });
        broadcast(
          currentRoom,
          {
            type: "track-meta",
            peerId,
            trackId: parsed.trackId,
            mediaType: parsed.mediaType,
            ...(parsed.streamId ? { streamId: parsed.streamId } : {})
          },
          peerId
        );
        return;
      }

      if (parsed.type === "track-ended") {
        if (!currentRoom) return;
        logger.info("ws_track_ended", {
          peerId,
          roomId: currentRoomId ?? undefined,
          trackId: parsed.trackId,
          mediaType: parsed.mediaType
        });
        broadcast(
          currentRoom,
          {
            type: "track-ended",
            peerId,
            trackId: parsed.trackId,
            mediaType: parsed.mediaType
          },
          peerId
        );
        return;
      }

      if (parsed.type === "client-log") {
        const payload = {
          peerId,
          roomId: currentRoomId ?? undefined,
          message: parsed.message,
          meta: parsed.meta
        };
        if (parsed.level === "error") {
          logger.error("client_log", payload);
        } else if (parsed.level === "warn") {
          logger.warn("client_log", payload);
        } else {
          logger.info("client_log", payload);
        }
        return;
      }

      if (parsed.type === "signal") {
        if (!currentRoom) return;
        const target = currentRoom.get(parsed.to);
        if (!target) return;
        if (parsed.data?.type === "offer" || parsed.data?.type === "answer") {
          logger.debug("ws_signal", {
            peerId,
            roomId: currentRoomId ?? undefined,
            to: parsed.to,
            signalType: parsed.data.type
          });
        }
        send(target.ws, { type: "signal", from: peerId, data: parsed.data });
        return;
      }

      if (parsed.type === "sound-play") {
        if (!currentRoom || !currentRoomId) return;
        const sound = soundboardIndex.get(parsed.soundId);
        if (!sound || sound.roomId !== currentRoomId) return;
        const sender = currentRoom.get(peerId);
        logger.info("ws_sound_play", { peerId, roomId: currentRoomId, soundId: parsed.soundId });
        broadcast(currentRoom, {
          type: "sound-play",
          soundId: parsed.soundId,
          at: Date.now(),
          by: { id: peerId, name: sender?.name ?? "Guest" }
        });
        return;
      }

      if (parsed.type === "leave") {
        if (currentRoom) {
          currentRoom.delete(peerId);
          broadcast(currentRoom, { type: "peer-left", id: peerId });
          if (currentRoom.size === 0 && currentRoomId) {
            rooms.delete(currentRoomId);
          }
        }
        currentRoom = null;
        currentRoomId = null;
        broadcastRooms();
      }
    });

    ws.on("close", () => {
      if (currentRoom) {
        currentRoom.delete(peerId);
        broadcast(currentRoom, { type: "peer-left", id: peerId });
        if (currentRoom.size === 0 && currentRoomId) {
          rooms.delete(currentRoomId);
        }
        broadcastRooms();
      }
      logger.info("ws_disconnected", { peerId, roomId: currentRoomId ?? undefined });
    });

    ws.on("error", (error) => {
      logger.warn("ws_error", { peerId, message: error.message });
    });
  });

  wss.on("error", (error) => {
    logger.error("ws_server_error", { message: error.message });
  });

  server.on("error", (error) => {
    logger.error("http_server_error", { message: (error as Error).message });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  logger.info("server_listening", { port, host, tls: Boolean(tls) });

  return {
    httpServer: server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      })
  };
}
