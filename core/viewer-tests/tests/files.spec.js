import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

async function mockLibrary(page, access = "reader") {
  let role = "",
    pending = [],
    files = [
      {
        id: "a".repeat(64),
        name: "Clubhouse archive.zip",
        size: 5 * 1024 ** 3,
        created_at: 1794106800,
        complete: true,
      },
    ];
  const chunks = [];
  await page.route("**/api/files/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.slice("/api/files".length),
      method = request.method();
    const json = (value, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
      });
    if (path === "/session") {
      if (method === "POST") {
        role = request.postDataJSON().role;
        return json({ role });
      }
      if (method === "DELETE") {
        role = "";
        return route.fulfill({ status: 204 });
      }
      return role
        ? json({ role })
        : route.fulfill({ status: 401, body: "Sign in to Files." });
    }
    if (!role) return route.fulfill({ status: 401, body: "Sign in to Files." });
    if (path === "/catalog") return json(files);
    if (path.endsWith("/download"))
      return route.fulfill({
        contentType: "application/octet-stream",
        headers: {
          "content-disposition": "attachment; filename=clubhouse.txt",
        },
        body: "Echo files download",
      });
    if (path === "/uploads" && method === "GET") return json(pending);
    if (path === "/uploads" && method === "POST") {
      const upload = {
        ...request.postDataJSON(),
        id: "b".repeat(64),
        offset: 0,
        complete: false,
        created_at: 1794106800,
      };
      pending.push(upload);
      return json(upload);
    }
    if (method === "PATCH") {
      const bytes = request.postDataBuffer();
      const upload = pending[0];
      expect(Number(request.headers()["upload-offset"])).toBe(upload.offset);
      expect(request.headers()["x-chunk-sha256"]).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      upload.offset += bytes.length;
      chunks.push(bytes);
      return json(upload);
    }
    if (path.endsWith("/complete")) {
      const upload = pending.shift();
      upload.complete = true;
      files.push(upload);
      return json(upload);
    }
    if (method === "DELETE") {
      files = [];
      return route.fulfill({ status: 204 });
    }
    throw new Error(`Unexpected Files route ${method} ${path}`);
  });
  await page.goto("/viewer/files.html");
  await expect(page.locator("#files-status")).toContainText("Sign in");
  await page.selectOption("#files-role", access);
  await page.fill("#files-password", "test-files-password");
  await page.click("#files-sign-in");
  await expect(page.locator("#files-count")).toHaveText("1 shared file");
  return { chunks };
}
for (const width of [1440, 390]) {
  test(`reader library and streaming download at ${width}px`, async ({
    page,
  }, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 900 });
    await mockLibrary(page);
    await expect(page.locator("#files-owner")).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Back to Echo" }),
    ).toBeVisible();
    await expect(page.getByText("5.0 GiB", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page
        .getByRole("link", { name: "Download Clubhouse archive.zip" })
        .click(),
    ]);
    expect(download.suggestedFilename()).toBe("clubhouse.txt");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`file-room-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
    await page.fill("#files-search", "no such file");
    await expect(page.getByText("No files match your search.")).toBeVisible();
    await page.click("#files-sign-out");
    await expect(page.locator("#files-login")).toBeVisible();
  });
}
test("owner uploads binary file with checksums and publishes it", async ({
  page,
}, testInfo) => {
  const { chunks } = await mockLibrary(page, "owner");
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 0xa5);
  await page
    .locator("#files-input")
    .setInputFiles({
      name: "Movie pack.zip",
      mimeType: "application/zip",
      buffer: bytes,
    });
  await expect(page.locator("#files-count")).toHaveText("2 shared files");
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(chunks.map((c) => c.length)).toEqual([8 * 1024 * 1024, 17]);
  await expect(
    page.getByRole("link", { name: "Download Movie pack.zip" }),
  ).toBeVisible();
  expect(await page.locator("#files-password").inputValue()).toBe("");
  await page.screenshot({
    path: testInfo.outputPath("file-room-owner.png"),
    fullPage: true,
  });
});
test("Files opens as an Echo stage module and retains its frame when closed", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/**", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
  await page.goto("/?echo-ui-shell-v2=1");
  await page.addScriptTag({
    path: fileURLToPath(
      new URL("../fixtures/install-scenario.js", import.meta.url),
    ),
  });
  await page.evaluate(async () => {
    echoSet("echo-changelog-seen", CHANGELOG_LATEST);
    await window.EchoLayoutTestScenario.install({
      participants: 2,
      cameras: 0,
      screenShares: 0,
    });
  });
  await page.locator("#shell-more-actions").click();
  await page.locator("#open-files").click();
  await expect(page.locator("#files-panel")).toBeVisible();
  await expect(page.locator("#stage-module-host")).toHaveAttribute(
    "data-active-module",
    "files",
  );
  await expect(page.locator("#files-frame")).toHaveAttribute(
    "src",
    "files.html",
  );
  await page.locator("#close-files").click();
  await expect(page.locator("#files-panel")).toBeHidden();
  await expect(page.locator("#files-frame")).toHaveAttribute(
    "src",
    "files.html",
  );
  expect(errors).toEqual([]);
});
