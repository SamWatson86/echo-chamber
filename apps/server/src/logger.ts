import fs from "fs";
import path from "path";

export type LogLevel = "info" | "warn" | "error" | "debug";

export type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
};

function resolveMaxBytes() {
  const raw = process.env.LOG_MAX_BYTES;
  if (!raw) return 5_000_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5_000_000;
  return parsed;
}

function ensureDirForFile(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export function createLogger(logFile?: string): Logger {
  let stream: fs.WriteStream | null = null;
  let currentBytes = 0;
  const maxBytes = resolveMaxBytes();
  if (logFile) {
    ensureDirForFile(logFile);
    try {
      currentBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    } catch {
      currentBytes = 0;
    }
    stream = fs.createWriteStream(logFile, { flags: "a" });
  }

  const write = (level: LogLevel, message: string, meta?: Record<string, unknown>) => {
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

    if (stream) {
      if (maxBytes > 0 && currentBytes + lineBytes > maxBytes && logFile) {
        try {
          stream.end();
        } catch {
          // ignore
        }
        try {
          fs.writeFileSync(logFile, "");
        } catch {
          // ignore
        }
        stream = fs.createWriteStream(logFile, { flags: "a" });
        currentBytes = 0;
      }
      stream.write(line);
      currentBytes += lineBytes;
    }
  };

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
    debug: (message, meta) => write("debug", message, meta)
  };
}
