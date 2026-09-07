import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/install-scenario.js");
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const messages = [];
  errors.set(page, messages);
  page.on("pageerror", error => messages.push(error.message));
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "[]" }));
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function install(page, aspects = [16 / 9, 16 / 9, 16 / 9], viewport = { width: 1750, height: 1000 }) {
  await page.setViewportSize(viewport);
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: fixture });
  await page.evaluate(aspects => window.EchoLayoutTestScenario.install({
    participants: 3, cameras: 0, screenShares: aspects.length, shareAspects: aspects,
  }), aspects);
  await expect(page.locator("#screen-grid > .tile .tile-reorder-handle")).toHaveCount(aspects.length);
  await page.waitForFunction(() => [...document.querySelectorAll("#screen-grid video")].every(v => v.readyState >= 2 && !v.paused));
  await page.evaluate(() => {
    window.orderOriginal = [...document.querySelectorAll("#screen-grid > .tile")].map(tile => ({
      tile, video: tile.querySelector("video"), track: tile.querySelector("video").srcObject.getVideoTracks()[0],
    }));
  });
  await settle(page);
}

function tile(page, index) { return page.locator("#screen-grid > .tile").nth(index); }
function handle(page, index) { return tile(page, index).locator(".tile-reorder-handle"); }

async function order(page) {
  return page.evaluate(() => [...document.querySelectorAll("#screen-grid > .tile")]
    .sort((a, b) => Number(a.style.order) - Number(b.style.order))
    .map(tile => tile.dataset.trackSid));
}

async function expectStableMedia(page) {
  const result = await page.evaluate(() => window.orderOriginal.map(saved => ({
    sameTile: saved.tile.isConnected,
    sameVideo: saved.tile.querySelector("video") === saved.video,
    sameTrack: saved.video.srcObject.getVideoTracks()[0] === saved.track,
    playing: !saved.video.paused && saved.track.readyState === "live",
  })));
  expect(result.every(r => r.sameTile && r.sameVideo && r.sameTrack && r.playing)).toBe(true);
}

async function startDrag(page, sourceIndex, targetIndex) {
  const from = await handle(page, sourceIndex).boundingBox();
  const to = await tile(page, targetIndex).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
}

test("drag swaps visible positions without moving or restarting any live media node", async ({ page }) => {
  await install(page);
  const before = await tile(page, 2).boundingBox();
  await startDrag(page, 0, 2);
  await expect(tile(page, 2)).toHaveClass(/is-reorder-target/);
  await page.mouse.up();
  await settle(page);
  expect(await order(page)).toEqual(["fixture-screen-3", "fixture-screen-2", "fixture-screen-1"]);
  const moved = await tile(page, 0).boundingBox();
  expect(Math.abs(moved.x - before.x) + Math.abs(moved.y - before.y)).toBeLessThan(2);
  expect(await page.locator("#screen-grid > .tile").evaluateAll(tiles => tiles.map(tile => tile.dataset.trackSid)))
    .toEqual(["fixture-screen-1", "fixture-screen-2", "fixture-screen-3"]);
  await expect(page.locator("#screen-grid")).not.toHaveClass(/is-focused|is-reordering/);
  await expect(page.locator(".tile-order-status")).toContainText("position 3");
  await expectStableMedia(page);
});

test("keyboard order survives mixed-source resizing, focus, and panel toggles", async ({ page }) => {
  await install(page, [16 / 9, 9 / 16, 32 / 9]);
  await handle(page, 2).focus();
  await handle(page, 2).press("ArrowLeft");
  await settle(page);
  await handle(page, 2).press("ArrowUp");
  await settle(page);
  const expected = ["fixture-screen-3", "fixture-screen-1", "fixture-screen-2"];
  expect(await order(page)).toEqual(expected);
  await expect(handle(page, 2)).toBeFocused();
  for (const viewport of [{ width: 3283, height: 650 }, { width: 3283, height: 737 }, { width: 960, height: 540 }, { width: 1750, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await settle(page);
    expect(await order(page)).toEqual(expected);
    const geometry = await page.locator("#screen-grid").evaluate(grid => {
      const g = grid.getBoundingClientRect();
      return [...grid.querySelectorAll(":scope > .tile")].map(tile => {
        const r = tile.getBoundingClientRect(), v = tile.querySelector("video");
        return { contained: r.left >= g.left - 1 && r.right <= g.right + 1 && r.top >= g.top - 1 && r.bottom <= g.bottom + 1, fit: getComputedStyle(v).objectFit };
      });
    });
    expect(geometry.every(g => g.contained && g.fit === "contain")).toBe(true);
    const controls = await page.locator(".tile-reorder-handle:visible, .tile-volume-button:visible").evaluateAll(handles => handles.map(handle => {
      const h = handle.getBoundingClientRect(), t = handle.closest('.tile').getBoundingClientRect();
      return h.left >= t.left && h.right <= t.right && h.top >= t.top && h.bottom <= t.bottom;
    }));
    expect(controls.every(Boolean)).toBe(true);
  }
  await tile(page, 0).locator("video").click();
  await expect(tile(page, 0)).toHaveClass(/is-focused/);
  await expect(handle(page, 0)).toBeHidden();
  await tile(page, 0).locator("video").click();
  await page.locator("#shell-toggle-utility").click();
  await settle(page);
  await page.locator("#shell-toggle-utility").click();
  await settle(page);
  expect(await order(page)).toEqual(expected);
  await expectStableMedia(page);
});

for (const hasTouch of [false, true]) {
test.describe(hasTouch ? 'touch controls' : 'mouse controls', () => {
test.use({ hasTouch });
test("narrow portrait tiles keep volume inside and hide rearrange controls that cannot fit", async ({ page }) => {
  await install(page, [9 / 16, 16 / 9, 32 / 9]);
  const override = await page.addStyleTag({ content: '/* exact tile sizes */' });
  for (const width of [120, 80, 160, 240]) {
    // Isolate exact tile widths so this regression is independent of the host
    // fonts and the layout algorithm's choice of row arrangement.
    await override.evaluate((style, width) => {
      style.textContent = `#screen-grid > .tile:first-child { width: ${width}px !important; height: 300px !important; }`;
    }, width);
    await settle(page);
    const first = tile(page, 0);
    if (width < 132) await expect(first.locator('.tile-reorder-handle')).toBeHidden();
    const contained = await first.evaluate(tile => {
      const t = tile.getBoundingClientRect();
      const buttons = [...tile.querySelectorAll('.tile-volume-button, .tile-fullscreen-btn')].map(button => button.getBoundingClientRect());
      return buttons.every(b => b.left >= t.left && b.right <= t.right && b.top >= t.top && b.bottom <= t.bottom) &&
        (buttons[0].right <= buttons[1].left || buttons[1].right <= buttons[0].left ||
          buttons[0].top >= buttons[1].bottom || buttons[1].top >= buttons[0].bottom);
    });
    expect(contained, JSON.stringify(await first.evaluate(tile => ({
      tile: tile.getBoundingClientRect().toJSON(), container: getComputedStyle(tile).container,
      controls: [...tile.querySelectorAll('.tile-volume-button, .tile-fullscreen-btn')].map(button => ({
        kind: button.className, box: button.getBoundingClientRect().toJSON(),
      })),
    })))).toBe(true);
  }
  await expectStableMedia(page);
});
});
}

test("new shares append while hidden shares and recovery retain their chosen order", async ({ page }) => {
  await install(page);
  await handle(page, 0).press("ArrowRight");
  await settle(page);
  await tile(page, 1).evaluate(tile => { tile.style.display = "none"; });
  await settle(page);
  expect(await order(page)).toEqual(["fixture-screen-2", "fixture-screen-1", "fixture-screen-3"]);
  await tile(page, 1).evaluate(tile => { tile.style.display = ""; });
  await page.evaluate(() => {
    const saved = window.orderOriginal[0];
    replaceScreenVideoElement(saved.tile, saved.video._lkTrack, null);
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    const track = { sid: "new-share", mediaStreamTrack: canvas.captureStream(1).getVideoTracks()[0] };
    addScreenTile("New arrival", createLockedVideoElement(track), track.sid);
  });
  await settle(page);
  expect(await order(page)).toEqual(["fixture-screen-2", "fixture-screen-1", "fixture-screen-3", "new-share"]);
  await expect(tile(page, 0).locator("video")).toHaveClass(/screen-video-surface/);
  expect(await tile(page, 0).locator("video").evaluate(video => video.srcObject.getVideoTracks()[0] === window.orderOriginal[0].track)).toBe(true);
});

for (const cancel of ["escape", "outside", "resize", "remove"]) {
  test(`drag cancellation on ${cancel} leaves the order and focus unchanged`, async ({ page }) => {
    await install(page);
    await startDrag(page, 0, 2);
    if (cancel === "escape") await page.keyboard.press("Escape");
    if (cancel === "outside") await page.mouse.move(3, 3);
    if (cancel === "resize") await page.setViewportSize({ width: 1600, height: 900 });
    if (cancel === "remove") await tile(page, 2).evaluate(tile => tile.remove());
    await settle(page);
    await page.mouse.up();
    await settle(page);
    expect(await order(page)).toEqual(cancel === "remove"
      ? ["fixture-screen-1", "fixture-screen-2"]
      : ["fixture-screen-1", "fixture-screen-2", "fixture-screen-3"]);
    await expect(page.locator("#screen-grid")).not.toHaveClass(/is-focused|is-reordering/);
    await expect(page.locator(".is-reorder-target")).toHaveCount(0);
  });
}

test("ordering stays local to this viewer and resets with the room", async ({ page, context }) => {
  await install(page);
  await handle(page, 0).press("ArrowRight");
  await settle(page);
  const other = await context.newPage();
  await other.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "[]" }));
  await install(other);
  expect(await order(other)).toEqual(["fixture-screen-1", "fixture-screen-2", "fixture-screen-3"]);
  expect(await order(page)).toEqual(["fixture-screen-2", "fixture-screen-1", "fixture-screen-3"]);
  await other.close();
  await page.evaluate(() => window.EchoLayoutTestScenario.install({ participants: 3, cameras: 0, screenShares: 2 }));
  await settle(page);
  expect(await order(page)).toEqual(["fixture-screen-1", "fixture-screen-2"]);
});
