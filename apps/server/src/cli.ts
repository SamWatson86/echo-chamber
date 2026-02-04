import path from "path";
import dotenv from "dotenv";
import { startServer, resolveStaticDir } from "./server.js";
import fs from "fs";

const rootEnv = path.resolve(process.cwd(), ".env");
const serverEnv = path.resolve(process.cwd(), "apps/server/.env");

dotenv.config({ path: rootEnv });
dotenv.config({ path: serverEnv });

const port = Number(process.env.PORT ?? 5050);
const host = process.env.HOST ?? "0.0.0.0";
const passwordHash = process.env.AUTH_PASSWORD_HASH ?? "";
const jwtSecret = process.env.AUTH_JWT_SECRET ?? "";
const tokenTtlHours = Number(process.env.AUTH_TOKEN_TTL_HOURS ?? 12);
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const adminTokenTtlHours = Number(process.env.ADMIN_TOKEN_TTL_HOURS ?? 12);
const maxPeersPerRoom = parseOptionalNumber(process.env.MAX_PEERS_PER_ROOM);
const serverName = process.env.SERVER_NAME;

const tlsCertPath = process.env.TLS_CERT_PATH;
const tlsKeyPath = process.env.TLS_KEY_PATH;
const tls = tlsCertPath && tlsKeyPath ? { certPath: tlsCertPath, keyPath: tlsKeyPath } : undefined;

const staticDir = resolveStaticDir();
const iceServers = parseIceServers(process.env.ICE_SERVERS_JSON);
const logFile = resolveLogFile(process.env.LOG_FILE, process.env.LOG_DIR);
const soundboardDir = process.env.SOUNDBOARD_DIR;
const soundboardMaxMb = Number(process.env.SOUNDBOARD_MAX_MB ?? 8);
const soundboardMaxBytes = Number.isFinite(soundboardMaxMb) ? Math.max(1, soundboardMaxMb) * 1024 * 1024 : undefined;
const soundboardMaxSoundsPerRoom = parseOptionalNumber(process.env.SOUNDBOARD_MAX_SOUNDS_PER_ROOM);

startServer({
  port,
  host,
  staticDir,
  passwordHash,
  jwtSecret,
  tokenTtlHours,
  adminPasswordHash,
  adminTokenTtlHours,
  tls,
  iceServers,
  maxPeersPerRoom,
  serverName,
  logFile,
  soundboardDir,
  soundboardMaxBytes,
  soundboardMaxSoundsPerRoom
})
  .then(({ httpServer }) => {
    const address = httpServer.address();
    if (address && typeof address !== "string") {
      const protocol = tls ? "https" : "http";
      console.log(`Echo Chamber server running on ${protocol}://${address.address}:${address.port}`);
    }
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });

function parseIceServers(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("ICE_SERVERS_JSON must be an array");
    }
    return parsed;
  } catch (error) {
    console.warn("Ignoring ICE_SERVERS_JSON due to parse error:", error);
    return undefined;
  }
}

function parseOptionalNumber(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveLogFile(explicitFile: string | undefined, logDir: string | undefined) {
  if (explicitFile) return explicitFile;
  const baseDir = logDir ?? path.resolve(process.cwd(), "logs");
  fs.mkdirSync(baseDir, { recursive: true });
  return path.join(baseDir, "echo-chamber-server.log");
}
