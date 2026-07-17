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
  '.room-sidebar[data-ui-region="utility-host"]',
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

async function expectCanonicalStructure(page) {
  for (const selector of shellSelectors) {
    await expect(page.locator(selector), `${selector} must be unique`).toHaveCount(1);
  }

  const structure = await page.evaluate((selectors) => {
    const shell = document.getElementById("clubhouse-shell");
    const header = document.querySelector('.room-top[data-ui-region="shell-header"]');
    const workspace = document.querySelector('.room-layout[data-ui-region="workspace"]');
    const stage = document.querySelector('.room-main[data-ui-region="primary-stage"]');
    const utility = document.querySelector('.room-sidebar[data-ui-region="utility-host"]');
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
    title: "defaults to legacy when neither storage nor query overrides the shell",
    persisted: null,
    query: "",
    expected: "legacy",
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

test("V2 ellipsizes a 60-character unbroken name without overlapping camera controls", async ({ page }) => {
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
  const overlayControls = overlay.locator(".cam-overlay-controls");
  const focusTarget = overlayControls.locator("button:visible").first();
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
  await expectContained(overlayControls, overlay);
  await expectNoOverlap(overlayName, overlayControls);

  const controlRects = await overlayControls.locator(":scope > button:visible").evaluateAll((buttons) => (
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
      };
    })
  ));
  expect(controlRects.length).toBeGreaterThan(0);
  for (let first = 0; first < controlRects.length; first += 1) {
    for (let second = first + 1; second < controlRects.length; second += 1) {
      expect(intersectionArea(controlRects[first], controlRects[second])).toBeLessThanOrEqual(1);
    }
  }
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
  test(`${viewport.mode} camera volume popup stays contained and all sliders are hittable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openPhaseOneViewer(page, { participants: 3, cameras: 1, screenShares: 0 });
    await expect(page.locator("html")).toHaveAttribute("data-ui-mode", viewport.mode);

    const card = page.locator(".user-card.is-remote.has-camera").first();
    await card.evaluate((element) => element.scrollIntoView({ block: "nearest" }));
    await card.locator(".cam-overlay-controls .icon-button").first().click();
    const popup = card.locator(".vol-popup");
    await expect(popup).toHaveClass(/is-open/);
    await expect(popup).toBeVisible();

    const geometry = await card.evaluate((element) => {
      const toRect = (node) => {
        const rect = node.getBoundingClientRect();
        return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
      };
      const popupElement = element.querySelector(".vol-popup");
      const sliders = Array.from(popupElement.querySelectorAll('input[type="range"]'));
      return {
        card: toRect(element),
        popup: toRect(popupElement),
        sliders: sliders.map((slider) => {
          const rect = slider.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + (rect.width / 2), rect.top + (rect.height / 2));
          return { rect: toRect(slider), hittable: hit === slider || slider.contains(hit) };
        }),
      };
    });
    expect(geometry.sliders).toHaveLength(3);
    expect(geometry.popup.left).toBeGreaterThanOrEqual(geometry.card.left - 1);
    expect(geometry.popup.right).toBeLessThanOrEqual(geometry.card.right + 1);
    expect(geometry.popup.top).toBeGreaterThanOrEqual(geometry.card.top - 1);
    expect(geometry.popup.bottom).toBeLessThanOrEqual(geometry.card.bottom + 1);
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
  for (const region of [geometry.header, geometry.list, ...geometry.cards]) {
    expect(region.width).toBeGreaterThan(0);
    expect(region.left).toBeGreaterThanOrEqual(geometry.sheet.left - 1);
    expect(region.right).toBeLessThanOrEqual(geometry.sheet.right + 1);
  }
  await expectNoDocumentOverflow(page);
});

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
  expect(widthAfter).toBeGreaterThan(widthBefore + 200);
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
    const utility = page.locator('.room-sidebar[data-ui-region="utility-host"]');
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

test("participant chime and mute controls expose participant-specific accessible names", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseOneViewer(page, { participants: 3, cameras: 1, screenShares: 0 });

  const remoteCards = page.locator(".user-card.is-remote");
  await expect(remoteCards).toHaveCount(2);
  for (let index = 0; index < await remoteCards.count(); index += 1) {
    const card = remoteCards.nth(index);
    const participantName = (await card.locator(".user-name").textContent()).trim();
    const escapedName = participantName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namedForParticipant = new RegExp(escapedName, "i");
    const chimeToggle = card.locator(".participant-chime-toggle");
    const chimeSlider = card.locator(".chime-volume-row input[type=range]");
    await expect(chimeToggle).toHaveAttribute("aria-label", namedForParticipant);
    await expect(chimeSlider).toHaveAttribute("aria-label", namedForParticipant);
    const baseMuteButtons = card.locator(".user-indicators .mute-button");
    await expect(baseMuteButtons).toHaveCount(2);
    for (let muteIndex = 0; muteIndex < 2; muteIndex += 1) {
      await expect(baseMuteButtons.nth(muteIndex)).toHaveAttribute("aria-label", namedForParticipant);
    }
    if (await card.evaluate((element) => !element.classList.contains("has-camera"))) {
      await expect(chimeToggle).toHaveAccessibleName(namedForParticipant);
      for (let muteIndex = 0; muteIndex < 2; muteIndex += 1) {
        await expect(baseMuteButtons.nth(muteIndex)).toHaveAccessibleName(namedForParticipant);
      }
    }
  }

  const cameraCard = page.locator(".user-card.is-remote.has-camera").first();
  const cameraName = (await cameraCard.locator(".user-name").textContent()).trim();
  const cameraNamePattern = new RegExp(cameraName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const overlayMutes = cameraCard.locator(".cam-overlay .mute-button");
  await expect(overlayMutes).toHaveCount(2);
  await expect(overlayMutes.nth(0)).toHaveAccessibleName(cameraNamePattern);
  await expect(overlayMutes.nth(1)).toHaveAccessibleName(cameraNamePattern);
});
