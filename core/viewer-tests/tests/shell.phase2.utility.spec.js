import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const runtimeErrors = new WeakMap();
const apiModels = new WeakMap();
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const transparentDataUrl = `data:image/png;base64,${transparentPng.toString("base64")}`;

function longText(label) {
  return `${label} ${"Private Clubhouse Fellowship Anthem ".repeat(4).trim()}`;
}

function createJamState() {
  return {
    jam_protocol_version: 3,
    active: true,
    generation: 7,
    spotify_connected: true,
    spotify_is_playing: true,
    playback_stop_supported: true,
    source_enabled: true,
    source_availability_known: true,
    source_status: "live",
    source_ready: true,
    source_last_frame_ms: 24,
    source_peak: 0.42,
    host_identity: "layout-fixture-1",
    listener_count: 2,
    listeners: ["layout-fixture-2", "layout-fixture-3"],
    now_playing: {
      name: longText("Now Playing"),
      artist: longText("The Extremely Long Artist Name"),
      album_art_url: transparentDataUrl,
      duration_ms: 240_000,
      progress_ms: 91_000,
      is_playing: true,
    },
    queue: Array.from({ length: 8 }, (_, index) => ({
      spotify_uri: `spotify:track:queue-${index + 1}`,
      name: longText(`Queued Song ${index + 1}`),
      artist: longText(`Queued Artist ${index + 1}`),
      album_art_url: transparentDataUrl,
      duration_ms: 180_000 + index * 1_000,
      added_by: `Friend ${index + 2}`,
    })),
  };
}

function createSearchTracks() {
  return Array.from({ length: 6 }, (_, index) => ({
    spotify_uri: `spotify:track:search-${index + 1}`,
    name: longText(`Search Result ${index + 1}`),
    artist: longText(`Search Artist ${index + 1}`),
    album_art_url: transparentDataUrl,
    duration_ms: 201_000 + index * 1_000,
  }));
}

function increment(model, key) {
  model.counts[key] = (model.counts[key] || 0) + 1;
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  const model = {
    counts: Object.create(null),
    errors,
    searchTracks: createSearchTracks(),
    state: createJamState(),
  };
  runtimeErrors.set(page, errors);
  apiModels.set(page, model);

  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;

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
    if (url.pathname === "/api/jam/state" && request.method() === "GET") {
      increment(model, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(model.state),
      });
      return;
    }
    if (url.pathname === "/api/jam/search" && request.method() === "POST") {
      increment(model, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tracks: model.searchTracks }),
      });
      return;
    }
    if (url.pathname === "/api/jam/playback/stop" && request.method() === "POST") {
      increment(model, key);
      model.state.spotify_is_playing = false;
      if (model.state.now_playing) model.state.now_playing.is_playing = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (url.pathname === "/api/jam/stop" && request.method() === "POST") {
      increment(model, key);
      model.state.active = false;
      model.state.spotify_is_playing = false;
      model.state.now_playing = null;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    errors.push(`unexpected API request: ${key}`);
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({ error: "unmodeled Phase 2 viewer-test endpoint" }),
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

async function openPhaseTwoViewer(page, scenario = {}) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate((options) => window.EchoLayoutTestScenario.install(options), {
    participants: 6,
    cameras: 2,
    screenShares: 1,
    ...scenario,
  });
  await page.evaluate(() => {
    room = {
      localParticipant: {
        identity: "layout-fixture-1",
        name: "Fixture Host",
        publishData: async function() {},
      },
    };
    adminToken = "phase-2-admin-token";
    currentAccessToken = "phase-2-participant-token";
    ["open-chat", "open-jam", "dock-output", "open-settings"].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.disabled = false;
    });
  });
  await nextPaint(page);
}

async function openJam(page) {
  const button = page.locator("#open-jam");
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expect(page.locator("#jam-spotify-status")).toHaveText("Spotify Connected");
  await expect(page.locator("#jam-search-section")).toBeVisible();
}

async function searchJam(page, query = "clubhouse") {
  const input = page.locator("#jam-search-input");
  await input.fill(query);
  await expect(page.locator(".jam-result-item")).toHaveCount(6);
}

async function expectActiveTool(page, tool) {
  await expect(page.locator("#utility-host")).toHaveAttribute("data-active-tool", tool);
  await expect(page.locator("html")).toHaveAttribute("data-ui-utility", tool);
  const state = await page.evaluate((activeTool) => {
    const tools = {
      people: document.getElementById("room-sidebar"),
      chat: document.getElementById("chat-panel"),
      jam: document.getElementById("jam-panel"),
    };
    return Object.fromEntries(Object.entries(tools).map(([name, element]) => [name, {
      ariaHidden: element.getAttribute("aria-hidden"),
      hidden: element.classList.contains("hidden"),
      inert: element.inert,
      rendered: element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
      expected: name === activeTool,
    }]));
  }, tool);

  for (const [name, value] of Object.entries(state)) {
    expect(value.rendered, `${name} rendered state`).toBe(value.expected);
    expect(value.hidden, `${name} hidden class`).toBe(!value.expected);
    expect(value.inert, `${name} inert state`).toBe(!value.expected);
    expect(value.ariaHidden, `${name} aria-hidden state`).toBe(value.expected ? "false" : "true");
  }
}

async function resizeTo(page, viewport, expectedMode) {
  await page.setViewportSize(viewport);
  await expect.poll(() => page.evaluate(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))).toEqual(viewport);
  await nextPaint(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", expectedMode);
}

test("one logical utility owns stable People, Chat, and portaled Jam tools without losing form state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  const structure = await page.evaluate(() => {
    const host = document.getElementById("utility-host");
    const overlay = document.getElementById("shell-overlay-root");
    const jam = document.getElementById("jam-panel");
    window.__phase2JamNode = jam;
    return {
      ariaOwns: host.getAttribute("aria-owns"),
      chatInsideHost: host.contains(document.getElementById("chat-panel")),
      jamInsideHost: host.contains(jam),
      jamInsideOverlay: overlay.contains(jam),
      jamCount: document.querySelectorAll("#jam-panel").length,
      peopleInsideHost: host.contains(document.getElementById("room-sidebar")),
      toolCount: document.querySelectorAll("[data-ui-tool]").length,
    };
  });
  expect(structure).toEqual({
    ariaOwns: "jam-panel",
    chatInsideHost: true,
    jamInsideHost: false,
    jamInsideOverlay: true,
    jamCount: 1,
    peopleInsideHost: true,
    toolCount: 3,
  });
  await expectActiveTool(page, "people");

  await page.locator("#open-chat").click();
  await expectActiveTool(page, "chat");
  await page.locator("#chat-input").fill("A clubhouse Chat draft that must survive tool switches");

  await page.keyboard.press("Escape");
  await expectActiveTool(page, "people");
  await expect(page.locator("#open-chat")).toBeFocused();

  await openJam(page);
  await expectActiveTool(page, "jam");
  await searchJam(page);
  await page.locator("#jam-volume-slider").evaluate((input) => {
    input.value = "73";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#jam-volume-value")).toHaveText("73%");
  await page.locator(".jam-body").evaluate((body) => { body.scrollTop = body.scrollHeight; });
  const jamScrollTop = await page.locator(".jam-body").evaluate((body) => body.scrollTop);
  expect(jamScrollTop).toBeGreaterThan(0);

  await page.locator("#shell-toggle-utility").click();
  await expect(page.locator(".room-layout")).toHaveClass(/utility-collapsed/);
  await expect(page.locator("#jam-panel")).toBeHidden();
  await expect.poll(() => page.locator("#jam-panel").evaluate((panel) => panel.inert)).toBe(true);
  await expect.poll(() => page.locator("#utility-host").evaluate((host) => host.inert)).toBe(true);

  await page.locator("#shell-toggle-utility").click();
  await expectActiveTool(page, "jam");
  await page.locator("#close-jam").click();
  await expectActiveTool(page, "people");
  await page.locator("#open-chat").click();
  await expectActiveTool(page, "chat");
  await expect(page.locator("#chat-input")).toHaveValue("A clubhouse Chat draft that must survive tool switches");

  await page.keyboard.press("Escape");
  await page.locator("#open-jam").click();
  await expectActiveTool(page, "jam");
  await expect(page.locator("#jam-search-input")).toHaveValue("clubhouse");
  await expect(page.locator(".jam-result-item")).toHaveCount(6);
  await expect(page.locator("#jam-volume-slider")).toHaveValue("73");
  expect(await page.locator(".jam-body").evaluate((body) => body.scrollTop)).toBe(jamScrollTop);
  expect(await page.evaluate(() => window.__phase2JamNode === document.getElementById("jam-panel"))).toBe(true);
});

test("responsive modes and live legacy rollback retain the same centered Jam node and state", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await searchJam(page, "anthem");
  await page.locator("#jam-volume-slider").evaluate((input) => {
    input.value = "64";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(() => { window.__phase2ResponsiveJamNode = document.getElementById("jam-panel"); });

  for (const [viewport, expectedMode] of [
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    await expectActiveTool(page, "jam");
    expect(await page.evaluate(() => window.__phase2ResponsiveJamNode === document.getElementById("jam-panel"))).toBe(true);
    await expect(page.locator("#jam-search-input")).toHaveValue("anthem");
    await expect(page.locator("#jam-volume-slider")).toHaveValue("64");
  }

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#jam-panel")).toBeVisible();
  const legacy = await page.locator("#jam-panel").evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      sameNode: window.__phase2ResponsiveJamNode === panel,
      viewportCenterX: window.innerWidth / 2,
      viewportCenterY: window.innerHeight / 2,
    };
  });
  expect(legacy.sameNode).toBe(true);
  expect(Math.abs(legacy.centerX - legacy.viewportCenterX)).toBeLessThanOrEqual(1);
  expect(Math.abs(legacy.centerY - legacy.viewportCenterY)).toBeLessThanOrEqual(1);
  await expect(page.locator("#jam-search-input")).toHaveValue("anthem");
  await expect(page.locator("#jam-volume-slider")).toHaveValue("64");

  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "v2");
  await expectActiveTool(page, "jam");
  expect(await page.evaluate(() => window.__phase2ResponsiveJamNode === document.getElementById("jam-panel"))).toBe(true);
});

test("Jam focus returns through Escape and Settings explicitly inerts the portaled tool", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);
  await openJam(page);

  await expect(page.locator("#close-jam")).toBeFocused();
  await page.keyboard.press("Escape");
  await expectActiveTool(page, "people");
  await expect(page.locator("#open-jam")).toBeFocused();

  await page.locator("#open-jam").click();
  await expectActiveTool(page, "jam");
  const output = page.locator("#dock-output");
  await output.click();
  await expect(page.locator("#settings-panel")).toBeVisible();
  await expect(page.locator("#settings-panel")).toHaveAttribute("aria-modal", "");
  await expect(page.locator("#close-settings")).toBeFocused();
  await expect.poll(() => page.locator("#clubhouse-shell").evaluate((shell) => shell.inert)).toBe(true);
  await expect.poll(() => page.locator("#jam-panel").evaluate((panel) => panel.inert)).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-panel")).toBeHidden();
  await expect(output).toBeFocused();
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expect.poll(() => page.locator("#jam-panel").evaluate((panel) => panel.inert)).toBe(false);
  await expectActiveTool(page, "jam");

  await page.keyboard.press("Escape");
  await expectActiveTool(page, "people");
  await expect(page.locator("#open-jam")).toBeFocused();
});

test("collapsed Chat records unread messages and a top overlay owns the first Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);

  await page.locator("#open-chat").click();
  await expectActiveTool(page, "chat");
  await page.locator("#shell-toggle-utility").click();
  await expect(page.locator(".room-layout")).toHaveClass(/utility-collapsed/);

  await page.evaluate(() => incrementUnreadChat());
  await expect(page.locator("#chat-badge")).toHaveText("1");
  await expect(page.locator("#chat-badge")).not.toHaveClass(/hidden/);

  await page.locator("#shell-toggle-utility").click();
  await expectActiveTool(page, "chat");
  await expect(page.locator("#chat-badge")).toHaveClass(/hidden/);

  await page.evaluate((src) => openImageLightbox(src), transparentDataUrl);
  await expect(page.locator(".image-lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".image-lightbox")).toHaveCount(0);
  await expectActiveTool(page, "chat");

  await page.keyboard.press("Escape");
  await expectActiveTool(page, "people");
});

test("populated Jam remains inside the workspace and above the dock at representative sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, { unbrokenNames: true });
  await openJam(page);
  await searchJam(page, "responsive");

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    const geometry = await page.evaluate(() => {
      function rect(selector) {
        const bounds = document.querySelector(selector).getBoundingClientRect();
        return {
          bottom: bounds.bottom,
          height: bounds.height,
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          width: bounds.width,
        };
      }
      const targetSizes = Array.from(document.querySelectorAll(
        "#jam-panel button:not(.hidden):not([style*='display:none']):not([style*='display: none'])",
      )).filter((button) => getComputedStyle(button).display !== "none").map((button) => {
        const bounds = button.getBoundingClientRect();
        return { height: bounds.height, id: button.id || button.className, width: bounds.width };
      });
      const textOverflow = Array.from(document.querySelectorAll(
        "#jam-panel .jam-result-info, #jam-panel .jam-now-playing-info, #jam-panel .jam-result-name, #jam-panel .jam-result-artist",
      )).some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX === "visible");
      return {
        bodyOverflowX: document.body.scrollWidth - window.innerWidth,
        documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        dock: rect("#call-controls"),
        header: rect('.room-top[data-ui-region="shell-header"]'),
        jam: rect("#jam-panel"),
        search: rect("#jam-search-input"),
        targetSizes,
        textOverflow,
        viewport: { height: window.innerHeight, width: window.innerWidth },
        workspace: rect('.room-layout[data-ui-region="workspace"]'),
      };
    });

    expect(geometry.jam.left).toBeGreaterThanOrEqual(geometry.workspace.left - 1);
    expect(geometry.jam.right).toBeLessThanOrEqual(geometry.workspace.right + 1);
    expect(geometry.jam.top).toBeGreaterThanOrEqual(geometry.workspace.top - 1);
    expect(geometry.jam.bottom).toBeLessThanOrEqual(geometry.workspace.bottom + 1);
    expect(geometry.jam.top).toBeGreaterThanOrEqual(geometry.header.bottom - 1);
    expect(geometry.jam.bottom).toBeLessThanOrEqual(geometry.dock.top - 1);
    expect(geometry.search.top).toBeGreaterThanOrEqual(geometry.jam.top - 1);
    expect(geometry.search.bottom).toBeLessThanOrEqual(geometry.jam.bottom + 1);
    expect(geometry.documentOverflowX).toBeLessThanOrEqual(1);
    expect(geometry.bodyOverflowX).toBeLessThanOrEqual(1);
    expect(geometry.textOverflow).toBe(false);
    expect(geometry.targetSizes.length).toBeGreaterThan(4);
    for (const target of geometry.targetSizes) {
      expect(target.height, `${target.id} height at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(39.5);
      expect(target.width, `${target.id} width at ${viewport.width}x${viewport.height}`).toBeGreaterThanOrEqual(39.5);
    }
  }
});

test("Stop Music preserves the Jam while exact-host End Jam remains a distinct destructive action", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  const stopMusic = page.locator("#jam-stop-music-btn");
  const endJam = page.locator("#jam-end-btn");

  await expect(stopMusic).toBeVisible();
  await expect(endJam).toBeVisible();
  await expect(stopMusic).toHaveAttribute("title", /Jam stays open/);
  await expect(endJam).toHaveAttribute("title", /Ends the Jam/);
  const visualDistinction = await page.evaluate(() => {
    const stopStyle = getComputedStyle(document.getElementById("jam-stop-music-btn"));
    const endStyle = getComputedStyle(document.getElementById("jam-end-btn"));
    return {
      backgroundDifferent: stopStyle.backgroundColor !== endStyle.backgroundColor,
      borderDifferent: stopStyle.borderColor !== endStyle.borderColor,
      colorDifferent: stopStyle.color !== endStyle.color,
    };
  });
  expect(Object.values(visualDistinction).some(Boolean)).toBe(true);

  await stopMusic.click();
  await expect.poll(() => model.counts["POST /api/jam/playback/stop"] || 0).toBe(1);
  expect(model.counts["POST /api/jam/stop"] || 0).toBe(0);
  await expect(page.locator("#jam-panel")).toBeVisible();
  await expectActiveTool(page, "jam");
  await expect(page.locator("#jam-now-playing")).toContainText("No music playing");
  expect(model.state.active).toBe(true);
  expect(model.state.generation).toBe(7);
  expect(model.state.listeners).toEqual(["layout-fixture-2", "layout-fixture-3"]);

  model.state.host_identity = "layout-fixture-1-RECONNECTED";
  await page.evaluate(() => fetchJamState());
  await expect(endJam).toBeHidden();
  await expect(stopMusic).toBeVisible();

  model.state.host_identity = "layout-fixture-1";
  await page.evaluate(() => fetchJamState());
  await expect(endJam).toBeVisible();
  await endJam.click();
  await expect.poll(() => model.counts["POST /api/jam/stop"] || 0).toBe(1);
  expect(model.counts["POST /api/jam/playback/stop"] || 0).toBe(1);
  expect(model.state.active).toBe(false);
  await expect(endJam).toBeHidden();
});
