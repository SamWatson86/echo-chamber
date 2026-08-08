import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  expectContained,
  expectMinimumUsableRegion,
  expectNoDocumentOverflow,
  expectNoOverlap,
  expectSingleLineEllipsis,
  intersectionArea,
} from "./helpers/geometry.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const runtimeErrors = new WeakMap();
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const shellSelectors = Object.freeze([
  "#clubhouse-shell",
  '.room-top[data-ui-region="shell-header"]',
  '.room-layout[data-ui-region="workspace"]',
  '.room-main[data-ui-region="primary-stage"]',
  '.utility-host[data-ui-region="utility-host"]',
  '#call-controls[data-ui-region="control-dock"]',
  "#shell-overlay-root",
  "#shell-notification-layer",
]);
const preservedDraft = "Phase 1 draft survives every shell transition";

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

async function primePersistedVariant(page, persistedValue) {
  await page.addInitScript(({ value }) => {
    if (value === null) localStorage.removeItem("echo-ui-shell-v2");
    else localStorage.setItem("echo-ui-shell-v2", value);

    window.__echoShellFirstFrame = new Promise((resolve) => {
      requestAnimationFrame(() => resolve(
        document.documentElement && document.documentElement.getAttribute("data-ui-shell"),
      ));
    });
  }, { value: persistedValue });
}

async function openPhaseOneViewer(page, scenario) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await page.addScriptTag({ path: fixturePath });
  return page.evaluate((options) => window.EchoLayoutTestScenario.install(options), scenario);
}

async function settleResize(page, viewport, expectedMode) {
  await page.setViewportSize(viewport);
  await expect.poll(
    () => page.evaluate(() => ({ height: window.innerHeight, width: window.innerWidth })),
    { message: `browser viewport should become ${viewport.width}x${viewport.height}` },
  ).toEqual({ height: viewport.height, width: viewport.width });
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", expectedMode);
}

async function resolveThemeColor(page, declaration) {
  return page.evaluate((value) => {
    const probe = document.createElement("span");
    probe.style.color = value;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, declaration);
}

async function expectCanonicalStructure(page) {
  for (const selector of shellSelectors) {
    await expect(page.locator(selector), `${selector} must be unique`).toHaveCount(1);
  }

  const structure = await page.evaluate((selectors) => {
    const shell = document.getElementById("clubhouse-shell");
    const header = document.querySelector('.room-top[data-ui-region="shell-header"]');
    const workspace = document.querySelector('.room-layout[data-ui-region="workspace"]');
    const stage = document.querySelector('.room-main[data-ui-region="primary-stage"]');
    const utility = document.querySelector('.utility-host[data-ui-region="utility-host"]');
    const dock = document.querySelector('#call-controls[data-ui-region="control-dock"]');
    const idCounts = new Map();
    document.querySelectorAll("[id]").forEach((element) => {
      idCounts.set(element.id, (idCounts.get(element.id) || 0) + 1);
    });
    return {
      duplicateIds: Array.from(idCounts.entries()).filter((entry) => entry[1] > 1),
      shellContainsRegions: shell.contains(header) && shell.contains(workspace) && shell.contains(dock),
      uniqueSelectors: selectors.every((selector) => document.querySelectorAll(selector).length === 1),
      workspaceContainsRegions: workspace.contains(stage) && workspace.contains(utility),
    };
  }, shellSelectors);

  expect(structure).toEqual({
    duplicateIds: [],
    shellContainsRegions: true,
    uniqueSelectors: true,
    workspaceContainsRegions: true,
  });
}

const flagCases = [
  {
    title: "defaults to V2 when neither storage nor query overrides the shell",
    persisted: null,
    query: "",
    expected: "v2",
  },
  {
    title: "uses the persisted V2 shell when the query is absent",
    persisted: "1",
    query: "",
    expected: "v2",
  },
  {
    title: "uses the persisted legacy shell when the query is absent",
    persisted: "0",
    query: "",
    expected: "legacy",
  },
  {
    title: "query V2 overrides persisted legacy",
    persisted: "0",
    query: "?echo-ui-shell-v2=1",
    expected: "v2",
  },
  {
    title: "query legacy overrides persisted V2",
    persisted: "1",
    query: "?echo-ui-shell-v2=0",
    expected: "legacy",
  },
];

for (const flagCase of flagCases) {
  test(flagCase.title, async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await primePersistedVariant(page, flagCase.persisted);
    await page.goto(`/${flagCase.query}`, { waitUntil: "domcontentloaded" });

    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-ui-shell", flagCase.expected);
    expect(await page.evaluate(() => window.__echoShellFirstFrame)).toBe(flagCase.expected);
    if (flagCase.expected === "v2") {
      await expect(root).toHaveAttribute("data-ui-mode", "lounge");
    } else {
      await expect(root).not.toHaveAttribute("data-ui-mode", /.+/);
    }
  });
}

test("production controller applies live layout modes and the full hysteresis sequence", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });

  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "compact");
  expect(await page.evaluate(() => ({
    applyVariant: typeof window.EchoUiShell?.applyVariant,
    policy: typeof window.EchoLayoutPolicy?.resolveLayoutPolicy,
  }))).toEqual({ applyVariant: "function", policy: "function" });

  await page.evaluate(() => {
    const root = document.documentElement;
    window.__echoModeHistory = [root.getAttribute("data-ui-mode")];
    window.__echoModeObserver = new MutationObserver(() => {
      const current = root.getAttribute("data-ui-mode");
      if (window.__echoModeHistory.at(-1) !== current) window.__echoModeHistory.push(current);
    });
    window.__echoModeObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-ui-mode"],
    });
  });

  const sequence = [
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 591, height: 900 }, "mini"],
    [{ width: 687, height: 900 }, "mini"],
    [{ width: 688, height: 900 }, "compact"],
    [{ width: 948, height: 648 }, "lounge"],
    [{ width: 1328, height: 768 }, "theater"],
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 1231, height: 720 }, "lounge"],
    [{ width: 851, height: 620 }, "compact"],
  ];

  for (const [viewport, expectedMode] of sequence) {
    await settleResize(page, viewport, expectedMode);
  }

  expect(await page.evaluate(() => window.__echoModeHistory)).toEqual([
    "compact",
    "mini",
    "compact",
    "lounge",
    "theater",
    "lounge",
    "compact",
  ]);
  await expect(page.locator("html")).toHaveAttribute("data-ui-short", "");
  await expect(page.locator("html")).not.toHaveAttribute("data-ui-very-short", "");
});

test("V2 exposes one canonical semantic shell structure", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
  });
  await expectCanonicalStructure(page);
});

test("canonical nodes, media tracks, participant state, and Chat draft survive resize and variant toggles", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
    chatOpen: true,
    unbrokenNames: true,
  });
  await expectCanonicalStructure(page);

  await page.evaluate(({ selectors, draft }) => {
    const cameraCard = document.querySelector(".user-card.has-camera");
    const state = participantState.get(cameraCard.dataset.identity);
    state.__layoutFixtureMarker = "participant-state-preserved";
    document.querySelector("#screen-grid > .tile").click();
    const chatInput = document.getElementById("chat-input");
    chatInput.value = draft;
    chatInput.focus();
    chatInput.setSelectionRange(8, 15);
    window.__echoCanonicalNodeSnapshot = selectors.map((selector) => document.querySelector(selector));
    window.EchoLayoutTestScenario.captureIdentitySnapshot();
  }, { selectors: shellSelectors, draft: preservedDraft });

  async function expectPreserved(label) {
    const preserved = await page.evaluate((selectors) => {
      const savedNodes = window.__echoCanonicalNodeSnapshot;
      return {
        canonicalNodes: selectors.every((selector, index) => (
          document.querySelectorAll(selector).length === 1 &&
          document.querySelector(selector) === savedNodes[index] &&
          savedNodes[index].isConnected
        )),
        identity: window.EchoLayoutTestScenario.inspectIdentitySnapshot(),
      };
    }, shellSelectors);

    expect(preserved, label).toEqual({
      canonicalNodes: true,
      identity: {
        cameraSdkTrack: true,
        cameraStream: true,
        cameraTrack: true,
        cameraTrackState: "live",
        cameraVideo: true,
        chatFocused: true,
        chatInput: true,
        chatOpen: true,
        chatPanel: true,
        draft: preservedDraft,
        participantCard: true,
        participantMarker: "participant-state-preserved",
        participantState: true,
        selectionEnd: 15,
        selectionStart: 8,
        screenSdkTrack: true,
        screenStream: true,
        screenTile: true,
        screenTrack: true,
        screenTrackState: "live",
        screenVideo: true,
        shareFocused: true,
      },
    });
  }

  await expectPreserved("initial V2 state");
  await settleResize(page, { width: 1024, height: 768 }, "lounge");
  await expectPreserved("lounge resize");
  await settleResize(page, { width: 640, height: 480 }, "compact");
  await expectPreserved("compact resize");

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expectPreserved("legacy live toggle");

  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await expectPreserved("V2 live toggle");
  await expectCanonicalStructure(page);
});

for (const viewport of [
  { width: 960, height: 540, veryShort: false },
  { width: 640, height: 480, veryShort: true },
]) {
  test(`V2 keeps a usable participant region at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openPhaseOneViewer(page, {
      participants: 4,
      cameras: 2,
      screenShares: 1,
      longNames: true,
    });

    const root = page.locator("html");
    await expect(root).toHaveAttribute("data-ui-mode", "compact");
    await expect(root).toHaveAttribute("data-ui-short", "");
    if (viewport.veryShort) {
      await expect(root).toHaveAttribute("data-ui-very-short", "");
    } else {
      await expect(root).not.toHaveAttribute("data-ui-very-short", "");
    }

    const userList = page.locator("#user-list");
    const geometry = await userList.evaluate((element) => {
      const firstCard = element.querySelector(".user-card");
      const listRect = element.getBoundingClientRect();
      const cardRect = firstCard.getBoundingClientRect();
      const visibleHeight = Math.max(
        0,
        Math.min(listRect.bottom, cardRect.bottom, window.innerHeight) -
          Math.max(listRect.top, cardRect.top, 0),
      );
      return {
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        firstCardVisibleRatio: visibleHeight / Math.max(1, cardRect.height),
        listBottom: listRect.bottom,
        listTop: listRect.top,
        scrollHeight: element.scrollHeight,
        viewportHeight: window.innerHeight,
      };
    });

    const geometryLabel = `${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`;
    expect.soft(geometry.clientWidth, geometryLabel).toBeGreaterThanOrEqual(160);
    expect.soft(geometry.clientHeight, geometryLabel).toBeGreaterThanOrEqual(160);
    expect.soft(geometry.firstCardVisibleRatio, geometryLabel).toBeGreaterThanOrEqual(0.5);
    expect.soft(geometry.listTop, geometryLabel).toBeGreaterThanOrEqual(-1);
    expect.soft(geometry.listBottom, geometryLabel).toBeLessThanOrEqual(geometry.viewportHeight + 1);
    expect.soft(geometry.scrollHeight, geometryLabel).toBeGreaterThanOrEqual(geometry.clientHeight);
    await expectNoDocumentOverflow(page);
  });
}

test("V2 keeps a nonzero usable stage when Chat is open at 800x600", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
    chatOpen: true,
  });

  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "compact");
  await expect(page.locator("#chat-panel")).toBeVisible();
  await expectMinimumUsableRegion(page.locator(".room-main"), { width: 160, height: 120 });
  await expectNoDocumentOverflow(page);
});

test("single-share presentation fills the grid independently of decoded resolution", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, {
    participants: 2,
    cameras: 0,
    screenShares: 1,
    shareAspects: [16 / 9],
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "theater");

  const grid = page.locator("#screen-grid");
  const tile = grid.locator(":scope > .tile");
  const video = tile.locator("video.screen-video-surface");
  const fullscreen = tile.locator(".tile-fullscreen-btn");
  const stageHeading = page.locator(".room-main .grid-header h2");
  await expect(tile).toHaveCount(1);
  await expect(video).toHaveCount(1);
  await expect(fullscreen).toBeVisible();
  await expect(stageHeading).not.toHaveCSS("display", "none");
  await expect(stageHeading).toHaveCSS("position", "absolute");
  await expect(page.getByRole("heading", { name: "The Stage" })).toHaveCount(1);

  let baselineTile = null;
  for (const decoded of [
    { width: 320, height: 180 },
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
    { width: 1920, height: 1080 },
  ]) {
    await video.evaluate((element, dimensions) => {
      Object.defineProperties(element, {
        videoHeight: { configurable: true, get: () => dimensions.height },
        videoWidth: { configurable: true, get: () => dimensions.width },
      });
      element.dispatchEvent(new Event("resize"));
    }, decoded);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    const presentation = await page.evaluate(() => {
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
      const gridElement = document.getElementById("screen-grid");
      const tileElement = gridElement.querySelector(":scope > .tile");
      const videoElement = tileElement.querySelector("video.screen-video-surface");
      const fullscreenElement = tileElement.querySelector(".tile-fullscreen-btn");
      const fullscreenStyle = getComputedStyle(fullscreenElement);
      const gridRect = rect(gridElement);
      const tileRect = rect(tileElement);
      return {
        decoded: { height: videoElement.videoHeight, width: videoElement.videoWidth },
        fillRatio: (tileRect.width * tileRect.height) / (gridRect.width * gridRect.height),
        fullscreen: rect(fullscreenElement),
        fullscreenPosition: fullscreenStyle.position,
        grid: gridRect,
        objectFit: getComputedStyle(videoElement).objectFit,
        tile: tileRect,
        video: rect(videoElement),
      };
    });

    expect(presentation.decoded, `${decoded.width}x${decoded.height} decoded size`).toEqual(decoded);
    expect(presentation.fillRatio, `${decoded.width}px decoded width`).toBeGreaterThanOrEqual(0.95);
    expect(presentation.objectFit).toBe("contain");
    expect(presentation.fullscreenPosition).toBe("absolute");
    expect(presentation.fullscreen.width).toBeGreaterThanOrEqual(39.5);
    expect(presentation.fullscreen.width).toBeLessThanOrEqual(40.5);
    expect(presentation.fullscreen.height).toBeGreaterThanOrEqual(39.5);
    expect(presentation.fullscreen.height).toBeLessThanOrEqual(40.5);

    for (const region of [presentation.tile, presentation.video, presentation.fullscreen]) {
      expect(region.left).toBeGreaterThanOrEqual(presentation.grid.left - 1);
      expect(region.right).toBeLessThanOrEqual(presentation.grid.right + 1);
      expect(region.top).toBeGreaterThanOrEqual(presentation.grid.top - 1);
      expect(region.bottom).toBeLessThanOrEqual(presentation.grid.bottom + 1);
    }
    expect(intersectionArea(presentation.fullscreen, presentation.video))
      .toBeGreaterThanOrEqual(presentation.fullscreen.width * presentation.fullscreen.height * 0.95);

    if (baselineTile) {
      expect(Math.abs(presentation.tile.left - baselineTile.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(presentation.tile.top - baselineTile.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(presentation.tile.width - baselineTile.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(presentation.tile.height - baselineTile.height)).toBeLessThanOrEqual(1);
    } else {
      baselineTile = presentation.tile;
    }
  }

  await expectContained(tile, grid);
  await expectNoDocumentOverflow(page);
});

test("a retained hidden share enters solo presentation and restores the multi-share grid", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, {
    participants: 3,
    cameras: 0,
    screenShares: 2,
    shareAspects: [16 / 9, 4 / 3],
  });

  const root = page.locator("html");
  const grid = page.locator("#screen-grid");
  const tiles = grid.locator(":scope > .tile");
  const firstTile = tiles.nth(0);
  const secondTile = tiles.nth(1);

  await expect(tiles).toHaveCount(2);
  await expect(grid).toHaveAttribute("data-visible-tiles", "2");
  await expect(grid.locator(":scope > .tile[data-grid-visible]")).toHaveCount(2);
  await expect.poll(() => grid.evaluate((element) => element.style.gridTemplateColumns)).not.toBe("");

  // Production retains unpublished share tiles and hides them with display:none.
  // The remaining visible tile must still receive the immersive solo treatment.
  await secondTile.evaluate((element) => { element.style.display = "none"; });
  await expect(grid).toHaveAttribute("data-visible-tiles", "1");
  await expect(firstTile).toHaveAttribute("data-grid-visible", "");
  await expect(secondTile).not.toHaveAttribute("data-grid-visible", "");
  await expect(grid.locator(":scope > .tile[data-grid-visible]")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => {
    const gridElement = document.getElementById("screen-grid");
    const visibleTile = gridElement.querySelector(":scope > .tile[data-grid-visible]");
    const gridRect = gridElement.getBoundingClientRect();
    const visibleRect = visibleTile.getBoundingClientRect();
    return (visibleRect.width * visibleRect.height) / (gridRect.width * gridRect.height);
  }), { message: "the retained share should settle into solo Stage geometry" }).toBeGreaterThanOrEqual(0.95);

  const solo = await page.evaluate(() => {
    const gridElement = document.getElementById("screen-grid");
    const tileElements = Array.from(gridElement.querySelectorAll(":scope > .tile"));
    const gridRect = gridElement.getBoundingClientRect();
    const visibleRect = tileElements[0].getBoundingClientRect();
    return {
      fillRatio: (visibleRect.width * visibleRect.height) / (gridRect.width * gridRect.height),
      hiddenDisplay: getComputedStyle(tileElements[1]).display,
      hiddenHeight: tileElements[1].getBoundingClientRect().height,
      inlineColumns: gridElement.style.gridTemplateColumns,
      inlineRows: gridElement.style.gridTemplateRows,
    };
  });
  expect(solo.fillRatio).toBeGreaterThanOrEqual(0.95);
  expect(solo.hiddenDisplay).toBe("none");
  expect(solo.hiddenHeight).toBe(0);
  expect(solo.inlineColumns).toBe("");
  expect(solo.inlineRows).toBe("");
  await expectContained(firstTile, grid);

  await secondTile.evaluate((element) => { element.style.display = ""; });
  await expect(grid).toHaveAttribute("data-visible-tiles", "2");
  await expect(grid.locator(":scope > .tile[data-grid-visible]")).toHaveCount(2);
  await expect.poll(() => grid.evaluate((element) => element.style.gridTemplateColumns)).not.toBe("");

  const restored = await page.evaluate(() => {
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
    const gridElement = document.getElementById("screen-grid");
    return {
      grid: rect(gridElement),
      tiles: Array.from(gridElement.querySelectorAll(":scope > .tile")).map(rect),
    };
  });
  for (const tileRect of restored.tiles) {
    expect(tileRect.left).toBeGreaterThanOrEqual(restored.grid.left - 1);
    expect(tileRect.right).toBeLessThanOrEqual(restored.grid.right + 1);
    expect(tileRect.top).toBeGreaterThanOrEqual(restored.grid.top - 1);
    expect(tileRect.bottom).toBeLessThanOrEqual(restored.grid.bottom + 1);
  }
  expect(intersectionArea(restored.tiles[0], restored.tiles[1])).toBeLessThanOrEqual(1);

  // Focused mode keeps ownership of its tracks while visibility state remains available.
  await grid.evaluate((element) => { element.classList.add("is-focused"); });
  await expect.poll(() => grid.evaluate((element) => element.style.gridTemplateColumns)).toBe("");
  await expect(grid).toHaveAttribute("data-visible-tiles", "2");
  await grid.evaluate((element) => { element.classList.remove("is-focused"); });
  await expect.poll(() => grid.evaluate((element) => element.style.gridTemplateColumns)).not.toBe("");

  // The published state is V2-only and must not leak into the legacy rollback.
  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(root).toHaveAttribute("data-ui-shell", "legacy");
  await expect.poll(() => grid.evaluate((element) => ({
    columns: element.style.gridTemplateColumns,
    rows: element.style.gridTemplateRows,
    visibleMarkers: element.querySelectorAll(":scope > .tile[data-grid-visible]").length,
    visibleTiles: element.getAttribute("data-visible-tiles"),
  }))).toEqual({ columns: "", rows: "", visibleMarkers: 0, visibleTiles: null });
});

for (const stageCase of [
  {
    title: "theater",
    viewport: { width: 1920, height: 1080 },
    mode: "theater",
    shellGap: 16,
    screenShares: 4,
  },
  {
    title: "lounge",
    viewport: { width: 1024, height: 768 },
    mode: "lounge",
    shellGap: 16,
    screenShares: 2,
  },
  {
    title: "compact",
    viewport: { width: 900, height: 540 },
    mode: "compact",
    shellGap: 12,
    screenShares: 3,
  },
  {
    title: "mini",
    viewport: { width: 360, height: 640 },
    mode: "mini",
    shellGap: 8,
    screenShares: 4,
  },
]) {
  test(`${stageCase.title} active-share stage stays inside shell tracks without tile overlap`, async ({ page }) => {
    await page.setViewportSize(stageCase.viewport);
    await openPhaseOneViewer(page, {
      participants: 4,
      cameras: 0,
      screenShares: stageCase.screenShares,
      shareAspects: [16 / 9, 32 / 9, 4 / 3, 9 / 16].slice(0, stageCase.screenShares),
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", stageCase.mode);

    const header = page.locator('.room-top[data-ui-region="shell-header"]');
    const workspace = page.locator('.room-layout[data-ui-region="workspace"]');
    const stage = page.locator('.room-main[data-ui-region="primary-stage"]');
    const gridHeader = stage.locator(".grid-header");
    const grid = stage.locator("#screen-grid");
    const dock = page.locator('#call-controls[data-ui-region="control-dock"]');
    const tiles = grid.locator(":scope > .tile");

    await expect(tiles).toHaveCount(stageCase.screenShares);
    await expectContained(stage, workspace);
    await expectContained(gridHeader, stage);
    await expectContained(grid, stage);

    const geometry = await page.evaluate(() => {
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
      const gridElement = document.getElementById("screen-grid");
      return {
        dock: rect(document.getElementById("call-controls")),
        grid: rect(gridElement),
        gridClientHeight: gridElement.clientHeight,
        gridClientWidth: gridElement.clientWidth,
        gridHeader: rect(document.querySelector(".room-main .grid-header")),
        gridScrollHeight: gridElement.scrollHeight,
        gridScrollWidth: gridElement.scrollWidth,
        header: rect(document.querySelector('.room-top[data-ui-region="shell-header"]')),
        stage: rect(document.querySelector('.room-main[data-ui-region="primary-stage"]')),
        tiles: Array.from(gridElement.querySelectorAll(":scope > .tile")).map(rect),
      };
    });

    expect(geometry.stage.top).toBeGreaterThanOrEqual(geometry.header.bottom + stageCase.shellGap - 1);
    expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.dock.top - stageCase.shellGap + 1);
    expect(geometry.gridHeader.bottom).toBeLessThanOrEqual(geometry.grid.top + 1);
    expect(geometry.gridScrollWidth).toBeLessThanOrEqual(geometry.gridClientWidth + 1);
    expect(geometry.gridScrollHeight).toBeLessThanOrEqual(geometry.gridClientHeight + 1);

    for (const tileRect of geometry.tiles) {
      expect(tileRect.width).toBeGreaterThan(1);
      expect(tileRect.height).toBeGreaterThan(1);
      expect(tileRect.left).toBeGreaterThanOrEqual(geometry.grid.left - 1);
      expect(tileRect.right).toBeLessThanOrEqual(geometry.grid.right + 1);
      expect(tileRect.top).toBeGreaterThanOrEqual(geometry.grid.top - 1);
      expect(tileRect.bottom).toBeLessThanOrEqual(geometry.grid.bottom + 1);
    }
    for (let first = 0; first < geometry.tiles.length; first += 1) {
      for (let second = first + 1; second < geometry.tiles.length; second += 1) {
        expect(
          intersectionArea(geometry.tiles[first], geometry.tiles[second]),
          `${stageCase.title} tiles ${first + 1} and ${second + 1}`,
        ).toBeLessThanOrEqual(1);
      }
    }

    if (stageCase.mode === "theater") {
      const utility = page.locator('.utility-host[data-ui-region="utility-host"]');
      await expectNoOverlap(stage, utility);
      const utilityRect = await utility.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left };
      });
      expect(geometry.stage.right).toBeLessThanOrEqual(utilityRect.left - stageCase.shellGap + 1);
    }

    await expectNoDocumentOverflow(page);
  });
}

test("V2 ellipsizes a 60-character unbroken name without overlapping camera settings", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 0,
    unbrokenNames: true,
  });

  const longName = "W".repeat(60);
  const standardName = page.locator(".user-card:not(.has-camera) .user-name").first();
  const standardMeta = standardName.locator("xpath=parent::*");
  await expect(standardName).toHaveText(longName);
  await expect(standardName).toHaveAttribute("title", longName);
  await expectSingleLineEllipsis(standardName);
  await expectContained(standardName, standardMeta);

  const cameraCard = page.locator(".user-card.has-camera").first();
  const overlay = cameraCard.locator(".cam-overlay");
  const overlayName = overlay.locator(".cam-overlay-name");
  const focusTarget = cameraCard.locator(":scope > .participant-settings-toggle");
  await focusTarget.focus();
  await expect(focusTarget).toBeFocused();

  const focusPresentation = await cameraCard.evaluate((card) => {
    const overlayElement = card.querySelector(".cam-overlay");
    const style = window.getComputedStyle(overlayElement);
    return {
      focusWithin: card.matches(":focus-within"),
      opacity: Number.parseFloat(style.opacity),
      pointerEvents: style.pointerEvents,
    };
  });
  expect(focusPresentation.focusWithin).toBe(true);
  expect(focusPresentation.opacity).toBeGreaterThanOrEqual(0.99);
  expect(focusPresentation.pointerEvents).not.toBe("none");

  await expect(overlayName).toHaveText(longName);
  await expect(overlayName).toHaveAttribute("title", longName);
  await expectSingleLineEllipsis(overlayName);
  await expectContained(overlayName, overlay);
  await expectContained(focusTarget, cameraCard);
  await expectNoOverlap(overlayName, focusTarget);
  await expectNoDocumentOverflow(page);
});

for (const viewport of [
  { width: 1280, height: 720, mode: "theater" },
  { width: 640, height: 480, mode: "compact" },
]) {
  test(`camera cards stay usable and contained at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, {
      participants: 4,
      cameras: 2,
      screenShares: 1,
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const cards = page.locator(".user-card.has-camera");
    await expect(cards).toHaveCount(2);
    for (let index = 0; index < await cards.count(); index += 1) {
      const card = cards.nth(index);
      await card.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
      const geometry = await card.evaluate((element) => {
        const list = element.closest("#user-list");
        const overlay = element.querySelector(".cam-overlay");
        const cardRect = element.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();
        return {
          card: { bottom: cardRect.bottom, height: cardRect.height, left: cardRect.left, right: cardRect.right, top: cardRect.top },
          list: { bottom: listRect.bottom, left: listRect.left, right: listRect.right, top: listRect.top },
          overlay: { bottom: overlayRect.bottom, left: overlayRect.left, right: overlayRect.right, top: overlayRect.top },
          overflowX: element.scrollWidth - element.clientWidth,
        };
      });
      expect.soft(geometry.card.height).toBeGreaterThanOrEqual(139.5);
      expect.soft(geometry.card.left).toBeGreaterThanOrEqual(geometry.list.left - 1);
      expect.soft(geometry.card.right).toBeLessThanOrEqual(geometry.list.right + 1);
      expect.soft(geometry.card.top).toBeGreaterThanOrEqual(geometry.list.top - 1);
      expect.soft(geometry.card.bottom).toBeLessThanOrEqual(geometry.list.bottom + 1);
      expect.soft(geometry.overlay.left).toBeGreaterThanOrEqual(geometry.card.left - 1);
      expect.soft(geometry.overlay.right).toBeLessThanOrEqual(geometry.card.right + 1);
      expect.soft(geometry.overlay.top).toBeGreaterThanOrEqual(geometry.card.top - 1);
      expect.soft(geometry.overlay.bottom).toBeLessThanOrEqual(geometry.card.bottom + 1);
      expect.soft(geometry.overflowX).toBeLessThanOrEqual(1);
    }
  });
}

for (const viewport of [
  { width: 1280, height: 720, mode: "theater" },
  { width: 360, height: 640, mode: "mini" },
]) {
  test(`local camera is promoted exactly like remote cameras in ${viewport.mode}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, {
      participants: 3,
      cameras: 1,
      localCamera: true,
      screenShares: 0,
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const localCard = page.locator(".user-card.is-local.has-camera");
    const remoteCard = page.locator(".user-card.is-remote.has-camera");
    await expect(localCard).toHaveCount(1);
    await expect(remoteCard).toHaveCount(1);
    await expect(localCard.locator(".user-name")).toBeVisible();

    for (const card of [localCard, remoteCard]) {
      await card.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
      const geometry = await card.evaluate((element) => {
        const cardRect = element.getBoundingClientRect();
        const videoRect = element.querySelector("video").getBoundingClientRect();
        return {
          ratio: cardRect.width / cardRect.height,
          videoHeightDelta: Math.abs(videoRect.height - cardRect.height),
          videoWidthDelta: Math.abs(videoRect.width - cardRect.width),
        };
      });
      expect.soft(geometry.ratio).toBeGreaterThan(1.73);
      expect.soft(geometry.ratio).toBeLessThan(1.82);
      // The card's 1px border accounts for a 2px outer-size difference.
      expect.soft(geometry.videoHeightDelta).toBeLessThanOrEqual(2.1);
      expect.soft(geometry.videoWidthDelta).toBeLessThanOrEqual(2.1);
      await expectContained(card.locator("video"), card);
    }

    await page.evaluate(() => {
      const local = document.querySelector(".user-card.is-local");
      updateAvatarVideo(participantCards.get(local.dataset.identity), null);
    });
    await expect(page.locator(".user-card.is-local")).not.toHaveClass(/has-camera/);
    await expect(page.locator(".user-card.is-local .user-avatar video")).toHaveCount(0);
  });
}

test("publisher microphone badges stay truthful and visible in avatar and camera cards", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openPhaseOneViewer(page, {
    participants: 3,
    cameras: 1,
    screenShares: 0,
  });

  const cameraCard = page.locator(".user-card.is-remote.has-camera");
  const avatarCard = page.locator(".user-card.is-remote:not(.has-camera)");
  const cameraIdentity = await cameraCard.getAttribute("data-identity");
  const avatarIdentity = await avatarCard.getAttribute("data-identity");

  await page.evaluate(({ cameraIdentity, avatarIdentity }) => {
    window.EchoLayoutTestScenario.setParticipantMicrophoneState(cameraIdentity, {
      published: true,
      muted: true,
    });
    window.EchoLayoutTestScenario.setParticipantMicrophoneState(avatarIdentity, {
      published: false,
      muted: true,
    });
  }, { cameraIdentity, avatarIdentity });

  const cameraBadge = cameraCard.locator(".participant-mic-state");
  const avatarBadge = avatarCard.locator(".participant-mic-state");
  const mutedBorderColor = await resolveThemeColor(
    page,
    "color-mix(in srgb, var(--ec-danger) 58%, transparent)",
  );
  await expect(cameraCard).toHaveClass(/is-publisher-mic-off/);
  await expect(avatarCard).toHaveClass(/is-publisher-mic-off/);
  await expect(cameraCard).toHaveCSS("border-color", mutedBorderColor);
  await cameraCard.hover();
  await expect(cameraCard).toHaveCSS("border-color", mutedBorderColor);
  await expect(cameraBadge).toBeVisible();
  await expect(cameraBadge).toContainText("Muted");
  await expect(cameraBadge).toHaveAccessibleName(/Muted.*Friend 2/i);
  await expect(avatarBadge).toBeVisible();
  await expect(avatarBadge).toContainText("Mic off");
  await expect(avatarBadge).toHaveAccessibleName(/Mic off.*Friend 3/i);
  await expectContained(cameraBadge, cameraCard);
  await expectContained(avatarBadge, avatarCard);
  await expectNoOverlap(avatarBadge, avatarCard.locator(".participant-settings-toggle"));

  await page.evaluate((identity) => {
    window.EchoLayoutTestScenario.setParticipantMicrophoneState(identity, {
      published: true,
      muted: false,
    });
    const state = participantState.get(identity);
    state.micUserMuted = true;
    roomAudioMuted = true;
    updateActiveSpeakerUi();
  }, avatarIdentity);
  await expect(avatarCard).not.toHaveClass(/is-publisher-mic-off/);
  await expect(avatarBadge).toBeHidden();
});

test("room switching freezes local publish controls and rejects user media toggles", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, {
    participants: 2,
    cameras: 0,
    screenShares: 0,
  });

  const result = await page.evaluate(async () => {
    const calls = { camera: 0, microphone: 0 };
    room = {
      localParticipant: {
        async setCameraEnabled() { calls.camera += 1; },
        async setMicrophoneEnabled() { calls.microphone += 1; },
      },
    };
    switchingRoom = true;
    setPublishButtonsEnabled(false);

    const localCard = Array.from(participantCards.values()).find((cardRef) => cardRef.isLocal);
    const localButtons = Array.from(localCard.controls.querySelectorAll("button"));
    const dockButtons = [micBtn, camBtn, screenBtn];

    await toggleMic();
    await toggleCam();
    await toggleScreen();

    return {
      calls,
      dockDisabled: dockButtons.every((button) => button.disabled),
      localDisabled: localButtons.length > 0 && localButtons.every((button) => button.disabled),
    };
  });

  expect(result.calls).toEqual({ camera: 0, microphone: 0 });
  expect(result.dockDisabled).toBe(true);
  expect(result.localDisabled).toBe(true);
});

test("room switching waits for an in-flight mic toggle and preserves its intent", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, {
    participants: 2,
    cameras: 0,
    screenShares: 0,
  });

  const result = await page.evaluate(async () => {
    const LK = getLiveKitClient();
    const observedAtConnect = [];
    const originalConnectToRoom = connectToRoom;
    connectToRoom = async function () {
      observedAtConnect.push({
        actual: micEnabled,
        desired: desiredMicEnabledForRoomSwitch(),
      });
    };

    async function runToggleThenSwitch(initialEnabled, targetRoom) {
      roomSwitchState.forceConnected("main");
      currentRoomName = "main";
      _lastRoomSwitchTime = 0;
      switchingRoom = false;
      _isRoomSwitch = false;

      const microphonePublication = {
        source: LK.Track.Source.Microphone,
        kind: LK.Track.Kind.Audio,
        isMuted: !initialEnabled,
        track: {
          source: LK.Track.Source.Microphone,
          kind: LK.Track.Kind.Audio,
          isMuted: !initialEnabled,
          mediaStreamTrack: { readyState: "live" },
        },
      };
      const publications = new Map();
      if (initialEnabled) publications.set("mic", microphonePublication);

      let releaseSdkCall;
      const sdkCall = new Promise((resolve) => {
        releaseSdkCall = resolve;
      });
      const localCard = Array.from(participantCards.values()).find((cardRef) => cardRef.isLocal);
      const localParticipant = {
        identity: localCard.card.dataset.identity,
        name: localCard.card.querySelector(".user-name").textContent,
        isMicrophoneEnabled: initialEnabled,
        isCameraEnabled: false,
        trackPublications: publications,
        async setMicrophoneEnabled(desired) {
          await sdkCall;
          this.isMicrophoneEnabled = desired;
          microphonePublication.isMuted = !desired;
          microphonePublication.track.isMuted = !desired;
          if (desired) publications.set("mic", microphonePublication);
          else publications.delete("mic");
        },
      };

      room = { localParticipant };
      micEnabled = initialEnabled;
      syncDesiredMicToActual(initialEnabled);

      const togglePromise = toggleMic();
      await Promise.resolve();
      const connectsBeforeSwitch = observedAtConnect.length;
      const switchPromise = switchRoom(targetRoom);
      await Promise.resolve();
      const waitedForToggle = observedAtConnect.length === connectsBeforeSwitch;

      releaseSdkCall();
      await Promise.all([togglePromise, switchPromise]);
      return waitedForToggle;
    }

    try {
      const disableWaited = await runToggleThenSwitch(true, "breakout-1");
      await new Promise((resolve) => setTimeout(resolve, 550));
      const enableWaited = await runToggleThenSwitch(false, "breakout-2");
      return { disableWaited, enableWaited, observedAtConnect };
    } finally {
      connectToRoom = originalConnectToRoom;
    }
  });

  expect(result.disableWaited).toBe(true);
  expect(result.enableWaited).toBe(true);
  expect(result.observedAtConnect).toEqual([
    { actual: false, desired: false },
    { actual: true, desired: true },
  ]);
});

for (const viewport of [
  { width: 1280, height: 720, mode: "theater" },
  { width: 1024, height: 768, mode: "lounge" },
]) {
  test(`${viewport.mode} camera-card grid tracks prevent card overlap`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, { participants: 4, cameras: 2, screenShares: 0 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const cardRects = await page.locator(".user-card.has-camera").evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, left: rect.left, right: rect.right, top: rect.top, width: rect.width };
    }));
    expect(cardRects).toHaveLength(2);
    for (let first = 0; first < cardRects.length; first += 1) {
      for (let second = first + 1; second < cardRects.length; second += 1) {
        expect(intersectionArea(cardRects[first], cardRects[second])).toBeLessThanOrEqual(1);
      }
    }
  });
}

for (const viewport of [
  { width: 800, height: 600, mode: "compact" },
  { width: 600, height: 900, mode: "mini" },
]) {
  test(`${viewport.mode} camera audio settings stay contained and all sliders are hittable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, { participants: 3, cameras: 1, screenShares: 0 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const card = page.locator(".user-card.is-remote.has-camera").first();
    await card.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    await card.locator(".participant-settings-toggle").click();
    const popup = card.locator(".participant-settings-popover");
    await expect(popup).toHaveClass(/is-open/);
    await expect(popup).toBeVisible();

    const geometry = await card.evaluate((element) => {
      const toRect = (node) => {
        const rect = node.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      };
      const popupElement = element.querySelector(".participant-settings-popover");
      const sliders = Array.from(popupElement.querySelectorAll('input[type="range"]'));
      return {
        card: toRect(element),
        popup: toRect(popupElement),
        viewport: { height: window.innerHeight, width: window.innerWidth },
        sliders: sliders.map((slider) => {
          const rect = slider.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
          return { rect: toRect(slider), hittable: hit === slider || slider.contains(hit) };
        }),
      };
    });
    expect(geometry.sliders).toHaveLength(3);
    expect(geometry.popup.left).toBeGreaterThanOrEqual(0);
    expect(geometry.popup.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.popup.top).toBeGreaterThanOrEqual(0);
    expect(geometry.popup.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.sliders.every((slider) => slider.hittable)).toBe(true);
  });
}

test("non-camera participant overlays are absent from rendering and interaction", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 1,
    screenShares: 0,
  });

  const overlays = page.locator(".user-card.is-remote:not(.has-camera) .cam-overlay");
  expect(await overlays.count()).toBeGreaterThan(0);
  const presentations = await overlays.evaluateAll((elements) => elements.map((element) => {
    const button = element.querySelector("button");
    button?.focus();
    return {
      active: document.activeElement === button,
      display: getComputedStyle(element).display,
      renderedRects: element.getClientRects().length,
    };
  }));
  for (const presentation of presentations) {
    expect(presentation).toEqual({ active: false, display: "none", renderedRects: 0 });
  }
});

for (const viewport of [
  { width: 800, height: 600, mode: "compact" },
  { width: 600, height: 900, mode: "mini" },
]) {
  test(`${viewport.mode} dock icons remain distinct and Leave remains destructive`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const presentation = await page.locator("#call-controls").evaluate((dock) => {
      const ids = ["toggle-mic", "toggle-cam", "toggle-screen", "dock-output", "dock-leave"];
      const controls = ids.map((id) => {
        const button = dock.querySelector(`#${id}`);
        const style = getComputedStyle(button);
        const pseudo = getComputedStyle(button, "::before");
        return {
          background: style.backgroundColor,
          border: style.borderColor,
          color: style.color,
          icon: style.getPropertyValue("--club-control-icon").trim(),
          mask: pseudo.maskImage || pseudo.webkitMaskImage,
          visible: button.getClientRects().length > 0,
        };
      });
      return controls;
    });

    const expectedVisibility = viewport.mode === "mini"
      ? [true, true, true, false, true]
      : [true, true, true, true, true];
    expect(presentation.map((control) => control.visible)).toEqual(expectedVisibility);
    expect(presentation.every((control) => control.icon && control.icon !== "none")).toBe(true);
    expect(presentation.every((control) => control.mask && control.mask !== "none")).toBe(true);
    expect(new Set(presentation.map((control) => control.icon)).size).toBe(presentation.length);

    const neutral = presentation[3];
    const leave = presentation[4];
    const leaveRgb = leave.color.match(/\d+(?:\.\d+)?/g).map(Number);
    expect(leave.color).not.toBe(neutral.color);
    expect(leave.border).not.toBe(neutral.border);
    expect(leave.background).not.toBe(neutral.background);
    expect(leaveRgb[0]).toBeGreaterThan(leaveRgb[1]);
    expect(leaveRgb[0]).toBeGreaterThan(leaveRgb[2]);
  });
}

test("More has a visible affordance, focuses its first command, and restores focus on Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });

  const more = page.locator("#shell-more-actions");
  const menu = page.locator("#shell-overflow-menu");
  const firstCommand = menu.locator("button:not(.hidden):not(:disabled):visible").first();
  const visual = await more.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const pseudo = getComputedStyle(button, "::before");
    return {
      content: pseudo.content,
      height: rect.height,
      opacity: Number.parseFloat(getComputedStyle(button).opacity),
      width: rect.width,
    };
  });
  expect(visual.width).toBeGreaterThanOrEqual(40);
  expect(visual.height).toBeGreaterThanOrEqual(40);
  expect(visual.opacity).toBeGreaterThan(0);
  expect(visual.content).not.toBe("none");
  expect(visual.content).not.toBe('""');

  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('.room-top[data-ui-region="shell-header"]')).toHaveClass(/shell-overflow-open/);
  await expect(firstCommand).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('.room-top[data-ui-region="shell-header"]')).not.toHaveClass(/shell-overflow-open/);
  await expect(more).toBeFocused();

  await more.click();
  await expect(firstCommand).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more).toBeFocused();
});

test("responsive mode changes close More and preserve keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "mini");

  const more = page.locator("#shell-more-actions");
  await page.locator("#open-settings").evaluate((button) => { button.disabled = false; });
  await more.click();
  await expect(page.locator("#open-settings")).toBeFocused();
  await expect(more).toHaveAttribute("aria-expanded", "true");

  await settleResize(page, { width: 800, height: 600 }, "compact");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('.room-top[data-ui-region="shell-header"]')).not.toHaveClass(/shell-overflow-open/);
  await expect(more).toBeFocused();
});

test("360px mini People sheet contains its header, list, and participant cards", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openPhaseOneViewer(page, { participants: 4, cameras: 1, screenShares: 0 });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "mini");
  await expect(page.locator("#screen-grid")).toHaveAttribute("data-visible-tiles", "0");

  const geometry = await page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top, width: box.width };
    };
    const sheet = document.getElementById("room-sidebar");
    const header = sheet.querySelector(".sidebar-header");
    const list = document.getElementById("user-list");
    const cards = Array.from(list.querySelectorAll(".user-card"));
    return {
      utility: rect(document.getElementById("utility-host")),
      workspace: rect(document.querySelector('.room-layout[data-ui-region="workspace"]')),
      sheet: rect(sheet),
      header: rect(header),
      list: rect(list),
      cards: cards.map(rect),
      sheetClientWidth: sheet.clientWidth,
      sheetScrollWidth: sheet.scrollWidth,
      listClientWidth: list.clientWidth,
      listScrollWidth: list.scrollWidth,
    };
  });

  expect(geometry.sheetScrollWidth).toBeLessThanOrEqual(geometry.sheetClientWidth + 1);
  expect(geometry.listScrollWidth).toBeLessThanOrEqual(geometry.listClientWidth + 1);
  for (const region of [geometry.utility, geometry.sheet]) {
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(Math.abs(region[edge] - geometry.workspace[edge])).toBeLessThanOrEqual(1);
    }
  }
  for (const region of [geometry.header, geometry.list, ...geometry.cards]) {
    expect(region.width).toBeGreaterThan(0);
    expect(region.left).toBeGreaterThanOrEqual(geometry.sheet.left - 1);
    expect(region.right).toBeLessThanOrEqual(geometry.sheet.right + 1);
  }
  await expectNoDocumentOverflow(page);
});

for (const viewport of [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
]) {
  test(`${viewport.width}x${viewport.height} mini default People sheet exposes a dismissible live Stage`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, {
      participants: 2,
      cameras: 0,
      screenShares: 1,
      shareAspects: [16 / 9],
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "mini");

    const layout = page.locator('.room-layout[data-ui-region="workspace"]');
    const stage = page.locator('.room-main[data-ui-region="primary-stage"]');
    const utility = page.locator('.utility-host[data-ui-region="utility-host"]');
    const grid = page.locator("#screen-grid");
    const tile = grid.locator(":scope > .tile");
    const video = tile.locator("video.screen-video-surface");
    const fullscreen = tile.locator(".tile-fullscreen-btn");

    await expect(layout).not.toHaveClass(/utility-collapsed/);
    await expect(utility).toHaveAttribute("data-active-tool", "people");
    await expect(grid).toHaveAttribute("data-visible-tiles", "1");
    await expect(tile).toHaveAttribute("data-grid-visible", "");
    await expect(video).toHaveCount(1);
    await expect(fullscreen).toBeVisible();
    await expect.poll(() => stage.evaluate((element) => element.inert)).toBe(true);
    await expect.poll(() => video.evaluate((element) => ({
      hasCurrentData: element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
      sourceTrackState: element.srcObject?.getVideoTracks()[0]?.readyState || null,
    }))).toEqual({ hasCurrentData: true, sourceTrackState: "live" });

    const geometry = await page.evaluate(() => {
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

      const workspace = document.querySelector('.room-layout[data-ui-region="workspace"]');
      const primaryStage = document.querySelector('.room-main[data-ui-region="primary-stage"]');
      const utilityHost = document.querySelector('.utility-host[data-ui-region="utility-host"]');
      const scrim = document.getElementById("utility-scrim");
      const screenTile = document.querySelector("#screen-grid > .tile[data-grid-visible]");
      const screenVideo = screenTile.querySelector("video.screen-video-surface");
      const fullscreenButton = screenTile.querySelector(".tile-fullscreen-btn");
      const sourceTrack = screenVideo.srcObject.getVideoTracks()[0];
      const workspaceRect = rect(workspace);
      const stageRect = rect(primaryStage);
      const utilityRect = rect(utilityHost);
      const tileRect = rect(screenTile);
      const videoRect = rect(screenVideo);
      const exposedTop = Math.max(0, workspaceRect.top, stageRect.top, tileRect.top);
      const exposedBottom = Math.min(innerHeight, workspaceRect.bottom, utilityRect.top, tileRect.bottom);
      const exposedLeft = Math.max(0, workspaceRect.left, stageRect.left, tileRect.left);
      const exposedRight = Math.min(innerWidth, workspaceRect.right, stageRect.right, tileRect.right);
      const exposedTile = {
        height: Math.max(0, exposedBottom - exposedTop),
        width: Math.max(0, exposedRight - exposedLeft),
      };
      const hitPoint = {
        x: exposedLeft + exposedTile.width / 2,
        y: exposedTop + exposedTile.height / 2,
      };
      const hitTarget = document.elementFromPoint(hitPoint.x, hitPoint.y);

      window.__miniStageUtilityNodes = { fullscreenButton, screenTile, screenVideo, sourceTrack };
      return {
        exposedTile,
        hitPoint,
        hitTargetIsScrim: hitTarget === scrim || scrim.contains(hitTarget),
        tile: tileRect,
        utilityHeightRatio: utilityRect.height / workspaceRect.height,
        video: videoRect,
        videoHeight: screenVideo.videoHeight,
        videoWidth: screenVideo.videoWidth,
      };
    });

    expect(geometry.utilityHeightRatio).toBeLessThanOrEqual(0.63);
    expect(geometry.exposedTile.width).toBeGreaterThanOrEqual(44);
    expect(geometry.exposedTile.height).toBeGreaterThanOrEqual(100);
    expect(geometry.tile.width).toBeGreaterThan(1);
    expect(geometry.tile.height).toBeGreaterThan(1);
    expect(geometry.video.width).toBeGreaterThan(1);
    expect(geometry.video.height).toBeGreaterThan(1);
    expect(geometry.videoWidth).toBeGreaterThan(0);
    expect(geometry.videoHeight).toBeGreaterThan(0);
    expect(geometry.hitTargetIsScrim).toBe(true);

    await page.mouse.click(geometry.hitPoint.x, geometry.hitPoint.y);
    await expect(layout).toHaveClass(/utility-collapsed/);
    await expect.poll(() => stage.evaluate((element) => element.inert)).toBe(false);
    await expect.poll(() => utility.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");

    const restored = await page.evaluate(() => {
      const saved = window.__miniStageUtilityNodes;
      const tileBounds = saved.screenTile.getBoundingClientRect();
      const videoBounds = saved.screenVideo.getBoundingClientRect();
      const fullscreenBounds = saved.fullscreenButton.getBoundingClientRect();
      const tileHitTarget = document.elementFromPoint(
        tileBounds.left + tileBounds.width / 2,
        tileBounds.top + tileBounds.height / 2,
      );
      const fullscreenHitTarget = document.elementFromPoint(
        fullscreenBounds.left + fullscreenBounds.width / 2,
        fullscreenBounds.top + fullscreenBounds.height / 2,
      );
      return {
        fullscreenHit: fullscreenHitTarget === saved.fullscreenButton
          || saved.fullscreenButton.contains(fullscreenHitTarget),
        hasCurrentData: saved.screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
        sourceHeight: saved.screenVideo.videoHeight,
        sourceTrack: saved.sourceTrack === saved.screenVideo.srcObject.getVideoTracks()[0],
        sourceTrackState: saved.sourceTrack.readyState,
        sourceWidth: saved.screenVideo.videoWidth,
        stableFullscreen: saved.fullscreenButton === document.querySelector("#screen-grid > .tile .tile-fullscreen-btn"),
        stableTile: saved.screenTile === document.querySelector("#screen-grid > .tile"),
        stableVideo: saved.screenVideo === document.querySelector("#screen-grid > .tile video.screen-video-surface"),
        tileHeight: tileBounds.height,
        tileHit: saved.screenTile.contains(tileHitTarget),
        tileWidth: tileBounds.width,
        videoHeight: videoBounds.height,
        videoWidth: videoBounds.width,
      };
    });
    expect(restored.stableFullscreen).toBe(true);
    expect(restored.stableTile).toBe(true);
    expect(restored.stableVideo).toBe(true);
    expect(restored.sourceTrack).toBe(true);
    expect(restored.sourceTrackState).toBe("live");
    expect(restored.hasCurrentData).toBe(true);
    expect(restored.tileHit).toBe(true);
    expect(restored.fullscreenHit).toBe(true);
    expect(restored.tileWidth).toBeGreaterThanOrEqual(44);
    expect(restored.tileHeight).toBeGreaterThanOrEqual(44);
    expect(restored.videoWidth).toBeGreaterThan(1);
    expect(restored.videoHeight).toBeGreaterThan(1);
    expect(restored.sourceWidth).toBeGreaterThan(0);
    expect(restored.sourceHeight).toBeGreaterThan(0);
    await expectNoDocumentOverflow(page);
  });
}

test("theater Chat retains the primary stage height", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, {
    participants: 4,
    cameras: 2,
    screenShares: 1,
    chatOpen: false,
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "theater");

  const stage = page.locator('.room-main[data-ui-region="primary-stage"]');
  const heightBefore = (await stage.boundingBox()).height;
  await page.evaluate(() => {
    document.querySelector(".room-layout").classList.add("chat-open");
    document.getElementById("chat-panel").classList.remove("hidden");
  });
  await expect(page.locator("#chat-panel")).toBeVisible();
  const heightAfter = (await stage.boundingBox()).height;
  expect(Math.abs(heightAfter - heightBefore)).toBeLessThanOrEqual(1);
});

test("utility collapse reclaims theater stage width", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseOneViewer(page, { participants: 4, cameras: 1, screenShares: 1 });
  const stage = page.locator('.room-main[data-ui-region="primary-stage"]');
  const layout = page.locator('.room-layout[data-ui-region="workspace"]');
  const toggle = page.locator("#shell-toggle-utility");
  const widthBefore = (await stage.boundingBox()).width;

  await toggle.click();
  await expect(layout).toHaveClass(/utility-collapsed/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const widthAfter = (await stage.boundingBox()).width;
  const layoutWidth = (await layout.boundingBox()).width;
  expect(widthAfter).toBeGreaterThan(widthBefore + 200);
  expect(widthAfter).toBeGreaterThanOrEqual(layoutWidth - 2);
});

for (const viewport of [
  { width: 1024, height: 768, mode: "lounge" },
  { width: 800, height: 600, mode: "compact" },
]) {
  test(`${viewport.mode} utility expansion gates the stage and collapse restores it`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, { participants: 4, cameras: 1, screenShares: 1 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const stage = page.locator('.room-main[data-ui-region="primary-stage"]');
    const layout = page.locator('.room-layout[data-ui-region="workspace"]');
    const utility = page.locator('.utility-host[data-ui-region="utility-host"]');
    const toggle = page.locator("#shell-toggle-utility");
    await expect.poll(() => stage.evaluate((element) => element.inert)).toBe(true);

    await toggle.click();
    await expect(layout).toHaveClass(/utility-collapsed/);
    await expect.poll(() => stage.evaluate((element) => element.inert)).toBe(false);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => utility.evaluate((element) => getComputedStyle(element).visibility)).toBe("hidden");

    const sizes = await page.evaluate(() => {
      const workspace = document.querySelector('.room-layout[data-ui-region="workspace"]').getBoundingClientRect();
      const primary = document.querySelector('.room-main[data-ui-region="primary-stage"]').getBoundingClientRect();
      return { stageHeight: primary.height, stageWidth: primary.width, workspaceHeight: workspace.height, workspaceWidth: workspace.width };
    });
    expect(sizes.stageWidth).toBeGreaterThanOrEqual(sizes.workspaceWidth - 2);
    expect(sizes.stageHeight).toBeGreaterThanOrEqual(sizes.workspaceHeight - 2);
  });
}

for (const viewport of [
  { width: 800, height: 600, mode: "compact" },
  { width: 600, height: 900, mode: "mini" },
]) {
  test(`${viewport.mode} Chat uses essentially the full workspace`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, {
      participants: 4,
      cameras: 1,
      screenShares: 1,
      chatOpen: true,
    });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);
    const geometry = await page.evaluate(() => {
      const workspace = document.querySelector('.room-layout[data-ui-region="workspace"]').getBoundingClientRect();
      const chat = document.getElementById("chat-panel").getBoundingClientRect();
      return {
        heightRatio: chat.height / workspace.height,
        widthRatio: chat.width / workspace.width,
        chat: { bottom: chat.bottom, left: chat.left, right: chat.right, top: chat.top },
        workspace: { bottom: workspace.bottom, left: workspace.left, right: workspace.right, top: workspace.top },
      };
    });
    expect(geometry.widthRatio).toBeGreaterThanOrEqual(0.95);
    expect(geometry.heightRatio).toBeGreaterThanOrEqual(0.95);
    expect(geometry.chat.left).toBeGreaterThanOrEqual(geometry.workspace.left - 1);
    expect(geometry.chat.right).toBeLessThanOrEqual(geometry.workspace.right + 1);
    expect(geometry.chat.top).toBeGreaterThanOrEqual(geometry.workspace.top - 1);
    expect(geometry.chat.bottom).toBeLessThanOrEqual(geometry.workspace.bottom + 1);
  });
}

test("Output opens Settings with focus inside and Escape restores the dock opener", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });
  const output = page.locator("#dock-output");
  const settings = page.locator("#settings-panel");
  await output.evaluate((button) => { button.disabled = false; });

  await output.click();
  await expect(settings).toBeVisible();
  await expect(output).toHaveAttribute("aria-expanded", "true");
  await expect.poll(() => settings.evaluate((panel) => panel.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(output).toHaveAttribute("aria-expanded", "false");
  await expect(output).toBeFocused();
});

test("Settings falls back to visible More when its dock opener disappears in mini", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });
  const output = page.locator("#dock-output");
  await output.evaluate((button) => { button.disabled = false; });
  await output.click();
  await expect(page.locator("#settings-panel")).toBeVisible();

  await settleResize(page, { width: 591, height: 900 }, "mini");
  await expect(output).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(page.locator("#shell-more-actions")).toBeFocused();
});

test("legacy rollback keeps Settings nonmodal and restores a visible legacy control", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 0 });
  const output = page.locator("#dock-output");
  const legacySettings = page.locator("#open-settings");
  await output.evaluate((button) => { button.disabled = false; });
  await legacySettings.evaluate((button) => { button.disabled = false; });
  await output.click();
  await expect(page.locator("#settings-panel")).toHaveAttribute("aria-modal", "");

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#settings-panel")).not.toHaveAttribute("aria-modal", "");
  await expect(page.locator("#settings-scrim")).toBeHidden();
  await expect.poll(() => page.locator("#clubhouse-shell").evaluate((element) => element.inert)).toBe(false);

  await page.locator("#close-settings").click();
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(legacySettings).toBeFocused();
});

test("screen volume becomes visible and interactive on keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, { participants: 2, cameras: 0, screenShares: 1 });
  await page.locator("#shell-toggle-utility").click();
  await expect.poll(() => page.locator('.room-main[data-ui-region="primary-stage"]').evaluate((element) => element.inert)).toBe(false);
  const tile = page.locator("#screen-grid > .tile").first();
  const wrap = tile.locator(".tile-volume-wrap");
  const slider = wrap.locator("input[type=range]");
  await wrap.evaluate((element) => element.classList.remove("hidden"));
  await slider.focus();
  await expect(slider).toBeFocused();
  await expect.poll(() => wrap.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThanOrEqual(0.99);
  await expect.poll(() => wrap.evaluate((element) => getComputedStyle(element).pointerEvents)).not.toBe("none");
  expect(await tile.evaluate((element) => element.matches(":focus-within"))).toBe(true);
});

test("one participant audio menu owns voice, shared-audio, and chime controls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, { participants: 3, cameras: 1, screenShares: 0 });

  const remoteCards = page.locator(".user-card.is-remote");
  await expect(remoteCards).toHaveCount(2);
  for (let index = 0; index < await remoteCards.count(); index += 1) {
    const card = remoteCards.nth(index);
    const participantName = (await card.locator(".user-name").textContent()).trim();
    const escapedName = participantName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namedForParticipant = new RegExp(escapedName, "i");
    const settingsToggle = card.locator(".participant-settings-toggle");
    await expect(settingsToggle).toHaveCount(1);
    await expect(settingsToggle).toBeVisible();
    await expect(settingsToggle).toHaveAccessibleName(namedForParticipant);

    await settingsToggle.click();
    const popup = card.locator(".participant-settings-popover");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("role", "dialog");
    await expect(popup).toHaveAccessibleName(namedForParticipant);
    await expect(popup.locator('input[type="range"]')).toHaveCount(3);
    await expect(popup.getByLabel(new RegExp(`Microphone volume.*${escapedName}`, "i"))).toBeVisible();
    await expect(popup.getByLabel(new RegExp(`Screen volume.*${escapedName}`, "i"))).toBeVisible();
    await expect(popup.getByLabel(new RegExp(`Chime volume.*${escapedName}`, "i"))).toBeVisible();
    await expect(popup.getByRole("button", { name: new RegExp(`Mute microphone audio.*${escapedName}`, "i") })).toBeVisible();
    await expect(popup.getByRole("button", { name: new RegExp(`Mute screen audio.*${escapedName}`, "i") })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(settingsToggle).toBeFocused();

    const baseMuteButtons = card.locator(".user-indicators .mute-button");
    await expect(baseMuteButtons).toHaveCount(2);
    for (let muteIndex = 0; muteIndex < 2; muteIndex += 1) {
      await expect(baseMuteButtons.nth(muteIndex)).toHaveAttribute("aria-label", namedForParticipant);
      await expect(baseMuteButtons.nth(muteIndex)).toBeHidden();
    }
  }

  const firstCard = remoteCards.nth(0);
  const secondCard = remoteCards.nth(1);
  const firstToggle = firstCard.locator(".participant-settings-toggle");
  const secondToggle = secondCard.locator(".participant-settings-toggle");
  await firstToggle.click();
  await secondToggle.click();
  await expect(firstCard.locator(".participant-settings-popover")).toBeHidden();
  await expect(firstToggle).toHaveAttribute("aria-expanded", "false");
  await expect(secondCard.locator(".participant-settings-popover")).toBeVisible();

  const secondPopup = secondCard.locator(".participant-settings-popover");
  const voiceMute = secondPopup.locator(".participant-settings-mute").nth(0);
  const screenMute = secondPopup.locator(".participant-settings-mute").nth(1);
  await secondCard.evaluate((card) => {
    participantCards.get(card.dataset.identity).setParticipantDisplayName("Renamed member");
  });
  await expect(secondToggle).toHaveAccessibleName(/Renamed member/i);
  await expect(secondPopup).toHaveAccessibleName(/Renamed member/i);
  await expect(secondPopup.getByLabel(/Microphone volume.*Renamed member/i)).toBeVisible();
  await voiceMute.click();
  await expect(voiceMute).toHaveAccessibleName(/Unmute microphone audio.*Renamed member/i);
  await expect(screenMute).toHaveAccessibleName(/Mute screen audio/i);

  const settingsChime = secondPopup.getByLabel(/Chime volume/i);
  await settingsChime.evaluate((slider) => {
    slider.value = "0.72";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(secondCard.locator(".chime-volume-row input[type=range]")).toHaveValue("0.72");

  await page.locator("#room-sidebar .sidebar-title-row h2").click();
  await expect(secondPopup).toBeHidden();

  const nonCameraCard = page.locator(".user-card.is-remote:not(.has-camera)").first();
  const nonCameraGeometry = await nonCameraCard.evaluate((element) => {
    const avatar = element.querySelector(".user-avatar").getBoundingClientRect();
    const toggle = element.querySelector(".participant-settings-toggle").getBoundingClientRect();
    const card = element.getBoundingClientRect();
    return { avatarWidth: avatar.width, cardRight: card.right, toggleRight: toggle.right };
  });
  expect(nonCameraGeometry.avatarWidth).toBeGreaterThanOrEqual(53.5);
  expect(nonCameraGeometry.toggleRight).toBeLessThanOrEqual(nonCameraGeometry.cardRight + 1);

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(nonCameraCard.locator(".participant-settings-toggle")).toBeHidden();
  for (let muteIndex = 0; muteIndex < 2; muteIndex += 1) {
    await expect(nonCameraCard.locator(".user-indicators .mute-button").nth(muteIndex)).toBeVisible();
  }
});

test("every member can hide and restore any shared screen on their own Stage", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, {
    participants: 3,
    cameras: 1,
    screenShares: 2,
    screenOwners: [1, 2],
  });

  const localIdentity = "layout-fixture-1";
  const remoteIdentity = "layout-fixture-2";
  const localCard = page.locator(`.user-card[data-identity="${localIdentity}"]`);
  const remoteCard = page.locator(`.user-card[data-identity="${remoteIdentity}"]`);
  const nonSharingCard = page.locator('.user-card[data-identity="layout-fixture-3"]');
  const localTile = page.locator(`#screen-grid > .tile[data-identity="${localIdentity}"]`);
  const remoteTile = page.locator(`#screen-grid > .tile[data-identity="${remoteIdentity}"]`);
  const localSharingBadge = localCard.locator(".participant-screen-state");
  const remoteSharingBadge = remoteCard.locator(".participant-screen-state");

  await page.evaluate(() => updateActiveSpeakerUi());

  await expect(localTile).toBeVisible();
  await expect(remoteTile).toBeVisible();
  await expect(localCard.locator(".participant-settings-toggle")).toBeVisible();
  await expect(remoteCard.locator(".participant-settings-toggle")).toBeVisible();
  await expect(localCard).toHaveClass(/is-screen-sharing/);
  await expect(remoteCard).toHaveClass(/is-screen-sharing/);
  await expect(nonSharingCard).not.toHaveClass(/is-screen-sharing/);
  await expect(localSharingBadge).toBeVisible();
  await expect(localSharingBadge).toHaveText("Sharing");
  await expect(localSharingBadge).toHaveAccessibleName(/Sharing screen from Friend 1/i);
  await expect(remoteSharingBadge).toBeVisible();
  await expect(remoteSharingBadge).toHaveText("Sharing");
  await expect(remoteSharingBadge).toHaveAccessibleName(/Sharing screen from Friend 2/i);
  await expect(nonSharingCard.locator(".participant-screen-state")).toBeHidden();
  await expectContained(localSharingBadge, localCard);
  await expectContained(remoteSharingBadge, remoteCard);
  await expectNoOverlap(localSharingBadge, localCard.locator(".participant-mic-state"));
  await expectNoOverlap(localSharingBadge, localCard.locator(".participant-settings-toggle"));
  await expectNoOverlap(remoteSharingBadge, remoteCard.locator(".participant-mic-state"));
  await expectNoOverlap(remoteSharingBadge, remoteCard.locator(".participant-settings-toggle"));

  const sharingBorderColor = await resolveThemeColor(
    page,
    "color-mix(in srgb, var(--ec-accent) 70%, transparent)",
  );
  const speakingBorderColor = await resolveThemeColor(
    page,
    "color-mix(in srgb, var(--ec-live) 72%, transparent)",
  );
  const mutedBorderColor = await resolveThemeColor(
    page,
    "color-mix(in srgb, var(--ec-danger) 58%, transparent)",
  );

  await page.evaluate((identity) => {
    window.EchoLayoutTestScenario.setParticipantMicrophoneState(identity, {
      published: true,
      muted: false,
    });
  }, remoteIdentity);
  await expect(remoteCard).toHaveCSS("border-color", sharingBorderColor);

  await page.evaluate((identity) => {
    const state = participantState.get(identity);
    state.micActive = true;
    lastActiveSpeakerEvent = Number.NEGATIVE_INFINITY;
    updateActiveSpeakerUi();
  }, remoteIdentity);
  await expect(remoteCard).toHaveCSS("border-color", speakingBorderColor);

  await page.evaluate((identity) => {
    window.EchoLayoutTestScenario.setParticipantMicrophoneState(identity, {
      published: true,
      muted: true,
    });
  }, remoteIdentity);
  await expect(remoteCard).toHaveClass(/is-publisher-mic-off/);
  await expect(remoteCard).toHaveClass(/is-screen-sharing/);
  await expect(remoteCard).toHaveCSS("border-color", mutedBorderColor);
  await expect(remoteSharingBadge).toBeVisible();
  await expectNoOverlap(remoteSharingBadge, remoteCard.locator(".participant-mic-state"));

  async function openScreenAction(card, participantName, action) {
    const toggle = card.locator(".participant-settings-toggle");
    const popup = card.locator(".participant-settings-popover");
    if (!(await popup.isVisible())) await toggle.click();
    await expect(popup).toBeVisible();
    return popup.getByRole("button", {
      name: new RegExp(`${action} the shared screen from ${participantName} on my Stage`, "i"),
    });
  }

  const hideLocal = await openScreenAction(localCard, "Friend 1", "Hide");
  await expect(hideLocal).toHaveText("Hide from my Stage");
  await hideLocal.click();
  await expect(localTile).toBeHidden();
  await expect(remoteTile).toBeVisible();
  await expect(localCard.locator(".participant-settings-toggle")).toBeVisible();
  await expect(localCard).toHaveClass(/is-screen-sharing/);
  await expect(localSharingBadge).toBeVisible();
  await expectContained(localSharingBadge, localCard);
  await expectNoOverlap(localSharingBadge, localCard.locator(".participant-settings-toggle"));

  const localHiddenState = await page.evaluate((identity) => {
    const state = participantState.get(identity);
    const audio = Array.from(state.screenAudioEls)[0];
    const gainNode = state.screenGainNodes.get(audio);
    return {
      gain: gainNode.gain.gain.value,
      hidden: hiddenScreens.has(identity),
      muted: audio.muted,
      subscriptions: window.__echoLayoutFixtureSubscriptions.filter((entry) => entry.identity === identity),
    };
  }, localIdentity);
  expect(localHiddenState).toEqual({ gain: 0, hidden: true, muted: true, subscriptions: [] });

  await page.setViewportSize({ width: 560, height: 640 });
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "mini");
  const showLocal = await openScreenAction(localCard, "Friend 1", "Show");
  await expect(showLocal).toHaveText("Show on my Stage");
  const restoreGeometry = await showLocal.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(restoreGeometry.left).toBeGreaterThanOrEqual(0);
  expect(restoreGeometry.top).toBeGreaterThanOrEqual(0);
  expect(restoreGeometry.right).toBeLessThanOrEqual(restoreGeometry.viewportWidth);
  expect(restoreGeometry.bottom).toBeLessThanOrEqual(restoreGeometry.viewportHeight);
  await showLocal.click();
  await expect(localTile).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 768 });
  const hideRemote = await openScreenAction(remoteCard, "Friend 2", "Hide");
  await hideRemote.click();
  await expect(remoteTile).toBeHidden();
  await expect(localTile).toBeVisible();
  await expect(remoteCard).toHaveClass(/is-screen-sharing/);
  await expect(remoteSharingBadge).toBeVisible();

  const remoteHiddenState = await page.evaluate((identity) => {
    const state = participantState.get(identity);
    const audio = Array.from(state.screenAudioEls)[0];
    const gainNode = state.screenGainNodes.get(audio);
    return {
      gain: gainNode.gain.gain.value,
      hidden: hiddenScreens.has(identity),
      muted: audio.muted,
      unsubscribedSources: window.__echoLayoutFixtureSubscriptions
        .filter((entry) => entry.identity === identity && !entry.subscribed)
        .map((entry) => entry.source)
        .sort(),
    };
  }, remoteIdentity);
  expect(remoteHiddenState.hidden).toBe(true);
  expect(remoteHiddenState.muted).toBe(true);
  expect(remoteHiddenState.gain).toBe(0);
  expect(remoteHiddenState.unsubscribedSources).toEqual(["screen_share", "screen_share_audio"]);

  const showRemote = await openScreenAction(remoteCard, "Friend 2", "Show");
  await showRemote.click();
  await expect(remoteTile).toBeVisible();
  await expect.poll(() => page.evaluate((identity) => ({
    hidden: hiddenScreens.has(identity),
    resubscribed: window.__echoLayoutFixtureSubscriptions.some((entry) =>
      entry.identity === identity && entry.subscribed
    ),
  }), remoteIdentity)).toEqual({ hidden: false, resubscribed: true });

  await (await openScreenAction(localCard, "Friend 1", "Hide")).click();
  await (await openScreenAction(remoteCard, "Friend 2", "Hide")).click();
  await expect(page.locator("#screen-grid")).toHaveAttribute("data-visible-tiles", "0");
  await expect.poll(() => page.locator("#screen-grid").evaluate((grid) =>
    getComputedStyle(grid, "::before").content
  )).toContain("All shared screens are hidden");
  await expect(localCard.locator(".participant-settings-toggle")).toBeVisible();
  await expect(localSharingBadge).toBeVisible();
  await expect(remoteSharingBadge).toBeVisible();
  await expect(remoteCard.locator(".participant-settings-popover").getByRole("button", {
    name: /Show the shared screen from Friend 2 on my Stage/i,
  })).toBeVisible();

  await page.evaluate(({ localIdentity, remoteIdentity }) => {
    window.EchoLayoutTestScenario.setParticipantScreenShareAvailable(localIdentity, false);
    window.EchoLayoutTestScenario.setParticipantScreenShareAvailable(remoteIdentity, false);
  }, { localIdentity, remoteIdentity });
  await expect(localCard).not.toHaveClass(/is-screen-sharing/);
  await expect(remoteCard).not.toHaveClass(/is-screen-sharing/);
  await expect(localSharingBadge).toBeHidden();
  await expect(remoteSharingBadge).toBeHidden();
  await expect(localCard.locator(".participant-settings-toggle")).toBeHidden();
});
