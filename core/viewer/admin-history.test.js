const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_RANGE,
  PAGE_LIMIT,
  buildSessionsPath,
  emptyMessage,
  formatDateSeparator,
  formatStatus,
  loadJoins,
  mergeEvents,
  normalizeAvailableYears,
  normalizeRange,
  rangeLabel,
  summarizeJoins,
} = require("./admin-history.js");

test("normalizes rolling and calendar-year history ranges", () => {
  assert.equal(DEFAULT_RANGE, "month");
  assert.equal(normalizeRange("week"), "week");
  assert.equal(normalizeRange("YEAR:2025"), "year:2025");
  assert.equal(normalizeRange("year:1969"), "month");
  assert.equal(normalizeRange("not-a-range"), "month");
  assert.equal(rangeLabel("quarter"), "Last 90 days");
  assert.equal(rangeLabel("year:2024"), "2024");
});

test("builds the paged session-history request contract", () => {
  assert.equal(PAGE_LIMIT, 200);
  assert.equal(
    buildSessionsPath("month"),
    "/admin/api/sessions?range=month&limit=200",
  );
  assert.equal(
    buildSessionsPath("year:2025", "opaque+/= cursor"),
    "/admin/api/sessions?range=year%3A2025&limit=200&cursor=opaque%2B%2F%3D%20cursor",
  );
  assert.equal(
    buildSessionsPath("invalid", ""),
    "/admin/api/sessions?range=month&limit=200",
  );
  assert.equal(buildSessionsPath("all", "next", 1000), "/admin/api/sessions?range=all&limit=1000&cursor=next");
});

test("activity loads every page, counts reconnects and skips leaves and exact overlap", async () => {
  const recent = {event_type: "join", identity: "a-2", name: "Alex", timestamp: 1773700000};
  const earlier = {event_type: "join", identity: "a-1", name: "Alex", timestamp: 1750000000};
  const cursors = [];
  const joins = await loadJoins(async (cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? {events: [recent, {...recent, event_type: "leave"}], next_cursor: "older"}
      : {events: [recent, earlier, {...earlier, name: "__proto__", identity: "other"}], next_cursor: null};
  });
  assert.deepEqual(cursors, [null, "older"]);
  const activity = summarizeJoins(joins);
  assert.deepEqual(activity.users, [{name: "Alex", count: 2}, {name: "__proto__", count: 1}]);
  const date = new Date(earlier.timestamp * 1000);
  const olderDay = Object.keys(activity.byDay).sort()[0];
  assert.equal(activity.byDay[olderDay][date.getHours()].Alex, 1);
  assert.equal(activity.byDay[olderDay][date.getHours()].__proto__, 1);
});

test("activity stops when a history page repeats its cursor", async () => {
  await assert.rejects(loadJoins(async () => ({events: [], next_cursor: "same"})), /cursor did not advance/);
});

test("calendar-year options are unique, descending, and retain the selection", () => {
  assert.deepEqual(
    normalizeAvailableYears([2024, "2026", 2025, 2024, "bad"], "year:2023"),
    [2026, 2025, 2024, 2023],
  );
  assert.deepEqual(normalizeAvailableYears(null, "month"), []);
});

test("paged events merge newest-first and remove exact overlap only", () => {
  const newest = {
    event_type: "join",
    identity: "sam-1",
    name: "Sam",
    room_id: "main",
    timestamp: 300,
  };
  const overlap = {
    event_type: "leave",
    identity: "david-1",
    name: "David",
    room_id: "main",
    timestamp: 200,
    duration_secs: 90,
  };
  const sameSecondDifferentEvent = { ...overlap, duration_secs: 91 };
  const oldest = { ...newest, timestamp: 100 };

  const merged = mergeEvents(
    [overlap, newest],
    [{ ...overlap }, oldest, sameSecondDifferentEvent],
  );

  assert.deepEqual(merged, [newest, overlap, sameSecondDifferentEvent, oldest]);
  assert.equal(mergeEvents(merged, null).length, 4);
});

test("history labels always identify the year and selected range", () => {
  const separator = formatDateSeparator(Date.UTC(2024, 4, 3, 12) / 1000, "en-US");
  assert.match(separator, /2024/);
  assert.match(separator, /May/);
  assert.equal(formatDateSeparator("bad", "en-US"), "Unknown date");
  assert.equal(formatStatus(200, 432, "month"), "Showing 200 of 432 events \u00b7 Last 30 days");
  assert.equal(formatStatus(0, 0, "year:2023"), "No events \u00b7 2023");
  assert.equal(emptyMessage("week"), "No session history is available for the last 7 days.");
  assert.equal(emptyMessage("year:2022"), "No session history is available for 2022.");
  assert.equal(emptyMessage("all"), "No session history is available yet.");
});
