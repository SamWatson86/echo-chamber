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
const trackId = "0123456789ABCDEFGHIJKL";
const playlistId = "ABCDEFGHIJKL0123456789";

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
      spotify_id: trackId,
      spotify_uri: `spotify:track:${trackId}`,
      spotify_url: `https://open.spotify.com/track/${trackId}`,
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
    kind: "track",
    spotify_id: `0${String(index + 1).padStart(21, "0")}`,
    spotify_uri: `spotify:track:0${String(index + 1).padStart(21, "0")}`,
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
    expectedConfirmationConflict: false,
    expectedPlaylistForbidden: false,
    forceConfirmation: false,
    forbidPlaylistItems: false,
    queuePlaylistBodies: [],
    searchTracks: createSearchTracks(),
    state: createJamState(),
    playlist: {
      kind: "playlist",
      spotify_id: playlistId,
      spotify_uri: `spotify:playlist:${playlistId}`,
      spotify_url: `https://open.spotify.com/playlist/${playlistId}`,
      name: "Fixture Road Trip",
      owner: "Fixture Owner",
      description: "A playlist used to verify the real Jam browser.",
      track_count: 30,
      favorited_by_me: false,
      favorite_contributor_count: 1,
    },
  };
  runtimeErrors.set(page, errors);
  apiModels.set(page, model);

  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (model.expectedConfirmationConflict && message.text().includes("409 (Conflict)")) return;
      if (model.expectedPlaylistForbidden && message.text().includes("403 (Forbidden)")) return;
      errors.push(`console.error: ${message.text()}`);
    }
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
    if (url.pathname === "/api/jam/catalog/search" && request.method() === "POST") {
      increment(model, key);
      const requestBody = request.postDataJSON();
      const isPlaylist = requestBody.kind === "playlist";
      const query = requestBody.query;
      if (query === "slow original") await new Promise((resolve) => setTimeout(resolve, 500));
      const searchItems = isPlaylist
        ? [model.playlist]
        : query === "slow original"
          ? [{ ...model.searchTracks[0], name: "Stale Result" }]
          : query === "fresh replacement"
            ? [{ ...model.searchTracks[1], name: "Fresh Result" }]
            : model.searchTracks;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          kind: requestBody.kind,
          items: searchItems,
          offset: requestBody.offset,
          limit: requestBody.limit,
          total: searchItems.length,
          next_offset: null,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/favorites" && request.method() === "GET") {
      increment(model, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          items: [{
            kind: "track",
            spotify_id: trackId,
            spotify_uri: `spotify:track:${trackId}`,
            spotify_url: `https://open.spotify.com/track/${trackId}`,
            name: "Shared Favorite",
            artist: "Fixture Artist",
            attributions: [{ actor_id: "sam", display_name: "Sam", added_at_ms: 100, source: "manual" }],
            contributor_count: 1,
            favorited_by_me: true,
          }, model.playlist],
          contributors: [{ actor_id: "sam", display_name: "Sam", count: 1 }],
          counts: { track: 1, playlist: 1 },
          offset: Number(url.searchParams.get("offset") || 0),
          limit: 20,
          total: 2,
          next_offset: null,
        }),
      });
      return;
    }
    if (url.pathname === `/api/jam/playlists/${playlistId}/items` && request.method() === "GET") {
      increment(model, key);
      if (model.forbidPlaylistItems) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "playlist_items_forbidden",
            message: "Spotify only allows this Echo app to expand playlists the connected account owns or collaborates on; other public playlists require Spotify Extended Quota",
          }),
        });
        return;
      }
      const items = Array.from({ length: 20 }, (_, index) => ({
        ...model.searchTracks[index % model.searchTracks.length],
        spotify_id: `1${String(index + 1).padStart(21, "0")}`,
        spotify_uri: `spotify:track:1${String(index + 1).padStart(21, "0")}`,
        name: `Playlist Song ${index + 1}`,
        playlist_position: index,
      }));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          playlist: model.playlist,
          items,
          skipped: [],
          offset: 0,
          limit: 20,
          total: 30,
          next_offset: 20,
        }),
      });
      return;
    }
    if (url.pathname === "/api/jam/queue/playlist" && request.method() === "POST") {
      increment(model, key);
      model.queuePlaylistBodies.push(request.postDataJSON());
      if (model.forbidPlaylistItems) {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: "playlist_items_forbidden",
            message: "Spotify only allows this Echo app to expand playlists the connected account owns or collaborates on; other public playlists require Spotify Extended Quota",
          }),
        });
        return;
      }
      if (model.forceConfirmation && model.queuePlaylistBodies.length === 1) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "confirmation_required", playable_count: 30, confirmation_threshold: 25 }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, request_id: request.postDataJSON().request_id, queue_batch_id: "batch-1", queued_count: 29, skipped: [{ position: 4, reason: "unavailable" }], partial: true, complete: false, failure: { status: 429, error: "spotify_rate_limited", message: "Spotify rate limit interrupted the batch.", retry_after: "12" } }),
      });
      return;
    }
    if (url.pathname === "/api/jam/history" && request.method() === "GET") {
      increment(model, key);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: 1,
          items: [{
            history_entry_id: "history-1",
            spotify_id: trackId,
            spotify_uri: `spotify:track:${trackId}`,
            spotify_url: `https://open.spotify.com/track/${trackId}`,
            name: "Played While Inactive",
            artist: "Fixture Artist",
            added_at_ms: 1_700_000_000_000,
            played_at_ms: 1_700_000_100_000,
            added_by_actor_id: "sam",
            added_by_name: "Sam",
            playlist: model.playlist,
          }],
          offset: 0,
          limit: 20,
          total: 1,
          next_offset: null,
        }),
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

async function showSourcePcControls(page) {
  await page.evaluate(() => {
    if (_jamPollTimer) {
      clearInterval(_jamPollTimer);
      _jamPollTimer = null;
    }
    _jamSourceLocalControlPending = false;
    _jamSourceLocalControlLegacy = false;
    _jamSourceLocalControl = {
      is_source_host: true,
      takeover_enabled: true,
      monitor_enabled: true,
      takeover_active: true,
      agent_running: true,
      target_device_name: "Phase 2 Spotify fixture",
      last_error: "",
    };
    renderJamSourceLocalControl();
  });
  await expect(page.locator("#jam-panel [data-jam-source-local-card]")).toBeVisible();
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

test("utility navigation uses stable Tools labels instead of changing meanings", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openPhaseTwoViewer(page);

  const utilityToggle = page.locator("#shell-toggle-utility");
  await expect(utilityToggle).toHaveText("Tools");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Hide clubhouse tools");
  await expect(page.locator("#room-sidebar h2")).toHaveText("People & tools");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "People and tools");

  await page.locator("#open-chat").click();
  await expectActiveTool(page, "chat");
  await expect(utilityToggle).toHaveText("Tools");
  await expect(page.locator("#close-chat")).toHaveText("All tools");
  await expect(page.locator("#close-chat")).toHaveAttribute("aria-label", "Back to People and tools");
  await page.locator("#close-chat").click();

  await openJam(page);
  await expectActiveTool(page, "jam");
  await expect(utilityToggle).toHaveText("Tools");
  await expect(page.locator("#close-jam")).toHaveText("All tools");
  await expect(page.locator("#close-jam")).toHaveAttribute("aria-label", "Back to People and tools");

  await utilityToggle.click();
  await expect(utilityToggle).toHaveText("Tools");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Show clubhouse tools");
  await utilityToggle.click();
  await expectActiveTool(page, "jam");
  await expect(utilityToggle).toHaveAttribute("aria-label", "Hide clubhouse tools");

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  await expect(page.locator("#room-sidebar h2")).toHaveText("Active Users");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "People");
  await expect(page.locator("#close-chat")).toHaveText("Close");
  await expect(page.locator("#close-chat")).not.toHaveAttribute("aria-label", /.+/);
  await expect(page.locator("#close-jam")).toHaveText("Close");
  await expect(page.locator("#close-jam")).not.toHaveAttribute("aria-label", /.+/);

  await page.evaluate(() => window.EchoUiShell.applyVariant("v2"));
  await expect(page.locator("#room-sidebar h2")).toHaveText("People & tools");
  await expect(page.locator("#room-sidebar")).toHaveAttribute("aria-label", "People and tools");
});

test("Ultra Instinct keeps the Goku GIF visible through the Phase 2 stage", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openPhaseTwoViewer(page, { screenShares: 0 });
  await page.evaluate(() => applyTheme("ultra-instinct"));

  const presentation = await page.evaluate(() => {
    const bodyStyle = getComputedStyle(document.body);
    const stageStyle = getComputedStyle(document.querySelector(".room-main"));
    const alphaMatch = stageStyle.backgroundColor.match(
      /(?:rgba\([^,]+,[^,]+,[^,]+,\s*|\/\s*)([0-9.]+)\s*\)/
    );
    return {
      bodyBackground: bodyStyle.backgroundImage,
      particleCanvases: document.querySelectorAll("#ui-particles").length,
      stageAlpha: alphaMatch ? Number(alphaMatch[1]) : 1,
    };
  });
  expect(presentation.bodyBackground).toContain("ultrainstinct.gif");
  expect(presentation.particleCanvases).toBe(1);
  expect(presentation.stageAlpha).toBeGreaterThan(0);
  expect(presentation.stageAlpha).toBeLessThan(1);

  const gif = await page.evaluate(() => new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({ height: image.naturalHeight, width: image.naturalWidth }), { once: true });
    image.addEventListener("error", () => resolve({ height: 0, width: 0 }), { once: true });
    image.src = `ultrainstinct.gif?phase2-test=${Date.now()}`;
  }));
  expect(gif.width).toBeGreaterThan(0);
  expect(gif.height).toBeGreaterThan(0);

  await page.evaluate(() => window.EchoUiShell.applyVariant("legacy"));
  await expect(page.locator("html")).toHaveAttribute("data-ui-shell", "legacy");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundImage)).toContain("ultrainstinct.gif");
});

test("empty Stage crest is large, naturally proportioned, and contained", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page, { screenShares: 0 });

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    const presentation = await page.locator("#screen-grid").evaluate((grid) => {
      const gridRect = grid.getBoundingClientRect();
      const stageRect = grid.closest(".room-main").getBoundingClientRect();
      const pseudo = getComputedStyle(grid, "::before");
      return {
        backgroundImage: pseudo.backgroundImage,
        backgroundSize: pseudo.backgroundSize,
        content: pseudo.content,
        grid: { bottom: gridRect.bottom, left: gridRect.left, right: gridRect.right, top: gridRect.top },
        paddingTop: Number.parseFloat(pseudo.paddingTop),
        stage: { bottom: stageRect.bottom, left: stageRect.left, right: stageRect.right, top: stageRect.top },
        tiles: grid.querySelectorAll(":scope > .tile").length,
      };
    });
    expect(presentation.tiles).toBe(0);
    expect(presentation.content).toContain("No one is sharing");
    expect(presentation.backgroundImage).toContain("badge.jpg");
    expect(presentation.backgroundSize).toContain("auto");
    expect(presentation.backgroundSize).not.toContain("58px 58px");
    expect(presentation.paddingTop).toBeGreaterThanOrEqual(135);
    expect(presentation.grid.left).toBeGreaterThanOrEqual(presentation.stage.left - 1);
    expect(presentation.grid.right).toBeLessThanOrEqual(presentation.stage.right + 1);
    expect(presentation.grid.top).toBeGreaterThanOrEqual(presentation.stage.top - 1);
    expect(presentation.grid.bottom).toBeLessThanOrEqual(presentation.stage.bottom + 1);
  }

  const badge = await page.evaluate(() => new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve({ height: image.naturalHeight, width: image.naturalWidth }), { once: true });
    image.addEventListener("error", () => resolve({ height: 0, width: 0 }), { once: true });
    image.src = `badge.jpg?empty-stage-test=${Date.now()}`;
  }));
  expect(badge.width / badge.height).toBeGreaterThan(1.8);
  expect(badge.width / badge.height).toBeLessThan(2);
});

test("People actions stay visible and contained in the theater rail and mini sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    await expectActiveTool(page, "people");
    const geometry = await page.evaluate(() => {
      const sidebar = document.getElementById("room-sidebar").getBoundingClientRect();
      const titleRow = document.querySelector("#room-sidebar .sidebar-title-row");
      const participantAvatar = document.querySelector("#room-sidebar .user-card:not(.has-camera) .user-avatar");
      const actions = Array.from(document.querySelectorAll("#room-sidebar .sidebar-actions button"))
        .filter((button) => getComputedStyle(button).display !== "none")
        .map((button) => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return {
            bottom: rect.bottom,
            height: rect.height,
            hit: hit === button || button.contains(hit),
            id: button.id,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          };
        });
      return {
        actions,
        compactLabels: ["open-soundboard", "open-camera-lobby"].map((id) => {
          const button = document.getElementById(id);
          return {
            after: getComputedStyle(button, "::after").content,
            before: getComputedStyle(button, "::before").content,
            fontSize: getComputedStyle(button).fontSize,
          };
        }),
        participantAvatarWidth: participantAvatar?.getBoundingClientRect().width || 0,
        sidebar: { bottom: sidebar.bottom, left: sidebar.left, right: sidebar.right, top: sidebar.top, width: sidebar.width },
        titleOverflow: titleRow.scrollWidth - titleRow.clientWidth,
      };
    });

    expect(geometry.actions).toHaveLength(7);
    if (expectedMode === "theater") {
      expect(geometry.sidebar.width).toBeGreaterThanOrEqual(299.5);
      expect(geometry.sidebar.width).toBeLessThanOrEqual(328.5);
    }
    expect(geometry.participantAvatarWidth).toBeGreaterThanOrEqual(53.5);
    expect(geometry.titleOverflow).toBeLessThanOrEqual(1);
    expect(geometry.compactLabels).toEqual([
      { after: "none", before: '"Sounds"', fontSize: "0px" },
      { after: "none", before: '"Cameras"', fontSize: "0px" },
    ]);
    for (const action of geometry.actions) {
      expect(action.left, `${action.id} left at ${viewport.width}px`).toBeGreaterThanOrEqual(geometry.sidebar.left - 1);
      expect(action.right, `${action.id} right at ${viewport.width}px`).toBeLessThanOrEqual(geometry.sidebar.right + 1);
      expect(action.top, `${action.id} top at ${viewport.width}px`).toBeGreaterThanOrEqual(geometry.sidebar.top - 1);
      expect(action.bottom, `${action.id} bottom at ${viewport.width}px`).toBeLessThanOrEqual(geometry.sidebar.bottom + 1);
      expect(action.width, `${action.id} width at ${viewport.width}px`).toBeGreaterThanOrEqual(39.5);
      expect(action.height, `${action.id} height at ${viewport.width}px`).toBeGreaterThanOrEqual(39.5);
      expect(action.hit, `${action.id} center hit at ${viewport.width}px`).toBe(true);
    }
  }
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

test("source-PC settings stay collapsed while playback controls remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  await showSourcePcControls(page);

  const disclosure = page.locator("#jam-panel .jam-source-local-details");
  const summary = page.locator("#jam-panel .jam-source-local-summary");
  const switches = page.locator("#jam-panel .jam-source-local-switch input");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(summary).toBeVisible();
  await expect(switches).toHaveCount(2);
  await expect(switches.first()).toBeHidden();
  expect(await page.evaluate(() => {
    const controls = document.getElementById("jam-host-controls");
    const card = document.querySelector("#jam-panel [data-jam-source-local-card]");
    return !!(controls.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  for (const [viewport, expectedMode] of [
    [{ width: 1280, height: 720 }, "theater"],
    [{ width: 900, height: 700 }, "lounge"],
    [{ width: 600, height: 900 }, "compact"],
    [{ width: 360, height: 640 }, "mini"],
  ]) {
    await resizeTo(page, viewport, expectedMode);
    const body = page.locator("#jam-panel .jam-body");
    await body.evaluate((element) => { element.scrollTop = 0; });
    await nextPaint(page);

    const initial = await page.evaluate(() => {
      function verticalBounds(element) {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      }
      const buttonTops = Array.from(document.querySelectorAll("#jam-host-controls button"))
        .filter((button) => getComputedStyle(button).display !== "none")
        .map((button) => Math.round(button.getBoundingClientRect().top));
      return {
        bodyRect: verticalBounds(document.querySelector("#jam-panel .jam-body")),
        buttonTops,
        toolbarRect: verticalBounds(document.getElementById("jam-host-controls")),
      };
    });
    expect(initial.toolbarRect.top).toBeGreaterThanOrEqual(initial.bodyRect.top - 1);
    expect(initial.toolbarRect.bottom).toBeLessThanOrEqual(initial.bodyRect.bottom + 1);
    expect(new Set(initial.buttonTops).size, `one playback row at ${viewport.width}x${viewport.height}`).toBe(1);

    await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await nextPaint(page);
    const sticky = await page.evaluate(() => {
      function verticalBounds(element) {
        const rect = element.getBoundingClientRect();
        return { bottom: rect.bottom, top: rect.top };
      }
      return {
        bodyRect: verticalBounds(document.querySelector("#jam-panel .jam-body")),
        toolbarRect: verticalBounds(document.getElementById("jam-host-controls")),
      };
    });
    expect(sticky.toolbarRect.top, `sticky toolbar top at ${viewport.width}x${viewport.height}`)
      .toBeGreaterThanOrEqual(sticky.bodyRect.top - 1);
    expect(sticky.toolbarRect.bottom, `sticky toolbar bottom at ${viewport.width}x${viewport.height}`)
      .toBeLessThanOrEqual(sticky.bodyRect.bottom + 1);
  }

  await page.locator("#jam-panel .jam-body").evaluate((element) => { element.scrollTop = 0; });
  await summary.click();
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(switches.first()).toBeVisible();
  const expanded = await page.evaluate(() => {
    const card = document.querySelector("#jam-panel [data-jam-source-local-card]");
    const cardRect = card.getBoundingClientRect();
    const rows = Array.from(card.querySelectorAll(".jam-source-local-switch-row")).map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      card: { left: cardRect.left, right: cardRect.right },
      overflow: card.scrollWidth - card.clientWidth,
      rows,
    };
  });
  expect(expanded.overflow).toBeLessThanOrEqual(1);
  for (const row of expanded.rows) {
    expect(row.left).toBeGreaterThanOrEqual(expanded.card.left - 1);
    expect(row.right).toBeLessThanOrEqual(expanded.card.right + 1);
  }
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
      )).filter((button) => getComputedStyle(button).display !== "none" && button.getClientRects().length > 0).map((button) => {
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

test("Jam browser tabs are keyboard navigable and history remains available while inactive", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const model = apiModels.get(page);
  model.state.active = false;
  model.state.spotify_is_playing = false;
  model.state.now_playing = null;
  await openPhaseTwoViewer(page);
  await openJam(page);

  await expect(page.locator("#jam-connect-spotify")).toBeVisible();
  await expect(page.locator("#jam-connect-spotify")).toHaveText("Refresh Spotify Access");
  const spotifyAttribution = page.locator(".jam-spotify-attribution");
  await expect(spotifyAttribution).toHaveAttribute("href", "https://open.spotify.com/");
  await expect(spotifyAttribution.locator("img")).toHaveAttribute("alt", "Spotify");
  expect(await spotifyAttribution.locator("img").evaluate((image) => image.getBoundingClientRect().width)).toBeGreaterThanOrEqual(70);
  const searchTab = page.locator("#jam-view-search-tab");
  await searchTab.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator("#jam-view-library-tab")).toBeFocused();
  await expect(page.locator("#jam-library-section")).toBeVisible();
  await expect(page.locator("#jam-library-list .jam-catalog-item")).toHaveCount(2);
  expect(model.counts["GET /api/jam/history"] || 0).toBe(0);

  await page.keyboard.press("End");
  await expect(page.locator("#jam-view-history-tab")).toBeFocused();
  await expect(page.locator("#jam-history-section")).toBeVisible();
  await expect(page.locator("#jam-history-list")).toContainText("Played While Inactive");
  await expect(page.locator("#jam-history-list")).toContainText("Added by Sam");
  await expect(page.locator("#jam-history-list .jam-history-playlist a")).toHaveText("Fixture Road Trip");
  await expect.poll(() => model.counts["GET /api/jam/history"] || 0).toBe(1);
  await page.evaluate(async () => { await fetchJamState(); });
  expect(model.counts["GET /api/jam/history"] || 0).toBe(1);

  const overflow = await page.locator("#jam-browser").evaluate((browser) => ({
    browser: browser.scrollWidth - browser.clientWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.browser).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
});

test("catalog search aborts and rejects stale results", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  await expect(page.locator("#jam-now-playing .jam-now-playing-name")).toHaveAttribute("href", `https://open.spotify.com/track/${trackId}`);
  await expect(page.locator("#jam-banner .jam-banner-title")).toHaveAttribute("href", `https://open.spotify.com/track/${trackId}`);
  await expect(page.locator("#jam-now-playing")).not.toHaveAttribute("role", "button");
  await expect(page.locator("#jam-join-btn")).toBeVisible();
  await expect(page.locator("#jam-banner")).toHaveAttribute("role", "group");
  await expect(page.locator("#jam-banner .jam-banner-open")).toHaveRole("button");
  const input = page.locator("#jam-search-input");

  await input.fill("slow original");
  await expect.poll(() => model.counts["POST /api/jam/catalog/search"] || 0).toBe(1);
  await input.fill("fresh replacement");
  await expect(page.locator("#jam-results")).toContainText("Fresh Result");
  await page.waitForTimeout(600);
  await expect(page.locator("#jam-results")).not.toContainText("Stale Result");
});

test("playlist detail confirms over 25 once and enqueues one locked server batch", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("road trip");
  await expect(page.locator("#jam-results .jam-inspect-btn")).toHaveCount(1);
  await page.locator("#jam-results .jam-inspect-btn").click();
  await expect(page.locator("#jam-playlist-items .jam-catalog-item")).toHaveCount(20);
  await expect(page.locator("#jam-playlist-load-more")).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("30 songs");
    await dialog.accept();
  });
  await page.locator("#jam-playlist-add-all").dblclick();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist"] || 0).toBe(1);
  expect(model.queuePlaylistBodies).toHaveLength(1);
  expect(model.queuePlaylistBodies[0]).toMatchObject({ playlist_id: playlistId, confirmed: true, generation: 7 });
  expect(model.queuePlaylistBodies[0].request_id).toBeTruthy();
  await expect(page.locator("#jam-playlist-status")).toContainText("partially added");
  await expect(page.locator("#jam-playlist-status")).toContainText("Try again in 12 seconds");
});

test("unknown playlist count honors the server confirmation_required contract", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.forceConfirmation = true;
  model.expectedConfirmationConflict = true;
  await page.evaluate((id) => {
    _jamPlaylist = normalizeSpotifyCatalogItem({ kind: "playlist", spotify_id: id, name: "Unknown Count" }, "playlist");
    _jamPlaylistTotal = null;
    _jamPlaylistLoading = false;
    document.getElementById("jam-search-section").hidden = true;
    document.getElementById("jam-playlist-detail").hidden = false;
    renderJamPlaylistSummary();
  }, playlistId);

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("30 songs");
    await dialog.accept();
  });
  await page.locator("#jam-playlist-add-all").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist"] || 0).toBe(2);
  expect(model.queuePlaylistBodies.map((body) => body.confirmed)).toEqual([false, true]);
  expect(model.queuePlaylistBodies[1].request_id).toBe(model.queuePlaylistBodies[0].request_id);
});

test("Spotify development-mode playlist restrictions remain actionable in detail and add-all", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openPhaseTwoViewer(page);
  await openJam(page);
  const model = apiModels.get(page);
  model.forbidPlaylistItems = true;
  model.expectedPlaylistForbidden = true;
  await page.locator("#jam-search-playlist-tab").click();
  await page.locator("#jam-search-input").fill("restricted playlist");
  await page.locator("#jam-results .jam-inspect-btn").click();
  const expectedMessage = "only allows this Echo app to expand playlists the connected account owns or collaborates on";
  await expect(page.locator("#jam-playlist-status")).toContainText(expectedMessage);
  await expect(page.locator("#jam-playlist-status")).not.toContainText("unavailable right now");

  page.once("dialog", async (dialog) => { await dialog.accept(); });
  await page.locator("#jam-playlist-add-all").click();
  await expect.poll(() => model.counts["POST /api/jam/queue/playlist"] || 0).toBe(1);
  await expect(page.locator("#jam-playlist-status")).toContainText(expectedMessage);
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
