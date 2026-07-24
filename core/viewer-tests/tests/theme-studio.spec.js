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

const moduleRoots = Object.freeze([
  { module: "stage", selector: ".room-main" },
  { module: "people", selector: "#room-sidebar" },
  { module: "chat", selector: "#chat-panel" },
  { module: "jam", selector: "#jam-panel" },
  { module: "jam", selector: "#jam-banner" },
  { module: "camera", selector: "#camera-lobby" },
  { module: "soundboard", selector: "#soundboard-compact" },
  { module: "soundboard", selector: "#soundboard" },
  { module: "settings", selector: "#settings-panel" },
]);

const themeAccents = Object.freeze({
  frost: "#36c5ff",
  cyberpunk: "#ff3cac",
  aurora: "#3ee6ad",
  ember: "#ff765f",
  matrix: "#27f46a",
  midnight: "#c8b9ff",
  "event-horizon": "#a67cff",
  tempest: "#66cfff",
  abyss: "#27dcc8",
  "neon-wilds": "#9bea61",
  "ultra-instinct": "#a9c8ff",
});

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.stack || error.message}`));
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
      body: JSON.stringify({ error: "unmodeled Theme Studio viewer-test endpoint" }),
    });
  });
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(25);
  expect(runtimeErrors.get(page) || [], "production page must run without runtime errors").toEqual([]);
});

async function nextPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
}

async function openViewer(page, options = {}) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await expect.poll(() => page.evaluate(() => Boolean(window.EchoTheme))).toBe(true);
  await page.evaluate(() => {
    if (typeof CHANGELOG_LATEST !== "undefined") {
      localStorage.setItem("echo-changelog-seen", CHANGELOG_LATEST);
    }
  });

  if (options.scenario) {
    await page.addScriptTag({ path: fixturePath });
    await page.evaluate(
      (scenario) => window.EchoLayoutTestScenario.install(scenario),
      options.scenario,
    );
    await nextPaint(page);
  }
}

async function openThemeStudio(page, opener = "#open-theme-portal") {
  if (await page.locator("#theme-panel").isHidden()) {
    await page.locator(opener).click();
  }
  await expect(page.locator("#theme-panel")).toBeVisible();
  await expect(page.locator("#theme-panel")).toHaveAttribute("aria-hidden", "false");
}

async function selectGlobalTheme(page, themeId) {
  const card = page.locator(`.theme-card[data-theme="${themeId}"]`);
  await card.click();
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("body")).toHaveAttribute("data-theme", themeId);
  await expect(page.locator("html")).toHaveAttribute("data-echo-theme", themeId);
}

async function openModuleCustomizer(page) {
  const customizer = page.locator("#theme-module-customizer");
  if ((await customizer.getAttribute("open")) === null) {
    await customizer.locator(":scope > summary").click();
  }
  await expect(customizer).toHaveAttribute("open", "");
}

async function setModuleTheme(page, moduleId, themeId) {
  const select = page.locator(`[data-theme-module-select="${moduleId}"]`);
  await select.selectOption(themeId);
  await expect(select).toHaveValue(themeId);
}

async function showCapturePicker(page) {
  await page.evaluate(() => {
    window.tauriInvoke = async function (command) {
      if (command === "list_screen_sources") return [];
      return null;
    };
    window.__themeCapturePickerPromise = showCapturePicker();
  });
  await expect(page.locator("#capture-picker-overlay")).toBeVisible();
}

async function closeCapturePicker(page) {
  const cancel = page.locator("#cp-cancel");
  if (await cancel.count()) {
    await cancel.click();
    await expect(page.locator("#capture-picker-overlay")).toHaveCount(0);
  }
}

test("Ultra Instinct uses the autonomous quote and animated GIF preview", async ({ page }) => {
  const gifRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/ultrainstinct.gif")) {
      gifRequests.push(request.url());
    }
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  expect(gifRequests, "the 2 MB preview must stay lazy until Theme Studio opens").toEqual([]);
  await openThemeStudio(page);
  await expect.poll(() => gifRequests.length).toBe(1);

  const card = page.locator('.theme-card[data-theme="ultra-instinct"]');
  const description = card.locator(".theme-vibe");
  const preview = card.locator(".theme-preview");
  await expect(card.locator(".theme-badge")).toHaveText("Autonomous");
  await expect(description).toHaveText(
    "It's astounding! This mortal really is something else...Look at that brilliant form...There can be no doubt! This is the true power, complete in all its majesty! This is... AUTONOMOUS ULTRA INSTINCT!!!!",
  );
  await expect(description).toHaveCSS("font-weight", "800");
  expect(await preview.evaluate((element) => getComputedStyle(element).backgroundImage))
    .toContain("ultrainstinct.gif");
});

test("Theme Studio separates Core Looks from lightweight Animated Worlds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  await openThemeStudio(page);

  const collections = await page.evaluate(() => (
    Array.from(document.querySelectorAll("[data-theme-collection]")).map((grid) => ({
      collection: grid.dataset.themeCollection,
      ids: Array.from(grid.querySelectorAll(".theme-card")).map((card) => card.dataset.theme),
      label: grid.closest(".theme-collection").querySelector("h5").textContent,
    }))
  ));
  expect(collections).toEqual([
    {
      collection: "core",
      ids: ["frost", "cyberpunk", "aurora", "ember", "midnight"],
      label: "Clean by design",
    },
    {
      collection: "animated",
      ids: ["matrix", "event-horizon", "tempest", "abyss", "neon-wilds", "ultra-instinct"],
      label: "Make Echo feel alive",
    },
  ]);
  await expect(page.locator('.theme-card[data-theme="matrix"] .theme-name')).toHaveText("Matrix");

  await openModuleCustomizer(page);
  const groups = await page.locator('[data-theme-module-select="stage"] optgroup').evaluateAll(
    (elements) => elements.map((group) => ({
      label: group.label,
      values: Array.from(group.querySelectorAll("option")).map((option) => option.value),
    })),
  );
  expect(groups).toEqual([
    {
      label: "Core Looks",
      values: ["frost", "cyberpunk", "aurora", "ember", "midnight"],
    },
    {
      label: "Animated Worlds",
      values: ["matrix", "event-horizon", "tempest", "abyss", "neon-wilds", "ultra-instinct"],
    },
  ]);
});

test("the global theme contract reaches every Echo module, including the dynamic Capture Picker", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page, {
    scenario: {
      participants: 4,
      cameras: 2,
      screenShares: 1,
    },
  });

  await openThemeStudio(page, "#open-theme");
  await selectGlobalTheme(page, "cyberpunk");

  const staticPresentation = await page.evaluate((roots) => {
    function tokens(element) {
      const style = getComputedStyle(element);
      return {
        accent: style.getPropertyValue("--ec-accent").trim(),
        surface: style.getPropertyValue("--ec-surface").trim(),
        text: style.getPropertyValue("--ec-text").trim(),
      };
    }
    const globalTokens = tokens(document.body);
    return {
      globalTokens,
      roots: roots.map(({ module, selector }) => {
        const element = document.querySelector(selector);
        return {
          module,
          moduleAttribute: element.dataset.echoModule,
          override: element.getAttribute("data-module-theme"),
          selector,
          tokens: tokens(element),
        };
      }),
    };
  }, moduleRoots);

  expect(staticPresentation.globalTokens.accent).toBe(themeAccents.cyberpunk);
  for (const root of staticPresentation.roots) {
    expect(root.moduleAttribute, `${root.selector} module binding`).toBe(root.module);
    expect(root.override, `${root.selector} should follow global`).toBeNull();
    expect(root.tokens, `${root.selector} semantic tokens`).toEqual(staticPresentation.globalTokens);
  }

  await page.locator("#close-theme").click();
  await showCapturePicker(page);
  const capturePresentation = await page.locator("#capture-picker-overlay").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      moduleAttribute: element.dataset.echoModule,
      override: element.getAttribute("data-module-theme"),
      tokens: {
        accent: style.getPropertyValue("--ec-accent").trim(),
        surface: style.getPropertyValue("--ec-surface").trim(),
        text: style.getPropertyValue("--ec-text").trim(),
      },
    };
  });
  expect(capturePresentation).toEqual({
    moduleAttribute: "capture",
    override: null,
    tokens: staticPresentation.globalTokens,
  });
  await closeCapturePicker(page);
});

test("module overrides stay isolated, persist across reload, and reset through Theme Studio", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  await openThemeStudio(page);
  await selectGlobalTheme(page, "cyberpunk");
  await openModuleCustomizer(page);
  await setModuleTheme(page, "people", "aurora");
  await setModuleTheme(page, "jam", "ember");
  await setModuleTheme(page, "capture", "event-horizon");

  const isolated = await page.evaluate(() => {
    function presentation(selector) {
      const element = document.querySelector(selector);
      return {
        accent: getComputedStyle(element).getPropertyValue("--ec-accent").trim(),
        override: element.getAttribute("data-module-theme"),
      };
    }
    return {
      body: presentation("body"),
      jam: presentation("#jam-panel"),
      people: presentation("#room-sidebar"),
      stage: presentation(".room-main"),
      storage: {
        global: localStorage.getItem("echo-core-theme"),
        overrides: JSON.parse(localStorage.getItem("echo-core-theme-overrides")),
      },
    };
  });
  expect(isolated).toEqual({
    body: { accent: themeAccents.cyberpunk, override: null },
    jam: { accent: themeAccents.ember, override: "ember" },
    people: { accent: themeAccents.aurora, override: "aurora" },
    stage: { accent: themeAccents.cyberpunk, override: null },
    storage: {
      global: "cyberpunk",
      overrides: { people: "aurora", jam: "ember", capture: "event-horizon" },
    },
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => page.evaluate(() => Boolean(window.EchoTheme))).toBe(true);
  await expect(page.locator("body")).toHaveAttribute("data-theme", "cyberpunk");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("data-module-theme", "aurora");
  await expect(page.locator("#jam-panel")).toHaveAttribute("data-module-theme", "ember");
  await expect(page.locator("#jam-banner")).toHaveAttribute("data-module-theme", "ember");
  await expect(page.locator(".room-main")).not.toHaveAttribute("data-module-theme", /.+/);

  await page.evaluate(() => showJamToast("Jam theme regression"));
  await expect(page.locator(".jam-toast")).toHaveAttribute("data-echo-module", "jam");
  await expect(page.locator(".jam-toast")).toHaveAttribute("data-module-theme", "ember");
  expect(
    await page.locator(".jam-toast").evaluate(
      (element) => getComputedStyle(element).getPropertyValue("--ec-accent").trim(),
    ),
  ).toBe(themeAccents.ember);
  await page.evaluate(() => {
    const toast = document.querySelector(".jam-toast");
    if (!toast) return;
    releaseJamToastTheme(toast);
    toast.remove();
  });

  await showCapturePicker(page);
  await expect(page.locator("#capture-picker-overlay")).toHaveAttribute("data-echo-module", "capture");
  await expect(page.locator("#capture-picker-overlay")).toHaveAttribute("data-module-theme", "event-horizon");
  expect(
    await page.locator("#capture-picker-overlay").evaluate(
      (element) => getComputedStyle(element).getPropertyValue("--ec-accent").trim(),
    ),
  ).toBe(themeAccents["event-horizon"]);
  await closeCapturePicker(page);

  await openThemeStudio(page);
  await openModuleCustomizer(page);
  await expect(page.locator('[data-theme-module-select="people"]')).toHaveValue("aurora");
  await expect(page.locator('[data-theme-module-select="jam"]')).toHaveValue("ember");
  await expect(page.locator('[data-theme-module-select="capture"]')).toHaveValue("event-horizon");
  await page.locator("#theme-reset-modules").click();

  for (const { selector } of moduleRoots) {
    await expect(page.locator(selector)).not.toHaveAttribute("data-module-theme", /.+/);
  }
  expect(await page.evaluate(() => localStorage.getItem("echo-core-theme-overrides"))).toBe("{}");
  await expect(page.locator('[data-theme-module-select="people"]')).toHaveValue("global");
  await expect(page.locator('[data-theme-module-select="jam"]')).toHaveValue("global");
  await expect(page.locator('[data-theme-module-select="capture"]')).toHaveValue("global");
  await expect(page.locator("#theme-reset-modules")).toBeDisabled();
});

test("global and per-module visual changes preserve canonical DOM, media tracks, state, and drafts", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  await openThemeStudio(page);
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate(() => window.EchoLayoutTestScenario.install({
    participants: 4,
    cameras: 2,
    screenShares: 1,
    chatOpen: true,
  }));

  const preservedDraft = "Theme changes must not rebuild my active Echo session";
  await page.evaluate(({ draft, roots }) => {
    const cameraCard = document.querySelector(".user-card.has-camera");
    participantState.get(cameraCard.dataset.identity).__themeFixtureMarker = "preserved";
    const input = document.getElementById("chat-input");
    input.value = draft;
    input.setSelectionRange(6, 20);
    window.__themeCanonicalRoots = roots.map(({ selector }) => document.querySelector(selector));
    window.EchoLayoutTestScenario.captureIdentitySnapshot();
  }, { draft: preservedDraft, roots: moduleRoots });

  await selectGlobalTheme(page, "midnight");
  await openModuleCustomizer(page);
  await setModuleTheme(page, "stage", "ember");
  await setModuleTheme(page, "chat", "aurora");

  const preserved = await page.evaluate((roots) => {
    const identity = window.EchoLayoutTestScenario.inspectIdentitySnapshot();
    const cameraCard = document.querySelector(".user-card.has-camera");
    return {
      canonicalRoots: roots.every(({ selector }, index) => (
        document.querySelectorAll(selector).length === 1 &&
        document.querySelector(selector) === window.__themeCanonicalRoots[index] &&
        window.__themeCanonicalRoots[index].isConnected
      )),
      draft: identity.draft,
      identity: {
        cameraSdkTrack: identity.cameraSdkTrack,
        cameraStream: identity.cameraStream,
        cameraTrack: identity.cameraTrack,
        cameraTrackState: identity.cameraTrackState,
        cameraVideo: identity.cameraVideo,
        chatInput: identity.chatInput,
        chatPanel: identity.chatPanel,
        participantCard: identity.participantCard,
        participantState: identity.participantState,
        screenSdkTrack: identity.screenSdkTrack,
        screenStream: identity.screenStream,
        screenTile: identity.screenTile,
        screenTrack: identity.screenTrack,
        screenTrackState: identity.screenTrackState,
        screenVideo: identity.screenVideo,
      },
      marker: participantState.get(cameraCard.dataset.identity).__themeFixtureMarker,
      selectionEnd: identity.selectionEnd,
      selectionStart: identity.selectionStart,
    };
  }, moduleRoots);

  expect(preserved).toEqual({
    canonicalRoots: true,
    draft: preservedDraft,
    identity: {
      cameraSdkTrack: true,
      cameraStream: true,
      cameraTrack: true,
      cameraTrackState: "live",
      cameraVideo: true,
      chatInput: true,
      chatPanel: true,
      participantCard: true,
      participantState: true,
      screenSdkTrack: true,
      screenStream: true,
      screenTile: true,
      screenTrack: true,
      screenTrackState: "live",
      screenVideo: true,
    },
    marker: "preserved",
    selectionEnd: 20,
    selectionStart: 6,
  });
});

test("Full motion owns one global effect at a time and module themes never start page-wide effects", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  await openThemeStudio(page);

  await page.locator('.theme-motion-option[data-motion="full"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "full");
  await selectGlobalTheme(page, "matrix");
  await expect(page.locator("#matrix-rain")).toHaveCount(1);
  await expect(page.locator("[data-theme-effect]")).toHaveCount(1);
  await expect.poll(() => page.locator("#theme-studio-scrim").evaluate((element) => (
    getComputedStyle(element).backdropFilter
  ))).toBe("none");
  await page.evaluate(() => {
    window.__themeSharedEffectCanvas = document.querySelector("[data-theme-effect]");
  });
  const matrixMetrics = await page.evaluate(() => window.EchoThemeEffectDiagnostics.getMetrics());
  expect(matrixMetrics.fpsCap).toBe(24);
  expect(matrixMetrics.entityCap).toBeLessThanOrEqual(96);
  expect(matrixMetrics.backingPixels).toBeLessThanOrEqual(matrixMetrics.maxPixels);

  await page.locator('.theme-card[data-theme="matrix"]').click();
  await expect(page.locator("#matrix-rain")).toHaveCount(1);
  await expect(page.locator("[data-theme-effect]")).toHaveCount(1);

  for (const world of ["event-horizon", "tempest", "abyss", "neon-wilds"]) {
    await selectGlobalTheme(page, world);
    const canvas = page.locator(`[data-theme-effect="${world}"]`);
    await expect(canvas).toHaveCount(1);
    const performanceContract = await page.evaluate(() => ({
      metrics: window.EchoThemeEffectDiagnostics.getMetrics(),
      reused: document.querySelector("[data-theme-effect]") === window.__themeSharedEffectCanvas,
    }));
    expect(performanceContract.reused).toBe(true);
    expect(performanceContract.metrics.fpsCap).toBeLessThanOrEqual(24);
    expect(performanceContract.metrics.entityCap).toBeLessThanOrEqual(96);
    expect(performanceContract.metrics.backingPixels)
      .toBeLessThanOrEqual(performanceContract.metrics.maxPixels);
  }

  await selectGlobalTheme(page, "frost");
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);
  await openModuleCustomizer(page);
  const generationBeforeModuleOverride = await page.evaluate(
    () => window.EchoThemeEffectDiagnostics.getMetrics().generation,
  );
  await setModuleTheme(page, "stage", "matrix");
  await expect(page.locator(".room-main")).toHaveAttribute("data-module-theme", "matrix");
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);
  expect(await page.evaluate(
    () => window.EchoThemeEffectDiagnostics.getMetrics().generation,
  )).toBe(generationBeforeModuleOverride);

  await selectGlobalTheme(page, "ultra-instinct");
  await expect(page.locator("#ui-particles")).toHaveCount(1);
  await expect(page.locator("#matrix-rain")).toHaveCount(0);
  await expect(page.locator("[data-theme-effect]")).toHaveCount(1);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage))
    .toContain("ultrainstinct.gif");

  await page.locator('.theme-motion-option[data-motion="ambient"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "ambient");
  await expect(page.locator("#ui-particles")).toHaveCount(1);
  const ambientMetrics = await page.evaluate(() => window.EchoThemeEffectDiagnostics.getMetrics());
  expect(ambientMetrics.fpsCap).toBe(12);
  expect(ambientMetrics.maxPixels).toBeLessThanOrEqual(480000);
  expect(ambientMetrics.entityCap).toBeLessThanOrEqual(96);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage))
    .not.toContain("ultrainstinct.gif");

  await page.locator('.theme-motion-option[data-motion="full"]').click();
  await expect(page.locator("#ui-particles")).toHaveCount(1);
  await page.locator('.theme-motion-option[data-motion="still"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "still");
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);

  await page.locator('.theme-motion-option[data-motion="full"]').click();
  await expect(page.locator("#ui-particles")).toHaveCount(1);
  await page.evaluate(() => {
    window.EchoTheme.destroy();
    window.dispatchEvent(new Event("pageshow"));
  });
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);
  expect(await page.evaluate(() => window.EchoTheme.isDestroyed())).toBe(true);
});

test("system reduced motion suppresses effects without discarding the saved Full preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await openViewer(page);
  await openThemeStudio(page);
  expect(await page.locator(
    '.theme-card[data-theme="ultra-instinct"] .theme-preview',
  ).evaluate((element) => getComputedStyle(element).backgroundImage))
    .not.toContain("ultrainstinct.gif");
  await page.locator('.theme-motion-option[data-motion="ambient"]').click();
  await page.locator('.theme-motion-option[data-motion="full"]').click();
  await selectGlobalTheme(page, "matrix");

  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-requested", "full");
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "still");
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("echo-core-theme-motion"))).toBe("full");

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "full");
  await expect(page.locator("#matrix-rain")).toHaveCount(1);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-requested", "full");
  await expect(page.locator("html")).toHaveAttribute("data-theme-motion-effective", "still");
  await expect(page.locator("[data-theme-effect]")).toHaveCount(0);
});

test("Theme Studio is contained, scrollable, and closable at 360 by 640", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 360, height: 640 });
  await openViewer(page);
  await openThemeStudio(page);

  const geometry = await page.evaluate(() => {
    function rect(element) {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
      };
    }

    const panel = document.getElementById("theme-panel");
    const scroll = panel.querySelector(".theme-studio-scroll");
    const cards = Array.from(panel.querySelectorAll(".theme-card")).map(rect);
    return {
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      cardOverflow: cards.some((card) => (
        card.left < -1 || card.right > window.innerWidth + 1
      )),
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panel: rect(panel),
      scroll: {
        clientHeight: scroll.clientHeight,
        overflowX: scroll.scrollWidth - scroll.clientWidth,
        scrollHeight: scroll.scrollHeight,
      },
      viewport: { height: window.innerHeight, width: window.innerWidth },
    };
  });

  expect(geometry.panel.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width + 1);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(-1);
  expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height + 1);
  expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.cardOverflow).toBe(false);
  expect(geometry.scroll.overflowX).toBeLessThanOrEqual(1);
  expect(geometry.scroll.scrollHeight).toBeGreaterThan(geometry.scroll.clientHeight);

  await page.locator(".theme-studio-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(
    () => page.locator(".theme-studio-scroll").evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.getElementById("open-theme-portal").focus();
  });
  await page.keyboard.press("Tab");
  await expect(page.locator("#close-theme")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#theme-panel")).toBeHidden();
  await expect(page.locator("#open-theme-portal")).toBeFocused();
});
