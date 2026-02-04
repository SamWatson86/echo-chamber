const fs = require("fs");
const path = require("path");
const os = require("os");
const selfsigned = require("selfsigned");

const appData = process.env.APPDATA;
const defaultDir = appData
  ? path.join(appData, "Echo Chamber", "certs")
  : path.resolve(process.cwd(), "certs");

const outDir = process.env.ECHO_CHAMBER_CERT_DIR || defaultDir;
fs.mkdirSync(outDir, { recursive: true });

const attrs = [{ name: "commonName", value: "localhost" }];
const pems = selfsigned.generate(attrs, {
  days: 365,
  algorithm: "sha256",
  keySize: 2048,
  extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }]
});

const certPath = path.join(outDir, "echo-chamber.crt");
const keyPath = path.join(outDir, "echo-chamber.key");

fs.writeFileSync(certPath, pems.cert);
fs.writeFileSync(keyPath, pems.private);

console.log(JSON.stringify({ certPath, keyPath }));