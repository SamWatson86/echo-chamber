import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  expectHorizontallyContained,
  expectMinimumUsableRegion,
  expectNoDocumentOverflow,
  expectNoOverlap,
} from "./helpers/geometry.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const policyPath = path.resolve(testDirectory, "..", "..", "viewer", "layout-policy.js");
const runtimeErrors = new WeakMap();
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/online") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    if (url.pathname.startsWith("/api/avatar/")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: transparentPng });
      return;
    }
    if (url.pathname === "/api/version") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ latest_client: "" }),
      });
      return;
    }
    errors.push(`unexpected API request: ${route.request().method()} ${url.pathname}`);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "unmodeled viewer-test endpoint" }),
    });
  });
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(25);
  expect(runtimeErrors.get(page) || [], "production page must boot without runtime errors").toEqual([]);
});

async function openProductionViewer(page, scenario) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: fixturePath });
  return page.evaluate((options) => window.EchoLayoutTestScenario.install(options), scenario);
}

test("production viewer scenario uses real participant and screen renderers", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const installed = await openProductionViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 2,
    shareAspects: [16 / 9, 32 / 9],
    longNames: true,
  });

  expect(installed).toEqual({
    cameraCards: 2,
    participantCards: 4,
    screenTiles: 2,
    chatOpen: false,
  });
  await expect(page.locator(".user-card")).toHaveCount(4);
  await expect(page.locator(".user-card.has-camera")).toHaveCount(2);
  await expect(page.locator(".user-card").first()).not.toHaveClass(/has-camera/);
  await expect(page.locator(".layout-fixture-camera")).toHaveCount(2);
  await expect(page.locator("#screen-grid > .tile")).toHaveCount(2);
  await expect(page.locator("#screen-grid > .tile .tile-overlay")).toHaveCount(2);
  await expect(page.locator("#screen-grid > .tile .tile-fullscreen-btn")).toHaveCount(2);
  await expect(page.locator("#screen-grid > .tile .tile-volume-wrap")).toHaveCount(2);
  await expect(page.locator(".user-card").first()).toHaveAttribute("data-identity", "layout-fixture-1");
  await expect(page.locator("#screen-grid > .tile").nth(1)).toHaveClass(/superwide/);
});

test("wide production room keeps primary regions separated and inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openProductionViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
    longNames: true,
  });

  const roomLayout = page.locator(".room-layout");
  const stage = page.locator(".room-main");
  const sidebar = page.locator(".room-sidebar");
  await expectNoOverlap(stage, sidebar);
  await expectHorizontallyContained(stage, roomLayout);
  await expectHorizontallyContained(sidebar, roomLayout);
  await expectMinimumUsableRegion(stage, { width: 400, height: 240 });
  await expectMinimumUsableRegion(sidebar, { width: 300, height: 240 });
  await expectNoDocumentOverflow(page);
});

test("production nodes and draft state survive the baseline desktop resize matrix", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await openProductionViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
    longNames: true,
  });

  await page.evaluate(() => {
    window.__layoutFixtureCard = document.querySelector(".user-card");
    window.__layoutFixtureTile = document.querySelector("#screen-grid > .tile");
    document.getElementById("chat-input").value = "Draft preserved across resize";
  });

  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const preserved = await page.evaluate(() => ({
      card: window.__layoutFixtureCard === document.querySelector(".user-card"),
      draft: document.getElementById("chat-input").value,
      tile: window.__layoutFixtureTile === document.querySelector("#screen-grid > .tile"),
    }));
    expect(preserved, `${viewport.width}x${viewport.height}`).toEqual({
      card: true,
      draft: "Draft preserved across resize",
      tile: true,
    });
    await expectNoOverlap(page.locator(".room-main"), page.locator(".room-sidebar"));
    await expectNoDocumentOverflow(page);
  }
});

for (const viewport of [
  { width: 960, height: 540 },
  { width: 640, height: 480 },
]) {
  test(`records the legacy participant-region collapse at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    test.info().annotations.push({
      type: "known-legacy-failure",
      description: "Replace this sentinel with the >=160px contract assertion when Clubhouse lands",
    });
    await page.setViewportSize(viewport);
    await openProductionViewer(page, {
      participants: 4,
      cameras: 2,
      screenShares: 1,
      longNames: true,
    });

    const userList = page.locator("#user-list");
    const collapsed = await userList.evaluate((element) => {
      const firstCard = element.querySelector(".user-card");
      const listRect = element.getBoundingClientRect();
      const cardRect = firstCard.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(listRect.bottom, cardRect.bottom, document.documentElement.clientHeight) -
          Math.max(listRect.top, cardRect.top, 0),
      );
      return {
        clientHeight: element.clientHeight,
        firstCardVisibleRatio: visibleHeight / Math.max(1, cardRect.height),
        scrollHeight: element.scrollHeight,
      };
    });

    expect(collapsed.clientHeight).toBeGreaterThan(0);
    expect(collapsed.clientHeight).toBeLessThan(160);
    expect(collapsed.scrollHeight).toBeGreaterThan(collapsed.clientHeight * 5);
    expect(collapsed.firstCardVisibleRatio).toBeGreaterThan(0);
    expect(collapsed.firstCardVisibleRatio).toBeLessThan(0.25);
  });
}

test("browser policy classifies the supported viewport matrix without loading production wiring", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: policyPath });

  const matrix = [
    { width: 1920, height: 1080, expected: "theater" },
    { width: 1440, height: 900, expected: "theater" },
    { width: 1280, height: 720, expected: "theater" },
    { width: 1024, height: 768, expected: "lounge" },
    { width: 960, height: 540, expected: "compact" },
    { width: 800, height: 600, expected: "compact" },
    { width: 640, height: 480, expected: "compact" },
    { width: 639, height: 479, expected: "mini" },
  ];

  for (const sample of matrix) {
    const mode = await page.evaluate(
      ({ width, height }) => window.EchoLayoutPolicy.classifyLayoutMode(width, height),
      sample,
    );
    expect(mode, `${sample.width}x${sample.height}`).toBe(sample.expected);
  }

  const transition = await page.evaluate(() => {
    const policy = window.EchoLayoutPolicy;
    const initial = policy.resolveLayoutMode({ width: 768, height: 1024 });
    const retained = policy.resolveLayoutMode({
      width: 600,
      height: 900,
      previousMode: initial,
    });
    const downgraded = policy.resolveLayoutMode({
      width: 591,
      height: 900,
      previousMode: retained,
    });
    return [initial, retained, downgraded];
  });
  expect(transition).toEqual(["compact", "compact", "mini"]);
});

test(
  "records the legacy narrow-Chat stage collapse",
  async ({ page }) => {
    test.info().annotations.push({
      type: "known-legacy-failure",
      description: "Replace this sentinel with active drawer non-overlap assertions when Clubhouse lands",
    });
    await page.setViewportSize({ width: 800, height: 600 });
    await openProductionViewer(page, {
      participants: 4,
      cameras: 2,
      screenShares: 1,
      chatOpen: true,
    });

    const stage = page.locator(".room-main");
    const sidebar = page.locator(".room-sidebar");
    const chat = page.locator("#chat-panel");
    const stageBox = await stage.boundingBox();
    expect(stageBox?.width || 0).toBeLessThan(1);
    await expectNoOverlap(sidebar, chat);
    await expectNoDocumentOverflow(page);
  },
);
