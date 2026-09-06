import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/install-scenario.js");
const runtimeErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });

const viewports = [
  { width: 1750, height: 1000 },
  { width: 3440, height: 1370 },
  { width: 5120, height: 1440 },
  { width: 3840, height: 2160 },
  { width: 1920, height: 1080 },
  { width: 960, height: 540 },
  { width: 640, height: 480 },
  { width: 390, height: 844 },
];

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => {
    let frames = 4;
    function step() { if (--frames) requestAnimationFrame(step); else resolve(); }
    requestAnimationFrame(step);
  }));
}

async function install(page, aspects) {
  await page.route("**/api/**", route => route.fulfill({ contentType: "application/json", body: "[]" }));
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate(aspects => window.EchoLayoutTestScenario.install({
    participants: 3, cameras: 0, screenShares: aspects.length, shareAspects: aspects,
  }), aspects);
  // Use actual decoded dimensions, including Brad's 1920x1080 input. A CSS box
  // or overridden videoWidth alone does not exercise the media element's sizing.
  await page.evaluate(aspects => {
    window.recoveryLayoutTiles = [...document.querySelectorAll("#screen-grid > .tile")];
    window.recoveryLayoutTracks = window.recoveryLayoutTiles.map(tile => tile.querySelector("video")._lkTrack);
    window.__echoLayoutFixtureMedia.canvases.forEach((canvas, index) => {
      canvas.width = Math.round(aspects[index] * 1080);
      canvas.height = 1080;
      const context = canvas.getContext("2d");
      context.fillStyle = "#132238";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.strokeStyle = "#38bdf8";
      context.lineWidth = 24;
      context.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
      const video = window.recoveryLayoutTiles[index].querySelector("video");
      delete video.videoWidth;
      delete video.videoHeight;
      const track = window.recoveryLayoutTracks[index];
      track.attach = (element = document.createElement("video")) => {
        element.srcObject = new MediaStream([track.mediaStreamTrack]);
        return element;
      };
      track.mediaStreamTrack.requestFrame();
    });
  }, aspects);
  await page.waitForFunction(() => [...document.querySelectorAll("#screen-grid video")].every(video => video.videoHeight === 1080));
}

async function recover(page) {
  await page.evaluate(() => {
    window.recoveryLayoutOldVideos = window.recoveryLayoutTiles.map(tile => tile.querySelector("video"));
    window.recoveryLayoutTiles.forEach((tile, index) => replaceScreenVideoElement(tile, window.recoveryLayoutTracks[index], null));
  });
  await page.waitForFunction(() => [...document.querySelectorAll("#screen-grid video")].every(video => video.videoWidth > 0 && video.readyState >= 2));
  await settle(page);
}

async function expectContainedShares(page, label) {
  const measurements = await page.evaluate(() => {
    const grid = document.querySelector("#screen-grid");
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const within = (inner, outer) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
    const gridBox = rect(grid);
    const stageBox = rect(grid.closest(".room-main"));
    const viewportBox = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const utility = document.querySelector(".utility-host");
    const utilityVisible = utility && utility.offsetParent && getComputedStyle(utility).visibility !== "hidden";
    const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const tiles = [...grid.querySelectorAll(":scope > .tile")].filter(tile => tile.offsetParent);
    const boxes = tiles.map(rect);
    return tiles.map((tile, index) => {
      const video = tile.querySelector("video");
      const box = boxes[index];
      const originalIndex = window.recoveryLayoutTiles.indexOf(tile);
      return { index: originalIndex, tile: box, video: rect(video),
        videoInsideTile: within(rect(video), box), tileInsideGrid: within(box, gridBox),
        stageInsideViewport: within(stageBox, viewportBox), gridInsideStage: within(gridBox, stageBox),
        coveredByUtility: !!utilityVisible && intersects(box, rect(utility)),
        overlaps: boxes.slice(index + 1).some(other => Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1),
        objectFit: getComputedStyle(video).objectFit,
        aspectError: Math.abs(Number(tile.style.getPropertyValue("--screen-source-aspect-ratio")) - video.videoWidth / video.videoHeight),
        trackPreserved: video.srcObject?.getVideoTracks()[0] === window.recoveryLayoutTracks[originalIndex].mediaStreamTrack,
        trackLive: video.srcObject?.getVideoTracks()[0]?.readyState === "live",
      };
    });
  });
  for (const result of measurements) {
    expect(result.videoInsideTile, `${label}: video escaped tile ${JSON.stringify(result)}`).toBe(true);
    expect(result.tileInsideGrid, `${label}: tile escaped Stage`).toBe(true);
    expect(result.stageInsideViewport && result.gridInsideStage, `${label}: Stage escaped visible workspace`).toBe(true);
    expect(result.coveredByUtility, `${label}: open panel covers stream ${JSON.stringify(result)}`).toBe(false);
    expect(result.overlaps, `${label}: shares overlap`).toBe(false);
    expect(result.video.width, label).toBeGreaterThan(0);
    expect(result.video.height, label).toBeGreaterThan(0);
    expect(result.objectFit, label).toBe("contain");
    expect(result.aspectError, label).toBeLessThan(0.00001);
    expect(result.trackPreserved && result.trackLive, `${label}: live track retained`).toBe(true);
  }
}

test("recovered shares reserve space for panels through short ultrawide resize transitions", async ({ page }) => {
  // Sam's 3283x737 window retained lounge mode after a shorter window drag.
  // Starting directly at 737px classifies as theater and misses the overlap.
  await page.setViewportSize({ width: 3283, height: 650 });
  await install(page, [16 / 9, 9 / 16, 32 / 9]);
  await recover(page);
  await page.setViewportSize({ width: 3283, height: 737 });
  await settle(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-mode", "lounge");
  await expectContainedShares(page, "Sam's short ultrawide window");

  for (const viewport of [
    { width: 3283, height: 800 }, { width: 3283, height: 737 },
    { width: 3283, height: 650 }, { width: 1750, height: 737 },
    { width: 1280, height: 650 }, { width: 1024, height: 700 },
    { width: 900, height: 540 }, { width: 640, height: 480 },
    { width: 390, height: 844 }, { width: 3283, height: 737 },
  ]) {
    await page.setViewportSize(viewport);
    await settle(page);
    await expectContainedShares(page, `open Users at ${viewport.width}x${viewport.height}`);
    await page.locator("#shell-toggle-utility").click();
    await settle(page);
    await expectContainedShares(page, "Users hidden");
    await page.locator("#shell-toggle-utility").click();
    await settle(page);
    await expectContainedShares(page, "Users restored");
  }
});

for (const [name, aspect] of [["16:9", 16 / 9], ["16:10", 16 / 10], ["21:9", 21 / 9], ["32:9", 32 / 9], ["4:3", 4 / 3], ["portrait", 9 / 16]]) {
  test(`recovered ${name} share stays fully visible when maximizing and restoring`, async ({ page }) => {
    await page.setViewportSize(viewports[0]);
    await install(page, [aspect]);
    await recover(page);
    for (const viewport of [...viewports, viewports[0]]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await expectContainedShares(page, `${name} at ${viewport.width}x${viewport.height}`);
    }
  });
}

test("recovered shares retain sizing through mixed/uniform grids, focus, fullscreen, and source resizing", async ({ page }) => {
  await page.setViewportSize(viewports[1]);
  await install(page, [16 / 9, 16 / 9, 16 / 9]);
  await recover(page);
  await expectContainedShares(page, "uniform recovery");
  await page.evaluate(() => {
    const canvas = window.__echoLayoutFixtureMedia.canvases[1];
    canvas.width = 608;
    canvas.height = 1080;
    canvas.getContext("2d").fillRect(0, 0, canvas.width, canvas.height);
    window.recoveryLayoutTracks[1].mediaStreamTrack.requestFrame();
  });
  await page.waitForFunction(() => window.recoveryLayoutTiles[1].querySelector("video").videoWidth === 608);
  await settle(page);
  // Late events from the discarded element must not overwrite the new aspect.
  await page.evaluate(() => {
    const oldVideo = window.recoveryLayoutOldVideos[1];
    Object.defineProperties(oldVideo, { videoWidth: { get: () => 4000 }, videoHeight: { get: () => 1000 } });
    oldVideo.dispatchEvent(new Event("resize"));
    oldVideo.dispatchEvent(new Event("loadedmetadata"));
  });
  await settle(page);
  await expectContainedShares(page, "mixed source resize and stale events");
  for (const focused of [true, false]) {
    await page.evaluate(focused => {
      document.querySelector("#screen-grid").classList.toggle("is-focused", focused);
      window.recoveryLayoutTiles[1].classList.toggle("is-focused", focused);
    }, focused);
    for (const viewport of [viewports[1], viewports[2], viewports[5], viewports[6]]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await expectContainedShares(page, `${focused ? "focused" : "grid"} ${viewport.width}x${viewport.height}`);
    }
  }
  await page.setViewportSize(viewports[1]);
  await settle(page);
  await page.locator("#screen-grid > .tile").nth(1).locator(".tile-fullscreen-btn").click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await recover(page);
  const fullscreen = await page.locator("#screen-grid > .tile").nth(1).evaluate(tile => {
    const video = tile.querySelector("video"), box = video.getBoundingClientRect();
    return { fit: getComputedStyle(video).objectFit, contained: box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 };
  });
  expect(fullscreen).toEqual({ fit: "contain", contained: true });
  await page.evaluate(() => document.exitFullscreen());
  await settle(page);
  await expectContainedShares(page, "exit fullscreen after repeated recovery");
});
