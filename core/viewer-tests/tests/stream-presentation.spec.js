import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/install-scenario.js");
const runtimeErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => route.fulfill({
    status: 200, contentType: "application/json", body: route.request().url().includes("/version") ? "{}" : "[]",
  }));
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

async function install(page, options = {}) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate(options => window.EchoLayoutTestScenario.install({
    participants: 3, cameras: 0, screenShares: 2, shareAspects: [1916 / 802, 16 / 9], ...options,
  }), options);
  await settle(page);
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function assertFooter(page, index = 0) {
  const result = await page.locator("#screen-grid > .tile").nth(index).evaluate(tile => {
    const control = tile.querySelector(".tile-volume-wrap");
    const input = control.querySelector("input");
    const box = tile.getBoundingClientRect();
    const footer = control.getBoundingClientRect();
    const slider = input.getBoundingClientRect();
    return { bottomGap: box.bottom - footer.bottom, footerHeight: footer.height,
      footerInTile: footer.left >= box.left && footer.right <= box.right,
      sliderInFooter: slider.top >= footer.top && slider.bottom <= footer.bottom,
      fit: getComputedStyle(tile.querySelector("video")).objectFit };
  });
  expect(result.bottomGap).toBeGreaterThanOrEqual(-1);
  expect(result.bottomGap).toBeLessThanOrEqual(2);
  expect(result.footerHeight).toBeLessThanOrEqual(44);
  expect(result.footerInTile).toBe(true);
  expect(result.sliderInFooter).toBe(true);
  expect(result.fit).toBe("contain");
}

test("volume stays at the bottom and only reveals at its controls in grid, focus, and fullscreen", async ({ page }) => {
  await page.setViewportSize({ width: 3440, height: 1370 });
  await install(page);
  const tiles = page.locator("#screen-grid > .tile");
  await tiles.evaluateAll(elements => elements.forEach(tile => tile.querySelector(".tile-volume-wrap").classList.remove("hidden")));
  const footer = tiles.first().locator(".tile-volume-wrap");
  const video = tiles.first().locator("video");
  await video.hover();
  await expect(footer).toHaveCSS("opacity", "0");
  await video.click();
  await expect(tiles.first()).toHaveClass(/is-focused/);
  await settle(page);
  await expect(footer).toHaveCSS("opacity", "0");
  await assertFooter(page);
  await footer.hover();
  await expect(footer).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(footer).toHaveCSS("opacity", "0");
  await footer.focus();
  await expect(footer).toHaveCSS("opacity", "1");
  await footer.press("Escape");
  await expect(footer).toHaveCSS("opacity", "0");

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await settle(page);
    await assertFooter(page, 0);
    await assertFooter(page, 1);
  }
  await tiles.first().locator(".tile-fullscreen-btn").click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await assertFooter(page);
  await page.evaluate(() => document.exitFullscreen());
  await settle(page);
  await assertFooter(page);
});

test("touch can open the bottom volume controls without focusing or resizing the share", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "[]" }));
    await install(page, { screenShares: 1 });
    const tile = page.locator("#screen-grid > .tile");
    const footer = tile.locator(".tile-volume-wrap");
    await footer.evaluate(element => element.classList.remove("hidden"));
    await expect(footer).toHaveCSS("opacity", "0");
    await footer.tap({ position: { x: 4, y: 20 } });
    await expect(footer).toHaveCSS("opacity", "1");
    await expect(tile).not.toHaveClass(/is-focused/);
    await assertFooter(page);
  } finally { await context.close(); }
});

test("mixed shares reflow across window sizes without replacing media or distorting its aspect", async ({ page }) => {
  await page.setViewportSize({ width: 3440, height: 1370 });
  await install(page, { participants: 6, screenShares: 6, shareAspects: [1916 / 802, 16 / 9, 9 / 16, 32 / 9, 4 / 3, 16 / 10] });
  await page.evaluate(() => {
    window.presentationVideos = Array.from(document.querySelectorAll("#screen-grid video"));
    window.presentationTracks = window.presentationVideos.map(video => video.srcObject.getVideoTracks()[0]);
  });
  for (const count of [2, 3, 6]) {
    await page.locator("#screen-grid > .tile").evaluateAll((tiles, count) => tiles.forEach((tile, index) => {
      tile.style.display = index < count ? "" : "none";
    }), count);
    for (const viewport of [{ width: 3440, height: 1370 }, { width: 1920, height: 1080 }, { width: 960, height: 540 }, { width: 640, height: 480 }]) {
      await page.setViewportSize(viewport);
      await settle(page);
      const measurements = await page.evaluate(() => {
        const grid = document.getElementById("screen-grid").getBoundingClientRect();
        const tiles = Array.from(document.querySelectorAll("#screen-grid > .tile")).filter(tile => tile.offsetParent);
        const rects = tiles.map(tile => tile.getBoundingClientRect());
        return { items: tiles.map((tile, index) => {
          const r = rects[index], video = tile.querySelector("video");
          return { error: Math.abs(r.width / r.height - video.videoWidth / video.videoHeight),
            contained: r.left >= grid.left - 1 && r.right <= grid.right + 1 && r.top >= grid.top - 1 && r.bottom <= grid.bottom + 1,
            positive: r.width > 0 && r.height > 0,
            overlaps: rects.slice(index + 1).some(b => Math.min(r.right, b.right) - Math.max(r.left, b.left) > 1 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 1) };
        }), preserved: window.presentationVideos.every((video, index) => video.isConnected && video.srcObject.getVideoTracks()[0] === window.presentationTracks[index]) };
      });
      expect(measurements.preserved).toBe(true);
      for (const item of measurements.items) {
        expect(item.contained).toBe(true);
        expect(item.positive).toBe(true);
        expect(item.overlaps).toBe(false);
        expect(item.error).toBeLessThan(0.02);
      }
    }
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate(() => {
    const video = window.presentationVideos[0];
    Object.defineProperties(video, {
      videoWidth: { configurable: true, get: () => 1200 },
      videoHeight: { configurable: true, get: () => 900 },
    });
    video.dispatchEvent(new Event("resize"));
  });
  await expect.poll(() => page.locator("#screen-grid > .tile").first().evaluate(tile => {
    const bounds = tile.getBoundingClientRect();
    return Math.abs(bounds.width / bounds.height - 4 / 3);
  })).toBeLessThan(0.01);
  expect(await page.evaluate(() => window.presentationVideos[0].srcObject.getVideoTracks()[0] === window.presentationTracks[0])).toBe(true);
});

test("People shows source details below names, including hidden shares, and clears/replaces them with publication state", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await install(page, { screenOwners: [2, 3], cameras: 1 });
  const card = page.locator('.user-card[data-identity="layout-fixture-2"]');
  const description = card.locator(".participant-stream-description");
  await expect(description).toHaveText("Sharing screen");
  await page.evaluate(() => {
    const participant = room.remoteParticipants.get("layout-fixture-2");
    const publication = streamActivityPublication(participant.identity, room);
    receiveStreamActivity({ version: 1, trackSid: publication.sid, source: { source_type: "game", source_title: "Onimusha: Way of the Sword" } }, participant, room);
    hiddenScreens.add(participant.identity);
    participantCards.get(participant.identity).syncScreenWatchControls();
  });
  await expect(description).toHaveText("Playing Onimusha: Way of the Sword");
  const geometry = await card.evaluate(card => {
    const name = card.querySelector(card.classList.contains("has-camera") ? ".cam-overlay-name" : ".user-name").getBoundingClientRect();
    const description = card.querySelector(".participant-stream-description").getBoundingClientRect();
    const controls = card.querySelector(".participant-settings-toggle").getBoundingClientRect();
    return { nameBottom: name.bottom, descriptionTop: description.top, descriptionRight: description.right, controlsLeft: controls.left };
  });
  expect(geometry.descriptionTop).toBeGreaterThanOrEqual(geometry.nameBottom);
  expect(geometry.descriptionRight).toBeLessThanOrEqual(geometry.controlsLeft);
  const avatarDescription = page.locator('.user-card[data-identity="layout-fixture-3"] .participant-stream-description');
  await page.evaluate(() => {
    const participant = room.remoteParticipants.get("layout-fixture-3");
    const publication = streamActivityPublication(participant.identity, room);
    receiveStreamActivity({ version: 1, trackSid: publication.sid, source: { source_type: "game", source_title: "Onimusha: Way of the Sword" } }, participant, room);
  });
  await expect(avatarDescription).toHaveText("Playing Onimusha: Way of the Sword");
  const avatarSpacing = await avatarDescription.evaluate(element => ({
    right: element.getBoundingClientRect().right,
    controlsLeft: element.closest(".user-card").querySelector(".participant-settings-toggle").getBoundingClientRect().left,
  }));
  expect(avatarSpacing.right).toBeLessThanOrEqual(avatarSpacing.controlsLeft);
  await page.evaluate(() => {
    const participant = room.remoteParticipants.get("layout-fixture-2");
    participant.trackPublications.clear();
    setParticipantScreenWatchAvailable(participant.identity, false);
  });
  await expect(description).toBeHidden();
  await expect(description).toHaveText("");
  await page.evaluate(() => {
    const participant = room.remoteParticipants.get("layout-fixture-2");
    participant.trackPublications.set("replacement", { kind: "video", source: "screen_share", trackSid: "replacement" });
    setParticipantScreenWatchAvailable(participant.identity, true);
    receiveStreamActivity({ version: 1, trackSid: "replacement", source: { source_type: "window", source_title: "<img src=x onerror=alert(1)> " + "Long window title ".repeat(30) } }, participant, room);
  });
  await expect(description).toContainText("Sharing <img");
  await expect(description.locator("img")).toHaveCount(0);
  await expect(description).toHaveCSS("text-overflow", "ellipsis");
  await page.setViewportSize({ width: 960, height: 540 });
  await settle(page);
  expect(await description.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
});
