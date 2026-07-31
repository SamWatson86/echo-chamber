import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDirectory, "..", "fixtures", "install-scenario.js");
const runtimeErrors = new WeakMap();
const apiModels = new WeakMap();

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const monthOverlap = {
  event_type: "leave",
  identity: "david-1",
  name: "David",
  room_id: "main",
  timestamp: unix("2026-07-30T21:10:00Z"),
  duration_secs: 5400,
};

function historyPayload(range, cursor) {
  const available = {
    available_from: unix("2024-02-03T12:00:00Z"),
    available_to: unix("2026-07-31T14:00:00Z"),
    available_years: [2026, 2025, 2024],
  };

  if (range === "month" && !cursor) {
    return {
      ...available,
      events: [{
        event_type: "join",
        identity: "sam-1",
        name: '<img src=x onerror="window.__historyXss=1"> Sam',
        room_id: "<script>unsafe-room</script>",
        timestamp: unix("2026-07-31T14:00:00Z"),
      }, {
        event_type: "join",
        identity: "zane-1",
        name: "Zane",
        room_id: "game-room",
        timestamp: unix("2026-07-31T13:50:00Z"),
      }, monthOverlap],
      next_cursor: "month-page-2+/=",
      total_count: 4,
    };
  }
  if (range === "month" && cursor === "month-page-2+/=") {
    return {
      ...available,
      events: [{ ...monthOverlap }, {
        event_type: "join",
        identity: "spencer-1",
        name: "Spencer",
        room_id: "main",
        timestamp: unix("2026-07-29T16:30:00Z"),
      }],
      next_cursor: null,
      total_count: 4,
    };
  }

  const eventByRange = {
    week: {
      event_type: "join",
      identity: "week-1",
      name: "Week Friend",
      room_id: "main",
      timestamp: unix("2026-07-31T12:00:00Z"),
    },
    quarter: {
      event_type: "leave",
      identity: "quarter-1",
      name: "Quarter Friend",
      room_id: "main",
      timestamp: unix("2026-06-01T12:00:00Z"),
      duration_secs: 900,
    },
    all: {
      event_type: "join",
      identity: "all-1",
      name: "Old Friend",
      room_id: "archive",
      timestamp: unix("2024-02-03T12:00:00Z"),
    },
    "year:2025": {
      event_type: "leave",
      identity: "year-1",
      name: "Calendar Friend",
      room_id: "main",
      timestamp: unix("2025-10-05T12:00:00Z"),
      duration_secs: 3600,
    },
  };
  const event = eventByRange[range];
  return {
    ...available,
    events: event ? [event] : [],
    next_cursor: null,
    total_count: event ? 1 : 0,
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  const model = {
    historyRequests: [],
    quarterFailuresRemaining: 1,
    servedExpectedHistoryFailure: false,
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

    if (url.pathname === "/api/online") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
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
    if (url.pathname === "/admin/api/dashboard") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ rooms: [], total_online: 0, server_version: "history-test" }),
      });
      return;
    }
    if (url.pathname === "/admin/api/metrics/dashboard") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ summary: {}, per_user: [], heatmap_joins: [], timeline_events: [] }),
      });
      return;
    }
    if (url.pathname === "/admin/api/metrics") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ users: [] }),
      });
      return;
    }
    if (url.pathname === "/admin/api/bugs") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reports: [] }),
      });
      return;
    }
    if (url.pathname === "/admin/api/sessions") {
      const range = url.searchParams.get("range");
      const cursor = url.searchParams.get("cursor");
      model.historyRequests.push({
        cursor,
        limit: url.searchParams.get("limit"),
        range,
      });
      if (range === "quarter" && model.quarterFailuresRemaining > 0) {
        model.quarterFailuresRemaining -= 1;
        model.servedExpectedHistoryFailure = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary failure" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(historyPayload(range, cursor)),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
});

test.afterEach(async ({ page }) => {
  const model = apiModels.get(page);
  const errors = (runtimeErrors.get(page) || []).filter((message) => !(
    model.servedExpectedHistoryFailure && message.includes("status of 503")
  ));
  expect(errors, "Dashboard History must not emit unexpected runtime errors").toEqual([]);
});

async function openDashboardHistory(page) {
  await page.goto("/?echo-ui-shell-v2=1", { waitUntil: "domcontentloaded" });
  await page.addScriptTag({ path: fixturePath });
  await page.evaluate(() => window.EchoLayoutTestScenario.install({
    participants: 1,
    cameras: 0,
    screenShares: 0,
  }));
  await page.evaluate(() => {
    adminToken = "dashboard-history-token";
    currentAccessToken = "dashboard-history-participant-token";
    room = {
      localParticipant: {
        identity: "layout-fixture-1",
        name: "Fixture Host",
        publishData: async function() {},
      },
    };
    document.getElementById("open-admin-dash").classList.remove("hidden");
  });

  const more = page.getByRole("button", { name: "More clubhouse actions", exact: true });
  await expect(more).toHaveCount(1);
  await more.click();
  const dashboard = page.getByRole("button", { name: "Dashboard", exact: true });
  await expect(dashboard).toHaveCount(1);
  await dashboard.click();
  await expect(page.locator("#admin-dash-panel")).toBeVisible();

  const historyTab = page.locator("#admin-dash-panel").getByRole("button", {
    name: "History",
    exact: true,
  });
  await expect(historyTab).toHaveCount(1);
  await historyTab.click();
  await expect(page.locator("#admin-dash-history")).toBeVisible();
  await expect(page.locator("#admin-history-status")).toContainText("Last 30 days");
}

test("Dashboard History switches ranges and appends cursor pages without duplicate or unsafe markup", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openDashboardHistory(page);
  const model = apiModels.get(page);
  const range = page.getByLabel("Time range", { exact: true });
  await expect(range).toHaveCount(1);
  await expect(range).toHaveValue("month");
  expect(model.historyRequests[0]).toEqual({ cursor: null, limit: "200", range: "month" });

  await expect(range.locator('option[value="year:2026"]')).toHaveText("2026 (year to date)");
  await expect(range.locator('option[value="year:2025"]')).toHaveText("2025");
  await expect(range.locator('option[value="year:2024"]')).toHaveText("2024");
  const eventRows = page.locator("#admin-history-results tbody tr:not(.adm-date-sep)");
  await expect(eventRows).toHaveCount(3);
  await expect(page.locator("#admin-history-results")).toContainText('<img src=x onerror="window.__historyXss=1"> Sam');
  await expect(page.locator("#admin-history-results")).toContainText("<script>unsafe-room</script>");
  expect(await page.evaluate(() => ({
    injectedNodeCount: document.querySelectorAll("#admin-history-results img, #admin-history-results script").length,
    xssValue: window.__historyXss,
  }))).toEqual({ injectedNodeCount: 0, xssValue: undefined });
  const dateSeparators = page.locator(".adm-date-sep");
  await expect(dateSeparators).toHaveCount(2);
  await expect(dateSeparators).toContainText(["2026", "2026"]);

  const loadOlder = page.getByRole("button", { name: "Load older", exact: true });
  await expect(loadOlder).toHaveCount(1);
  await loadOlder.click();
  await expect(eventRows).toHaveCount(4);
  await expect(page.locator("#admin-history-status")).toHaveText("Showing 4 of 4 events · Last 30 days");
  await expect(loadOlder).toBeHidden();
  expect(model.historyRequests.some((request) => (
    request.range === "month" && request.cursor === "month-page-2+/=" && request.limit === "200"
  ))).toBe(true);

  await range.selectOption("week");
  await expect(page.locator("#admin-history-status")).toHaveText("Showing 1 of 1 events · Last 7 days");
  await range.selectOption("all");
  await expect(page.locator("#admin-history-status")).toHaveText("Showing 1 of 1 events · All history");
  await range.selectOption("year:2025");
  await expect(page.locator("#admin-history-status")).toHaveText("Showing 1 of 1 events · 2025");
  await expect(page.locator("#admin-history-results")).toContainText("Calendar Friend");
  expect(model.historyRequests.slice(-3).map(({ range: selected, cursor }) => ({ selected, cursor }))).toEqual([
    { selected: "week", cursor: null },
    { selected: "all", cursor: null },
    { selected: "year:2025", cursor: null },
  ]);

  const geometry = await page.evaluate(() => {
    const panel = document.getElementById("admin-dash-panel").getBoundingClientRect();
    const select = document.getElementById("admin-history-range").getBoundingClientRect();
    const tableWrap = document.querySelector(".adm-history-table-wrap").getBoundingClientRect();
    return {
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      panel: { left: panel.left, right: panel.right },
      select: { left: select.left, right: select.right },
      tableWrap: { left: tableWrap.left, right: tableWrap.right },
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
  expect(geometry.bodyOverflow).toBeLessThanOrEqual(1);
  expect(geometry.panel.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.select.left).toBeGreaterThanOrEqual(geometry.panel.left - 1);
  expect(geometry.select.right).toBeLessThanOrEqual(geometry.panel.right + 1);
  expect(geometry.tableWrap.left).toBeGreaterThanOrEqual(geometry.panel.left - 1);
  expect(geometry.tableWrap.right).toBeLessThanOrEqual(geometry.panel.right + 1);
});

test("Dashboard History reports a failed range request and Retry repeats that range", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await openDashboardHistory(page);
  const model = apiModels.get(page);
  const range = page.getByLabel("Time range", { exact: true });
  await range.selectOption("quarter");

  const error = page.locator("#admin-history-error");
  await expect(error).toBeVisible();
  await expect(error).toContainText("History request failed (503)");
  await expect(page.locator("#admin-history-status")).toHaveText("History unavailable · Last 90 days");

  const retry = error.getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toHaveCount(1);
  await retry.click();
  await expect(error).toBeHidden();
  await expect(page.locator("#admin-history-status")).toHaveText("Showing 1 of 1 events · Last 90 days");
  await expect(page.locator("#admin-history-results")).toContainText("Quarter Friend");
  expect(model.historyRequests.filter((request) => request.range === "quarter")).toEqual([
    { cursor: null, limit: "200", range: "quarter" },
    { cursor: null, limit: "200", range: "quarter" },
  ]);
});
