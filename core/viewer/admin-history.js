(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.EchoAdminHistory = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_RANGE = "month";
  var PAGE_LIMIT = 200;
  var RANGE_LABELS = {
    week: "Last 7 days",
    month: "Last 30 days",
    quarter: "Last 90 days",
    year: "Last 365 days",
    all: "All history",
  };

  function normalizeRange(value) {
    var range = String(value || "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(RANGE_LABELS, range)) return range;
    var yearMatch = /^year:(\d{4})$/.exec(range);
    if (yearMatch) {
      var year = Number(yearMatch[1]);
      if (year >= 1970 && year <= 9999) return "year:" + year;
    }
    return DEFAULT_RANGE;
  }

  function rangeLabel(value) {
    var range = normalizeRange(value);
    if (range.indexOf("year:") === 0) return range.slice(5);
    return RANGE_LABELS[range];
  }

  function buildSessionsPath(range, cursor) {
    var path = "/admin/api/sessions?range=" + encodeURIComponent(normalizeRange(range)) +
      "&limit=" + PAGE_LIMIT;
    if (cursor !== null && cursor !== undefined && String(cursor) !== "") {
      path += "&cursor=" + encodeURIComponent(String(cursor));
    }
    return path;
  }

  function normalizeAvailableYears(values, selectedRange) {
    var seen = Object.create(null);
    var years = [];
    (Array.isArray(values) ? values : []).forEach(function (value) {
      var year = Number(value);
      if (!Number.isInteger(year) || year < 1970 || year > 9999 || seen[year]) return;
      seen[year] = true;
      years.push(year);
    });

    var normalizedRange = normalizeRange(selectedRange);
    if (normalizedRange.indexOf("year:") === 0) {
      var selectedYear = Number(normalizedRange.slice(5));
      if (!seen[selectedYear]) years.push(selectedYear);
    }

    return years.sort(function (a, b) { return b - a; });
  }

  function eventKey(event) {
    var item = event && typeof event === "object" ? event : {};
    return JSON.stringify([
      item.event_type == null ? "" : item.event_type,
      item.identity == null ? "" : item.identity,
      item.name == null ? "" : item.name,
      item.room_id == null ? "" : item.room_id,
      item.timestamp == null ? null : item.timestamp,
      item.duration_secs == null ? null : item.duration_secs,
    ]);
  }

  function mergeEvents(existing, incoming) {
    var merged = [];
    var seen = Object.create(null);
    var source = (Array.isArray(existing) ? existing : []).concat(
      Array.isArray(incoming) ? incoming : [],
    );

    source.forEach(function (event) {
      if (!event || typeof event !== "object") return;
      var key = eventKey(event);
      if (seen[key]) return;
      seen[key] = true;
      merged.push(event);
    });

    return merged.sort(function (a, b) {
      var aTimestamp = Number(a.timestamp) || 0;
      var bTimestamp = Number(b.timestamp) || 0;
      return bTimestamp - aTimestamp;
    });
  }

  function formatDateSeparator(timestamp, locales) {
    var date = new Date(Number(timestamp) * 1000);
    if (!Number.isFinite(date.getTime())) return "Unknown date";
    return date.toLocaleDateString(locales || [], {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatStatus(loadedCount, totalCount, range) {
    var loaded = Math.max(0, Number(loadedCount) || 0);
    var total = Number(totalCount);
    var suffix = " \u00b7 " + rangeLabel(range);
    if (loaded === 0) return "No events" + suffix;
    if (Number.isFinite(total) && total >= loaded) {
      return "Showing " + loaded + " of " + total + " events" + suffix;
    }
    return "Showing " + loaded + " events" + suffix;
  }

  function emptyMessage(range) {
    var normalizedRange = normalizeRange(range);
    if (normalizedRange === "all") return "No session history is available yet.";
    if (normalizedRange.indexOf("year:") === 0) {
      return "No session history is available for " + rangeLabel(normalizedRange) + ".";
    }
    return "No session history is available for the " + rangeLabel(normalizedRange).toLowerCase() + ".";
  }

  return {
    DEFAULT_RANGE: DEFAULT_RANGE,
    PAGE_LIMIT: PAGE_LIMIT,
    buildSessionsPath: buildSessionsPath,
    emptyMessage: emptyMessage,
    eventKey: eventKey,
    formatDateSeparator: formatDateSeparator,
    formatStatus: formatStatus,
    mergeEvents: mergeEvents,
    normalizeAvailableYears: normalizeAvailableYears,
    normalizeRange: normalizeRange,
    rangeLabel: rangeLabel,
  };
});
