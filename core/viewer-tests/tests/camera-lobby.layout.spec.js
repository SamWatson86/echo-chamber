import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoDocumentOverflow } from "./helpers/geometry.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
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
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
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
  expect(runtimeErrors.get(page) || [], "production page must run without runtime errors").toEqual([]);
});

async function openCameraLobbyFixture(page, count, viewport) {
  await page.setViewportSize(viewport);
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await page.addScriptTag({ path: fixturePath });
  const installed = await page.evaluate(
    (tileCount) => window.EchoLayoutTestScenario.installCameraLobby({ count: tileCount }),
    count,
  );
  expect(installed).toEqual({ count, panelVisible: true });
  await expect(page.locator("#camera-lobby-grid")).toHaveAttribute("data-layout-count", String(count));
}

async function inspectLobbyLayout(page) {
  return page.evaluate(() => {
    function rect(element) {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      };
    }

    function number(style, property) {
      const value = Number.parseFloat(style[property]);
      return Number.isFinite(value) ? value : 0;
    }

    function intersectionArea(first, second) {
      const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
      const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
      return width * height;
    }

    const panel = document.getElementById("camera-lobby");
    const header = panel.querySelector(".camera-lobby-header");
    const grid = document.getElementById("camera-lobby-grid");
    const style = getComputedStyle(grid);
    const tiles = Array.from(grid.querySelectorAll(":scope > .camera-lobby-tile"));
    const tileRects = tiles.map(rect);
    const buttonRects = Array.from(header.querySelectorAll("button")).map(rect);
    const width = Math.max(0, grid.clientWidth - number(style, "paddingLeft") - number(style, "paddingRight"));
    const height = Math.max(0, grid.clientHeight - number(style, "paddingTop") - number(style, "paddingBottom"));
    const gap = Math.max(number(style, "columnGap"), number(style, "rowGap"));
    const expected = window.EchoLayoutPolicy.chooseOptimalGrid({
      width,
      height,
      tileCount: tiles.length,
      gap,
      aspectRatio: window.EchoLayoutPolicy.DEFAULT_TILE_ASPECT_RATIO,
    });

    let maxTileIntersection = 0;
    for (let first = 0; first < tileRects.length; first += 1) {
      for (let second = first + 1; second < tileRects.length; second += 1) {
        maxTileIntersection = Math.max(maxTileIntersection, intersectionArea(tileRects[first], tileRects[second]));
      }
    }

    let maxButtonIntersection = 0;
    for (let first = 0; first < buttonRects.length; first += 1) {
      for (let second = first + 1; second < buttonRects.length; second += 1) {
        maxButtonIntersection = Math.max(maxButtonIntersection, intersectionArea(buttonRects[first], buttonRects[second]));
      }
    }

    return {
      actual: {
        columns: Number(grid.dataset.layoutColumns),
        rows: Number(grid.dataset.layoutRows),
      },
      buttonRects,
      expected,
      grid: rect(grid),
      gridOverflow: {
        x: grid.scrollWidth - grid.clientWidth,
        y: grid.scrollHeight - grid.clientHeight,
      },
      header: rect(header),
      maxButtonIntersection,
      maxTileIntersection,
      panel: rect(panel),
      tileRects,
      videoCount: grid.querySelectorAll(":scope > .camera-lobby-tile > video").length,
    };
  });
}

function expectContained(child, parent, label) {
  expect.soft(child.left, `${label} left`).toBeGreaterThanOrEqual(parent.left - 1);
  expect.soft(child.right, `${label} right`).toBeLessThanOrEqual(parent.right + 1);
  expect.soft(child.top, `${label} top`).toBeGreaterThanOrEqual(parent.top - 1);
  expect.soft(child.bottom, `${label} bottom`).toBeLessThanOrEqual(parent.bottom + 1);
}

function expectHealthyLobbyLayout(presentation, count, expectedTracks) {
  expect(presentation.expected.valid).toBe(true);
  expect(presentation.actual).toEqual({
    columns: presentation.expected.columns,
    rows: presentation.expected.rows,
  });
  expect(presentation.actual).toEqual(expectedTracks);
  expect(presentation.videoCount).toBe(count);
  expect(presentation.maxTileIntersection).toBeLessThanOrEqual(1);
  expect(presentation.maxButtonIntersection).toBeLessThanOrEqual(1);
  expect(presentation.gridOverflow.x).toBeLessThanOrEqual(1);
  expect(presentation.gridOverflow.y).toBeLessThanOrEqual(1);

  presentation.tileRects.forEach((tile, index) => {
    expectContained(tile, presentation.grid, `tile ${index + 1}`);
    expect.soft(tile.width, `tile ${index + 1} width`).toBeCloseTo(presentation.expected.tileWidth, 0);
    expect.soft(tile.height, `tile ${index + 1} height`).toBeCloseTo(presentation.expected.tileHeight, 0);
    expect.soft(tile.width / tile.height, `tile ${index + 1} aspect`).toBeCloseTo(16 / 9, 2);
  });
  presentation.buttonRects.forEach((button, index) => {
    expectContained(button, presentation.panel, `header button ${index + 1}`);
  });
}

for (const scenario of [
  {
    name: "one camera fills the wide lobby's limiting axis",
    count: 1,
    viewport: { width: 1440, height: 800 },
    expectedTracks: { columns: 1, rows: 1 },
  },
  {
    name: "two cameras stack in a tall lobby instead of shrinking side by side",
    count: 2,
    viewport: { width: 820, height: 1200 },
    expectedTracks: { columns: 1, rows: 2 },
  },
  {
    name: "many cameras stay balanced and contained in a narrow lobby",
    count: 6,
    viewport: { width: 520, height: 780 },
    expectedTracks: { columns: 3, rows: 2 },
  },
]) {
  test(scenario.name, async ({ page }) => {
    await openCameraLobbyFixture(page, scenario.count, scenario.viewport);
    await page.evaluate(() => window.EchoLayoutTestScenario.captureCameraLobbySnapshot());

    const before = await inspectLobbyLayout(page);
    expectHealthyLobbyLayout(before, scenario.count, scenario.expectedTracks);
    await expectNoDocumentOverflow(page);

    const resizedViewport = {
      width: scenario.viewport.width - 12,
      height: scenario.viewport.height + 8,
    };
    await page.setViewportSize(resizedViewport);
    await expect.poll(() => page.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }))).toEqual(resizedViewport);
    await page.evaluate(() => window._echoRecalcCameraLobby());
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    const after = await inspectLobbyLayout(page);
    expectHealthyLobbyLayout(after, scenario.count, scenario.expectedTracks);
    expect(await page.evaluate(() => window.EchoLayoutTestScenario.inspectCameraLobbySnapshot())).toEqual({
      count: scenario.count,
      streams: true,
      tiles: true,
      trackStates: Array(scenario.count).fill("live"),
      tracks: true,
      videos: true,
    });
    await expectNoDocumentOverflow(page);
  });
}

test("layout sizing does not break the Camera Lobby's enlarged tile", async ({ page }) => {
  const viewport = { width: 1280, height: 720 };
  await openCameraLobbyFixture(page, 1, viewport);
  await page.evaluate(() => window.EchoLayoutTestScenario.captureCameraLobbySnapshot());

  const tile = page.locator("#camera-lobby-grid > .camera-lobby-tile");
  await tile.click();
  await expect(tile).toHaveClass(/enlarged/);
  const enlarged = await tile.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const grid = document.getElementById("camera-lobby-grid").getBoundingClientRect();
    const header = document.querySelector("#camera-lobby .camera-lobby-header").getBoundingClientRect();
    const panel = document.getElementById("camera-lobby").getBoundingClientRect();
    return {
      bottom: rect.bottom,
      grid: {
        bottom: grid.bottom,
        left: grid.left,
        right: grid.right,
        top: grid.top,
      },
      headerBottom: header.bottom,
      left: rect.left,
      panel: {
        bottom: panel.bottom,
        left: panel.left,
        right: panel.right,
        top: panel.top,
      },
      right: rect.right,
      top: rect.top,
    };
  });
  expect(Math.abs(enlarged.left - enlarged.grid.left)).toBeLessThanOrEqual(2);
  expect(Math.abs(enlarged.top - enlarged.grid.top)).toBeLessThanOrEqual(2);
  expect(Math.abs(enlarged.right - enlarged.grid.right)).toBeLessThanOrEqual(2);
  expect(Math.abs(enlarged.bottom - enlarged.grid.bottom)).toBeLessThanOrEqual(2);
  expect(enlarged.top).toBeGreaterThanOrEqual(enlarged.headerBottom - 1);
  expectContained(enlarged, enlarged.panel, "enlarged camera tile");

  await tile.click();
  await expect(tile).not.toHaveClass(/enlarged/);
  expect(await page.evaluate(() => window.EchoLayoutTestScenario.inspectCameraLobbySnapshot())).toEqual({
    count: 1,
    streams: true,
    tiles: true,
    trackStates: ["live"],
    tracks: true,
    videos: true,
  });
  await expectNoDocumentOverflow(page);
});
