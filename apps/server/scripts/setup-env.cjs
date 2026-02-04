const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const args = process.argv.slice(2);
const password = args.find((arg) => !arg.startsWith("--"));
const force = args.includes("--force");

if (!password) {
  console.error("Usage: node scripts/setup-env.cjs \"password\" [--force]");
  process.exit(1);
}

const rootDir = path.resolve(__dirname, "..", "..", "..");
const envPath = path.join(rootDir, ".env");

if (fs.existsSync(envPath) && !force) {
  console.error(".env already exists. Use --force to overwrite.");
  process.exit(1);
}

const jwtSecret = crypto.randomBytes(32).toString("hex");

bcrypt.hash(password, 10).then((hash) => {
  const content = [
    "PORT=5050",
    "HOST=0.0.0.0",
    `AUTH_PASSWORD_HASH=${hash}`,
    `AUTH_JWT_SECRET=${jwtSecret}`,
    "AUTH_TOKEN_TTL_HOURS=12",
    "TLS_CERT_PATH=",
    "TLS_KEY_PATH=",
    "ICE_SERVERS_JSON=",
    "MAX_PEERS_PER_ROOM=8",
    "SERVER_NAME=Echo Chamber",
    "LOG_DIR=",
    "LOG_FILE=",
    ""
  ].join("\n");

  fs.writeFileSync(envPath, content);
  console.log(`Wrote ${envPath}`);
});
