import { chromium } from "../node_modules/playwright/index.mjs";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const port = Number(process.env.ECHO_FILES_TEST_PORT || 4197);
assert.ok(
  Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 9443,
);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/viewer/files.html`);
  await page.selectOption("#files-role", "owner");
  await page.fill("#files-password", "owner-password-for-files");
  await page.click("#files-sign-in");
  await page.locator("#files-owner").waitFor({ state: "visible" });
  const payload = Buffer.alloc(9 * 1024 * 1024 + 3, 0x67);
  await page
    .locator("#files-input")
    .setInputFiles({
      name: "real-browser-transfer.zip",
      mimeType: "application/zip",
      buffer: payload,
    });
  await page
    .getByRole("link", { name: "Download real-browser-transfer.zip" })
    .waitFor();
  const cookies = await context.cookies();
  assert.equal(cookies[0].httpOnly, true);
  assert.equal(cookies[0].secure, true);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page
      .getByRole("link", { name: "Download real-browser-transfer.zip" })
      .click(),
  ]);
  assert.equal(download.suggestedFilename(), "real-browser-transfer.zip");
  assert.deepEqual(await readFile(await download.path()), payload);
  const catalog = await page.evaluate(async () =>
    (await fetch("/api/files/catalog")).json(),
  );
  const ranged = await page.evaluate(async (id) => {
    const r = await fetch(`/api/files/${id}/download`, {
      headers: { Range: "bytes=8388608-8388610" },
    });
    return {
      status: r.status,
      bytes: Array.from(new Uint8Array(await r.arrayBuffer())),
    };
  }, catalog[0].id);
  assert.equal(ranged.status, 206);
  assert.deepEqual(ranged.bytes, [0x67, 0x67, 0x67]);
  await page.click("#files-sign-out");
  await page.selectOption("#files-role", "reader");
  await page.fill("#files-password", "reader-password-for-files");
  await page.click("#files-sign-in");
  await page
    .getByRole("link", { name: "Download real-browser-transfer.zip" })
    .waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Delete", exact: true }).count(),
    0,
  );
  const forbidden = await page.evaluate(
    async (id) =>
      (
        await fetch(`/api/files/${id}`, {
          method: "DELETE",
          headers: { "X-Echo-Files": "1" },
        })
      ).status,
    catalog[0].id,
  );
  assert.equal(forbidden, 403);
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "test-results/real-files-browser-smoke.png",
    fullPage: true,
  });
  console.log(
    "PASS: real HTTP owner login + Secure/HttpOnly cookie, 9 MiB chunked upload, byte-identical browser download, range download, reader login and delete denied.",
  );
} finally {
  await browser.close();
}
