import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const runtimeErrors = new WeakMap();
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const viewerMatrix = Object.freeze([
  Object.freeze({ height: 768, label: "1366x768", width: 1366 }),
  Object.freeze({ height: 1080, label: "1920x1080", width: 1920 }),
  Object.freeze({ height: 1440, label: "2560x1440", width: 2560 }),
  Object.freeze({ height: 2160, label: "3840x2160", width: 3840 }),
  Object.freeze({ height: 1440, label: "3440x1440", width: 3440 }),
  Object.freeze({ height: 1440, label: "5120x1440", width: 5120 }),
]);
const sourceMatrix = Object.freeze([
  Object.freeze({ aspect: 16 / 9, label: "16:9" }),
  Object.freeze({ aspect: 16 / 10, label: "16:10" }),
  Object.freeze({ aspect: 21 / 9, label: "21:9" }),
  Object.freeze({ aspect: 32 / 9, label: "32:9" }),
  Object.freeze({ aspect: 4 / 3, label: "4:3" }),
  Object.freeze({ aspect: 9 / 16, label: "portrait" }),
]);

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
  expect(runtimeErrors.get(page) || [], "production page must run without runtime errors").toEqual([]);
});

async function waitForLayout(page, frameCount = 2) {
  await page.evaluate((count) => new Promise((resolve) => {
    function nextFrame(remaining) {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => nextFrame(remaining - 1));
    }
    nextFrame(count);
  }), frameCount);
}

async function resizeViewport(page, viewport) {
  await page.setViewportSize({ height: viewport.height, width: viewport.width });
  await expect.poll(
    () => page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })),
    { message: `viewport should settle at ${viewport.width}x${viewport.height}` },
  ).toEqual({ height: viewport.height, width: viewport.width });
  await waitForLayout(page, 3);
}

async function emulateFullscreenViewport(page, viewport, deviceScaleFactor = 1) {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor,
    height: viewport.height,
    mobile: false,
    screenHeight: viewport.height,
    screenWidth: viewport.width,
    width: viewport.width,
  });
  await expect.poll(
    () => page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })),
    { message: `fullscreen viewport should settle at ${viewport.width}x${viewport.height}` },
  ).toEqual({ height: viewport.height, width: viewport.width });
  await waitForLayout(page, 3);
  return session;
}

async function openStageFixture(page, scenario) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await page.addScriptTag({ path: fixturePath });
  return page.evaluate((options) => window.EchoLayoutTestScenario.install(options), scenario);
}

async function closeClubhouseTools(page) {
  const toolsToggle = page.getByRole("button", { name: "Hide clubhouse tools" });
  if (await toolsToggle.isVisible()) {
    await toolsToggle.click();
    await waitForLayout(page, 3);
  }
}

function screenTile(page, index = 0) {
  return page.locator("#screen-grid > .tile").nth(index);
}

async function rememberStableNodes(page, key, index = 0) {
  await page.evaluate(({ index: tileIndex, key: storageKey }) => {
    const tile = document.querySelectorAll("#screen-grid > .tile")[tileIndex];
    if (!tile) throw new Error(`missing screen tile ${tileIndex}`);
    window.__fullscreenRegressionNodes ||= Object.create(null);
    window.__fullscreenRegressionNodes[storageKey] = {
      button: tile.querySelector(".tile-fullscreen-btn"),
      tile,
      video: tile.querySelector("video.screen-video-surface"),
    };
  }, { index, key });
}

async function readStableNodeState(page, key, index = 0) {
  return page.evaluate(({ index: tileIndex, key: storageKey }) => {
    const remembered = window.__fullscreenRegressionNodes?.[storageKey];
    const tile = document.querySelectorAll("#screen-grid > .tile")[tileIndex];
    const video = tile?.querySelector("video.screen-video-surface") || null;
    const button = tile?.querySelector(".tile-fullscreen-btn") || null;
    return {
      buttonIdentityPreserved: button === remembered?.button,
      fullscreenHints: document.querySelectorAll(".fullscreen-hint").length,
      fullscreenHosts: document.querySelectorAll(".fullscreen-video-wrapper").length,
      tileIdentityPreserved: tile === remembered?.tile,
      tileOwnsVideo: video?.parentElement === tile,
      topLevelFullscreenHosts: document.querySelectorAll("body > .fullscreen-video-wrapper").length,
      videoCount: tile?.querySelectorAll("video.screen-video-surface").length || 0,
      videoIdentityPreserved: video === remembered?.video,
    };
  }, { index, key });
}

async function enterStableFullscreen(page, index = 0) {
  const tile = screenTile(page, index);
  await tile.locator(".tile-fullscreen-btn").click();
  await expect.poll(
    () => tile.evaluate((element) => document.fullscreenElement === element),
    { message: `tile ${index} should become the fullscreen element` },
  ).toBe(true);
  await waitForLayout(page);
  return tile;
}

async function exitFullscreenProgrammatically(page) {
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await waitForLayout(page, 3);
}

async function exitFullscreenThroughControl(page, index = 0) {
  const tile = screenTile(page, index);
  await tile.getByRole("button", { name: "Exit shared screen fullscreen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await waitForLayout(page, 3);
}

async function ensureFullscreenExited(page) {
  if (page.isClosed()) return;
  await page.evaluate(async () => {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch (_error) {
        // The assertion that triggered cleanup reports the useful failure.
      }
    }
  });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  await expect.poll(
    () => page.locator(".fullscreen-video-wrapper").count(),
    { message: "fullscreen presentation classes should be cleaned up" },
  ).toBe(0);
  await waitForLayout(page, 3);
}

async function showOnlyShare(page, index) {
  await page.evaluate((visibleIndex) => {
    const grid = document.getElementById("screen-grid");
    grid.classList.remove("is-focused");
    Array.from(grid.querySelectorAll(":scope > .tile")).forEach((tile, tileIndex) => {
      tile.classList.remove("is-focused");
      tile.style.display = tileIndex === visibleIndex ? "" : "none";
    });
    if (typeof window._echoRecalcGrid === "function") window._echoRecalcGrid();
  }, index);
  await waitForLayout(page, 3);
  await expect(page.locator("#screen-grid")).toHaveAttribute("data-visible-tiles", "1");
  await expect(screenTile(page, index)).toBeVisible();
  await expect.poll(() => page.evaluate((visibleIndex) => {
    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelectorAll(":scope > .tile")[visibleIndex];
    const gridBounds = grid.getBoundingClientRect();
    const tileBounds = tile.getBoundingClientRect();
    const gridArea = gridBounds.width * gridBounds.height;
    return gridArea > 0 ? (tileBounds.width * tileBounds.height) / gridArea : 0;
  }, index), { message: `share ${index} should settle into the solo Stage` }).toBeGreaterThanOrEqual(0.96);
}

async function capturePresentation(page, index = 0) {
  return page.evaluate((tileIndex) => {
    function rect(element) {
      const bounds = element.getBoundingClientRect();
      return {
        area: bounds.width * bounds.height,
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      };
    }

    function contain(bounds, aspectRatio) {
      let width = bounds.width;
      let height = width / aspectRatio;
      if (height > bounds.height) {
        height = bounds.height;
        width = height * aspectRatio;
      }
      const left = bounds.left + (bounds.width - width) / 2;
      const top = bounds.top + (bounds.height - height) / 2;
      return {
        area: width * height,
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
      };
    }

    const grid = document.getElementById("screen-grid");
    const tile = grid.querySelectorAll(":scope > .tile")[tileIndex];
    const video = tile.querySelector("video.screen-video-surface");
    const control = tile.querySelector(".tile-fullscreen-btn");
    const stage = tile.closest(".room-main");
    const dock = document.getElementById("call-controls");
    const fullscreenIsTile = document.fullscreenElement === tile;
    const gridRect = rect(grid);
    const tileRect = rect(tile);
    const videoRect = rect(video);
    const controlRect = rect(control);
    const containerRect = fullscreenIsTile ? tileRect : gridRect;
    const sourceAspect = video.videoWidth / video.videoHeight;
    const contentRect = contain(videoRect, sourceAspect);
    const optimalContentRect = contain(containerRect, sourceAspect);
    const controlStyle = getComputedStyle(control);
    const hitTarget = document.elementFromPoint(
      controlRect.left + controlRect.width / 2,
      controlRect.top + controlRect.height / 2,
    );

    return {
      container: containerRect,
      content: contentRect,
      contentCoverage: optimalContentRect.area > 0 ? contentRect.area / optimalContentRect.area : 0,
      control: controlRect,
      controlHitTarget: control === hitTarget || control.contains(hitTarget),
      controlVisible: controlRect.width > 0 && controlRect.height > 0 &&
        controlStyle.display !== "none" && controlStyle.visibility !== "hidden",
      datasetAspect: Number.parseFloat(tile.dataset.aspectRatio),
      dock: rect(dock),
      fullscreenIsTile,
      grid: gridRect,
      gridOverflowX: grid.scrollWidth - grid.clientWidth,
      gridOverflowY: grid.scrollHeight - grid.clientHeight,
      objectFit: getComputedStyle(video).objectFit,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      pageOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      publishedAspect: Number.parseFloat(tile.style.getPropertyValue("--screen-source-aspect-ratio")),
      sourceAspect,
      sourceHeight: video.videoHeight,
      sourceWidth: video.videoWidth,
      stage: rect(stage),
      tile: tileRect,
      tileCoverage: containerRect.area > 0 ? tileRect.area / containerRect.area : 0,
      video: videoRect,
      viewport: { dpr: window.devicePixelRatio, height: window.innerHeight, width: window.innerWidth },
    };
  }, index);
}

function expectContainedRect(child, parent, message, tolerance = 2) {
  expect(child.left, `${message}: left edge`).toBeGreaterThanOrEqual(parent.left - tolerance);
  expect(child.right, `${message}: right edge`).toBeLessThanOrEqual(parent.right + tolerance);
  expect(child.top, `${message}: top edge`).toBeGreaterThanOrEqual(parent.top - tolerance);
  expect(child.bottom, `${message}: bottom edge`).toBeLessThanOrEqual(parent.bottom + tolerance);
}

function expectPresentationGeometry(presentation, expectedAspect, label, fullscreen = false) {
  expect(presentation.fullscreenIsTile, `${label}: fullscreen host`).toBe(fullscreen);
  expect(presentation.objectFit, `${label}: media fit policy`).toBe("contain");
  expect(presentation.sourceWidth, `${label}: decoded width`).toBeGreaterThan(0);
  expect(presentation.sourceHeight, `${label}: decoded height`).toBeGreaterThan(0);
  expect(presentation.sourceAspect, `${label}: decoded aspect`).toBeCloseTo(expectedAspect, 3);
  expect(presentation.publishedAspect, `${label}: published tile aspect`).toBeCloseTo(expectedAspect, 3);
  expect(presentation.datasetAspect, `${label}: diagnostic tile aspect`).toBeCloseTo(expectedAspect, 1);
  expect(presentation.tileCoverage, `${label}: stable tile should use the available Stage`).toBeGreaterThanOrEqual(0.96);
  expect(presentation.contentCoverage, `${label}: media should use the maximal contained rectangle`).toBeGreaterThanOrEqual(0.96);
  expect(presentation.controlVisible, `${label}: fullscreen control visibility`).toBe(true);
  expect(presentation.controlHitTarget, `${label}: fullscreen control hit target`).toBe(true);
  expect(presentation.control.width, `${label}: fullscreen control width`).toBeGreaterThanOrEqual(39.5);
  expect(presentation.control.height, `${label}: fullscreen control height`).toBeGreaterThanOrEqual(39.5);
  expectContainedRect(presentation.tile, presentation.container, `${label}: tile containment`);
  expectContainedRect(presentation.video, presentation.container, `${label}: video containment`);
  expectContainedRect(presentation.content, presentation.container, `${label}: fitted frame containment`);
  expectContainedRect(presentation.control, presentation.tile, `${label}: fullscreen control containment`);
  expect(presentation.pageOverflowX, `${label}: horizontal page overflow`).toBeLessThanOrEqual(1);
  expect(presentation.pageOverflowY, `${label}: vertical page overflow`).toBeLessThanOrEqual(1);
  if (!fullscreen) {
    expectContainedRect(presentation.grid, presentation.stage, `${label}: grid containment`);
    expect(presentation.gridOverflowX, `${label}: horizontal Stage overflow`).toBeLessThanOrEqual(1);
    expect(presentation.gridOverflowY, `${label}: vertical Stage overflow`).toBeLessThanOrEqual(1);
  }
}

test("shared-screen fullscreen keeps the live video and controls in their stable Stage tile", async ({ page }) => {
  await resizeViewport(page, { width: 1280, height: 720 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [32 / 9],
  });
  await rememberStableNodes(page, "stable");

  const tile = screenTile(page);
  await expect(tile.locator("video.screen-video-surface")).toHaveCount(1);
  await expect(tile.getByRole("button", { name: "Open shared screen fullscreen" })).toBeVisible();

  await enterStableFullscreen(page);
  try {
    expect(await readStableNodeState(page, "stable")).toEqual({
      buttonIdentityPreserved: true,
      fullscreenHints: 1,
      fullscreenHosts: 1,
      tileIdentityPreserved: true,
      tileOwnsVideo: true,
      topLevelFullscreenHosts: 0,
      videoCount: 1,
      videoIdentityPreserved: true,
    });
  } finally {
    await ensureFullscreenExited(page);
  }
});

test("camera fullscreen keeps its stable avatar video and contained frame", async ({ page }) => {
  await resizeViewport(page, { width: 1366, height: 768 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 1,
    screenShares: 0,
    shareAspects: [],
  });

  const camera = page.locator(".user-avatar video.layout-fixture-camera").first();
  const avatar = camera.locator("xpath=..");
  await expect(camera).toBeVisible();
  await expect.poll(() => camera.evaluate((video) => getComputedStyle(video).objectFit)).toBe("contain");
  await camera.evaluate((video) => {
    window.__cameraFullscreenVideo = video;
    window.__cameraFullscreenHost = video.parentElement;
  });

  await camera.click();
  try {
    await expect.poll(() => avatar.evaluate((host) => document.fullscreenElement === host)).toBe(true);
    const fullscreenState = await camera.evaluate((video) => {
      const host = document.fullscreenElement;
      const hostBounds = host.getBoundingClientRect();
      const videoBounds = video.getBoundingClientRect();
      return {
        borderRadius: getComputedStyle(video).borderRadius,
        hostIdentity: host === window.__cameraFullscreenHost,
        hostSize: { height: hostBounds.height, width: hostBounds.width },
        objectFit: getComputedStyle(video).objectFit,
        sourceAspect: video.videoWidth / video.videoHeight,
        videoIdentity: video === window.__cameraFullscreenVideo,
        videoSize: { height: videoBounds.height, width: videoBounds.width },
        viewport: { height: innerHeight, width: innerWidth },
      };
    });
    expect(fullscreenState.hostIdentity).toBe(true);
    expect(fullscreenState.videoIdentity).toBe(true);
    expect(fullscreenState.objectFit).toBe("contain");
    expect(fullscreenState.borderRadius).toBe("0px");
    expect(fullscreenState.sourceAspect).toBeCloseTo(16 / 9, 3);
    expect(fullscreenState.hostSize.width).toBeCloseTo(fullscreenState.viewport.width, 0);
    expect(fullscreenState.hostSize.height).toBeCloseTo(fullscreenState.viewport.height, 0);
    expect(fullscreenState.videoSize.width).toBeCloseTo(fullscreenState.hostSize.width, 0);
    expect(fullscreenState.videoSize.height).toBeCloseTo(fullscreenState.hostSize.height, 0);
  } finally {
    await ensureFullscreenExited(page);
  }

  const restoredState = await camera.evaluate((video) => ({
    hostIdentity: video.parentElement === window.__cameraFullscreenHost,
    objectFit: getComputedStyle(video).objectFit,
    videoIdentity: video === window.__cameraFullscreenVideo,
  }));
  expect(restoredState).toEqual({ hostIdentity: true, objectFit: "contain", videoIdentity: true });
});

test("a rejected fullscreen request cleans up and allows a later retry", async ({ page }) => {
  await resizeViewport(page, { width: 1280, height: 720 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [16 / 9],
  });

  const tile = screenTile(page);
  const button = tile.getByRole("button", { name: "Open shared screen fullscreen" });
  await tile.evaluate((host) => {
    Object.defineProperty(host, "requestFullscreen", {
      configurable: true,
      value: () => Promise.reject(new DOMException("fixture rejection", "NotAllowedError")),
    });
  });
  await button.click();
  await expect.poll(() => tile.evaluate((host) => ({
    fullscreen: document.fullscreenElement,
    hint: host.querySelectorAll(".fullscreen-hint").length,
    marked: host.classList.contains("fullscreen-video-wrapper"),
  }))).toEqual({ fullscreen: null, hint: 0, marked: false });
  await expect(button).toHaveAccessibleName("Open shared screen fullscreen");

  await tile.evaluate((host) => delete host.requestFullscreen);
  await enterStableFullscreen(page);
  try {
    await exitFullscreenThroughControl(page);
  } finally {
    await ensureFullscreenExited(page);
  }
});

test("removing the video's poster sibling during fullscreen still exits cleanly", async ({ page }) => {
  await resizeViewport(page, { width: 1366, height: 768 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [21 / 9],
  });
  await rememberStableNodes(page, "poster-removal");

  await screenTile(page).evaluate((tile) => {
    const poster = document.createElement("div");
    poster.className = "tile-poster fullscreen-regression-poster";
    tile.querySelector("video.screen-video-surface").after(poster);
  });
  await expect(page.locator(".fullscreen-regression-poster")).toHaveCount(1);

  await enterStableFullscreen(page);
  try {
    await page.locator(".fullscreen-regression-poster").evaluate((poster) => poster.remove());
    await exitFullscreenProgrammatically(page);

    expect(await readStableNodeState(page, "poster-removal")).toEqual({
      buttonIdentityPreserved: true,
      fullscreenHints: 0,
      fullscreenHosts: 0,
      tileIdentityPreserved: true,
      tileOwnsVideo: true,
      topLevelFullscreenHosts: 0,
      videoCount: 1,
      videoIdentityPreserved: true,
    });
    await expect(screenTile(page)).toBeVisible();
  } finally {
    await ensureFullscreenExited(page);
  }
});

test("repeated enter and exit cycles preserve one stable tile, video, and button", async ({ page }) => {
  await resizeViewport(page, { width: 1920, height: 1080 });
  await openStageFixture(page, {
    participants: 3,
    cameras: 0,
    screenShares: 1,
    shareAspects: [16 / 10],
  });
  await rememberStableNodes(page, "cycles");

  try {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await enterStableFullscreen(page);
      await expect(screenTile(page).getByRole("button", { name: "Exit shared screen fullscreen" })).toBeVisible();
      await exitFullscreenThroughControl(page);
      await expect(screenTile(page).getByRole("button", { name: "Open shared screen fullscreen" })).toBeFocused();
      expect(await readStableNodeState(page, "cycles"), `cycle ${cycle}`).toEqual({
        buttonIdentityPreserved: true,
        fullscreenHints: 0,
        fullscreenHosts: 0,
        tileIdentityPreserved: true,
        tileOwnsVideo: true,
        topLevelFullscreenHosts: 0,
        videoCount: 1,
        videoIdentityPreserved: true,
      });
    }
  } finally {
    await ensureFullscreenExited(page);
  }
});

test("a fullscreen resize and a later Stage resize leave current geometry and responsive state fresh", async ({ page }) => {
  await resizeViewport(page, { width: 1366, height: 768 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [32 / 9],
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "theater");

  await enterStableFullscreen(page);
  let fullscreenMetrics = null;
  try {
    fullscreenMetrics = await emulateFullscreenViewport(page, { width: 900, height: 500 });
    expectPresentationGeometry(
      await capturePresentation(page),
      32 / 9,
      "900x500 while fullscreen",
      true,
    );
    await exitFullscreenProgrammatically(page);
  } finally {
    await ensureFullscreenExited(page);
  }

  if (fullscreenMetrics) {
    await fullscreenMetrics.send("Emulation.clearDeviceMetricsOverride");
    await fullscreenMetrics.detach();
  }
  await resizeViewport(page, { width: 900, height: 500 });

  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "compact");
  await expect(page.locator("html")).toHaveAttribute("data-ui-short", "");
  await expect(page.locator("html")).toHaveAttribute("data-ui-very-short", "");
  await closeClubhouseTools(page);
  expectPresentationGeometry(await capturePresentation(page), 32 / 9, "900x500 after exit");

  await resizeViewport(page, { width: 1920, height: 1080 });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "theater");
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-short", "");
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-very-short", "");
  expectPresentationGeometry(await capturePresentation(page), 32 / 9, "1920x1080 after post-exit resize");
});

test("fullscreen restores the previously enlarged Stage tile without replacing either share", async ({ page }) => {
  await resizeViewport(page, { width: 5120, height: 1440 });
  await openStageFixture(page, {
    participants: 3,
    cameras: 0,
    screenShares: 2,
    shareAspects: [32 / 9, 9 / 16],
  });
  const grid = page.locator("#screen-grid");
  const tiles = grid.locator(":scope > .tile");
  await expect(tiles).toHaveCount(2);
  await page.waitForTimeout(250);
  const mixedGeometry = await page.evaluate(() => {
    const gridElement = document.getElementById("screen-grid");
    const gridBounds = gridElement.getBoundingClientRect();
    const tileElements = Array.from(gridElement.querySelectorAll(":scope > .tile"));
    const tileBounds = tileElements.map((tile) => tile.getBoundingClientRect());
    const overlapWidth = Math.max(0, Math.min(tileBounds[0].right, tileBounds[1].right) -
      Math.max(tileBounds[0].left, tileBounds[1].left));
    const overlapHeight = Math.max(0, Math.min(tileBounds[0].bottom, tileBounds[1].bottom) -
      Math.max(tileBounds[0].top, tileBounds[1].top));
    return {
      grid: { bottom: gridBounds.bottom, left: gridBounds.left, right: gridBounds.right, top: gridBounds.top },
      gridTracks: {
        columns: gridElement.style.gridTemplateColumns,
        rows: gridElement.style.gridTemplateRows,
      },
      overlapArea: overlapWidth * overlapHeight,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tiles: tileElements.map((tile, index) => ({
        aspect: tileBounds[index].width / tileBounds[index].height,
        bounds: {
          bottom: tileBounds[index].bottom,
          left: tileBounds[index].left,
          right: tileBounds[index].right,
          top: tileBounds[index].top,
        },
        publishedAspect: Number.parseFloat(tile.style.getPropertyValue("--screen-source-aspect-ratio")),
      })),
    };
  });
  expect(mixedGeometry.gridTracks.columns).not.toBe("");
  expect(mixedGeometry.gridTracks.rows).not.toBe("");
  expect(mixedGeometry.overlapArea).toBeLessThanOrEqual(1);
  expect(mixedGeometry.pageOverflowX).toBeLessThanOrEqual(1);
  for (const [index, expectedAspect] of [[0, 32 / 9], [1, 9 / 16]]) {
    expect(mixedGeometry.tiles[index].aspect, `mixed tile ${index} aspect`).toBeCloseTo(expectedAspect, 2);
    expect(mixedGeometry.tiles[index].publishedAspect, `mixed tile ${index} published aspect`).toBeCloseTo(expectedAspect, 3);
    expectContainedRect(mixedGeometry.tiles[index].bounds, mixedGeometry.grid, `mixed tile ${index} containment`);
  }

  await tiles.nth(0).click({ position: { x: 16, y: 56 } });
  await expect(grid).toHaveClass(/is-focused/);
  await expect(tiles.nth(0)).toHaveClass(/is-focused/);
  const expectFocusedGeometry = async (label) => {
    const readGeometry = () => page.evaluate(() => {
      const gridElement = document.getElementById("screen-grid");
      const tile = gridElement.querySelector(":scope > .tile.is-focused");
      const video = tile.querySelector("video.screen-video-surface");
      const gridBounds = gridElement.getBoundingClientRect();
      const tileBounds = tile.getBoundingClientRect();
      return {
        gridHeight: gridBounds.height,
        gridWidth: gridBounds.width,
        objectFit: getComputedStyle(video).objectFit,
        sourceAspect: video.videoWidth / video.videoHeight,
        tileHeight: tileBounds.height,
        tileWidth: tileBounds.width,
      };
    });
    await expect.poll(async () => {
      const settled = await readGeometry();
      return settled.tileWidth / settled.gridWidth;
    }, { message: `${label}: focused share should settle across the Stage` }).toBeGreaterThanOrEqual(0.96);
    const geometry = await readGeometry();
    expect(geometry.tileWidth / geometry.gridWidth, `${label}: focused width usage`).toBeGreaterThanOrEqual(0.96);
    expect(geometry.tileHeight / geometry.gridHeight, `${label}: focused height usage`).toBeGreaterThanOrEqual(0.72);
    expect(geometry.objectFit, `${label}: fit policy`).toBe("contain");
    expect(geometry.sourceAspect, `${label}: source aspect`).toBeCloseTo(32 / 9, 3);
  };
  await expectFocusedGeometry("before fullscreen");
  await rememberStableNodes(page, "focused-share", 0);
  await rememberStableNodes(page, "unfocused-share", 1);

  await enterStableFullscreen(page, 0);
  try {
    await exitFullscreenThroughControl(page, 0);
  } finally {
    await ensureFullscreenExited(page);
  }

  await expect(grid).toHaveClass(/is-focused/);
  await expect(tiles.nth(0)).toHaveClass(/is-focused/);
  await expect(tiles.nth(1)).not.toHaveClass(/is-focused/);
  await expectFocusedGeometry("after fullscreen");
  for (const [key, index] of [["focused-share", 0], ["unfocused-share", 1]]) {
    const state = await readStableNodeState(page, key, index);
    expect(state.tileIdentityPreserved, `${key}: tile identity`).toBe(true);
    expect(state.videoIdentityPreserved, `${key}: video identity`).toBe(true);
    expect(state.videoCount, `${key}: video count`).toBe(1);
  }
});

test("the in-tile fullscreen control remains visible, hittable, and keyboard-reachable for exit", async ({ page }) => {
  await resizeViewport(page, { width: 1366, height: 768 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [16 / 10],
  });

  const tile = await enterStableFullscreen(page);
  try {
    const exitControl = tile.getByRole("button", { name: "Exit shared screen fullscreen" });
    await expect(exitControl).toBeVisible();
    const reachability = await exitControl.evaluate((control) => {
      const bounds = control.getBoundingClientRect();
      const hostBounds = document.fullscreenElement.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      control.focus();
      return {
        active: document.activeElement === control,
        contained: bounds.left >= hostBounds.left - 1 && bounds.right <= hostBounds.right + 1 &&
          bounds.top >= hostBounds.top - 1 && bounds.bottom <= hostBounds.bottom + 1,
        height: bounds.height,
        hittable: hit === control || control.contains(hit),
        width: bounds.width,
      };
    });
    expect(reachability.active).toBe(true);
    expect(reachability.contained).toBe(true);
    expect(reachability.hittable).toBe(true);
    expect(reachability.width).toBeGreaterThanOrEqual(39.5);
    expect(reachability.width).toBeLessThanOrEqual(40.5);
    expect(reachability.height).toBeGreaterThanOrEqual(39.5);
    expect(reachability.height).toBeLessThanOrEqual(40.5);

    await exitControl.press("Enter");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await waitForLayout(page, 3);
    await expect(tile.getByRole("button", { name: "Open shared screen fullscreen" })).toBeFocused();
  } finally {
    await ensureFullscreenExited(page);
  }
});

test("representative viewer and source ratios use the maximal contained Stage and fullscreen geometry", async ({ page }) => {
  test.slow();
  await resizeViewport(page, viewerMatrix[0]);
  await openStageFixture(page, {
    participants: sourceMatrix.length,
    cameras: 0,
    screenShares: sourceMatrix.length,
    shareAspects: sourceMatrix.map((source) => source.aspect),
  });
  await expect(page.locator("#screen-grid > .tile")).toHaveCount(sourceMatrix.length);
  await page.evaluate(() => {
    window.__fullscreenMatrixNodes = Array.from(document.querySelectorAll("#screen-grid > .tile")).map((tile) => ({
      button: tile.querySelector(".tile-fullscreen-btn"),
      tile,
      video: tile.querySelector("video.screen-video-surface"),
    }));
  });

  const policyFits = await page.evaluate(({ sources, viewers }) => viewers.flatMap((viewer) =>
    sources.map((source) => {
      const fitted = window.EchoLayoutPolicy.fitAspectRatio(
        viewer.width,
        viewer.height,
        source.aspect,
      );
      return {
        height: fitted.height,
        source: source.label,
        viewer: viewer.label,
        width: fitted.width,
      };
    })), {
    sources: sourceMatrix.map(({ aspect, label }) => ({ aspect, label })),
    viewers: viewerMatrix.map(({ height, label, width }) => ({ height, label, width })),
  });
  expect(policyFits).toHaveLength(viewerMatrix.length * sourceMatrix.length);
  for (const viewer of viewerMatrix) {
    for (const source of sourceMatrix) {
      const fitted = policyFits.find((entry) => entry.viewer === viewer.label && entry.source === source.label);
      const expectedWidth = Math.min(viewer.width, viewer.height * source.aspect);
      const expectedHeight = Math.min(viewer.height, viewer.width / source.aspect);
      const label = `${viewer.label} policy fit for ${source.label}`;
      expect(fitted.width, `${label}: width`).toBeCloseTo(expectedWidth, 6);
      expect(fitted.height, `${label}: height`).toBeCloseTo(expectedHeight, 6);
      expect(fitted.width, `${label}: viewport width constraint`).toBeLessThanOrEqual(viewer.width);
      expect(fitted.height, `${label}: viewport height constraint`).toBeLessThanOrEqual(viewer.height);
      expect(fitted.width / fitted.height, `${label}: undistorted aspect`).toBeCloseTo(source.aspect, 6);
      expect(
        Math.abs(fitted.width - viewer.width) < 1e-6 ||
          Math.abs(fitted.height - viewer.height) < 1e-6,
        `${label}: maximal fit must touch one viewport axis`,
      ).toBe(true);
    }
  }

  for (let viewerIndex = 0; viewerIndex < viewerMatrix.length; viewerIndex += 1) {
    const viewer = viewerMatrix[viewerIndex];
    const sourceIndex = viewerIndex % sourceMatrix.length;
    const source = sourceMatrix[sourceIndex];
    await resizeViewport(page, viewer);
    await showOnlyShare(page, sourceIndex);
    expectPresentationGeometry(
      await capturePresentation(page, sourceIndex),
      source.aspect,
      `${viewer.label} Stage with ${source.label} source`,
    );

    // The complete 6x6 policy matrix above is synchronous. These six real
    // pairwise transitions cover every required viewer and source exactly once.
    await enterStableFullscreen(page, sourceIndex);
    try {
      expectPresentationGeometry(
        await capturePresentation(page, sourceIndex),
        source.aspect,
        `${viewer.label} fullscreen with ${source.label} source`,
        true,
      );
      await exitFullscreenThroughControl(page, sourceIndex);
    } finally {
      await ensureFullscreenExited(page);
    }
    expectPresentationGeometry(
      await capturePresentation(page, sourceIndex),
      source.aspect,
      `${viewer.label} restored Stage with ${source.label} source`,
    );
  }

  const identities = await page.evaluate(() => {
    const current = Array.from(document.querySelectorAll("#screen-grid > .tile"));
    return current.map((tile, index) => ({
      button: tile.querySelector(".tile-fullscreen-btn") === window.__fullscreenMatrixNodes[index].button,
      tile: tile === window.__fullscreenMatrixNodes[index].tile,
      video: tile.querySelector("video.screen-video-surface") === window.__fullscreenMatrixNodes[index].video,
      videoCount: tile.querySelectorAll("video.screen-video-surface").length,
    }));
  });
  expect(identities).toEqual(sourceMatrix.map(() => ({
    button: true,
    tile: true,
    video: true,
    videoCount: 1,
  })));
});

test("display scaling and browser zoom feed CSS viewport pixels into the same layout policy", async ({ page }) => {
  const physicalViewport = { height: 1080, width: 1920 };
  const scales = [
    { css: { height: 1080, width: 1920 }, mode: "theater", scale: 1 },
    { css: { height: 864, width: 1536 }, mode: "theater", scale: 1.25 },
    { css: { height: 720, width: 1280 }, mode: "theater", scale: 1.5 },
    { css: { height: 540, width: 960 }, mode: "compact", scale: 2 },
  ];

  await resizeViewport(page, physicalViewport);
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [21 / 9],
  });
  await closeClubhouseTools(page);
  const session = await page.context().newCDPSession(page);
  try {
    for (const entry of scales) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: entry.scale,
        height: entry.css.height,
        mobile: false,
        screenHeight: entry.css.height,
        screenWidth: entry.css.width,
        width: entry.css.width,
      });
      await expect.poll(() => page.evaluate(() => ({
        dpr: devicePixelRatio,
        height: innerHeight,
        mode: document.documentElement.dataset.uiMode,
        width: innerWidth,
      })), { message: `${entry.scale * 100}% scale should settle in CSS pixels` }).toEqual({
        dpr: entry.scale,
        height: entry.css.height,
        mode: entry.mode,
        width: entry.css.width,
      });
      await waitForLayout(page, 3);
      const presentation = await capturePresentation(page);
      expectPresentationGeometry(
        presentation,
        21 / 9,
        `${entry.scale * 100}% scale at ${entry.css.width}x${entry.css.height} CSS pixels`,
      );
      expect(Math.round(presentation.viewport.width * presentation.viewport.dpr)).toBe(physicalViewport.width);
      expect(Math.round(presentation.viewport.height * presentation.viewport.dpr)).toBe(physicalViewport.height);
    }
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride");
    await session.detach();
  }
});

test("compact and mini heights keep the Stage, call dock, and fullscreen exit control usable", async ({ page }) => {
  await resizeViewport(page, { width: 900, height: 480 });
  await openStageFixture(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [4 / 3],
  });
  await closeClubhouseTools(page);

  for (const viewport of [
    { height: 480, mode: "compact", visibleDockControls: 5, width: 900 },
    { height: 420, mode: "mini", visibleDockControls: 4, width: 640 },
  ]) {
    await resizeViewport(page, viewport);
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const stageHeights = [];
    for (const connectedControls of [false, true]) {
      await page.locator("#call-controls").evaluate((dock, connected) => {
        dock.classList.toggle("hidden", !connected);
      }, connectedControls);
      await waitForLayout(page);
      const controls = await page.evaluate(() => {
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
        const dock = document.getElementById("call-controls");
        const stage = document.querySelector(".room-main");
        const dockRect = rect(dock);
        const stageRect = rect(stage);
        const buttons = Array.from(dock.querySelectorAll("button")).filter((button) => {
          const style = getComputedStyle(button);
          return button.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
        });
        return {
          buttons: buttons.map((button) => ({ id: button.id, rect: rect(button) })),
          dock: dockRect,
          overlap: Math.max(0, Math.min(stageRect.bottom, dockRect.bottom) - Math.max(stageRect.top, dockRect.top)),
          pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          pageOverflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
          stage: stageRect,
          viewport: { height: window.innerHeight, width: window.innerWidth },
        };
      });

      stageHeights.push(controls.stage.height);
      expect(controls.buttons, `${viewport.width}x${viewport.height}: visible call controls`).toHaveLength(
        viewport.visibleDockControls,
      );
      expect(controls.overlap, `${viewport.width}x${viewport.height}: Stage/dock overlap`).toBeLessThanOrEqual(1);
      expect(controls.pageOverflowX, `${viewport.width}x${viewport.height}: horizontal overflow`).toBeLessThanOrEqual(1);
      expect(controls.pageOverflowY, `${viewport.width}x${viewport.height}: vertical overflow`).toBeLessThanOrEqual(1);
      expectContainedRect(
        controls.dock,
        { bottom: controls.viewport.height, left: 0, right: controls.viewport.width, top: 0 },
        `${viewport.width}x${viewport.height}: dock containment`,
      );
      for (const button of controls.buttons) {
        expect(button.rect.width, `${viewport.width}x${viewport.height}: ${button.id} width`).toBeGreaterThanOrEqual(39.5);
        expect(button.rect.height, `${viewport.width}x${viewport.height}: ${button.id} height`).toBeGreaterThanOrEqual(39.5);
        expectContainedRect(button.rect, controls.dock, `${viewport.width}x${viewport.height}: ${button.id} containment`);
      }
      expectPresentationGeometry(
        await capturePresentation(page),
        4 / 3,
        `${viewport.width}x${viewport.height} with ${connectedControls ? "connected" : "pre-connect"} controls`,
      );
    }
    expect(Math.abs(stageHeights[0] - stageHeights[1]), `${viewport.width}x${viewport.height}: dock state geometry`).toBeLessThanOrEqual(1);
  }

  await enterStableFullscreen(page);
  try {
    expectPresentationGeometry(await capturePresentation(page), 4 / 3, "640x420 fullscreen", true);
    await exitFullscreenThroughControl(page);
  } finally {
    await ensureFullscreenExited(page);
  }
  expectPresentationGeometry(await capturePresentation(page), 4 / 3, "640x420 restored Stage");
});
