# Admin Dashboard v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand the admin dashboard with unique user colors, resizable panel, interactive leaderboard/heatmap, bug charts, and comprehensive quality metrics.

**Architecture:** All changes are in three files: `app.js` (frontend rendering), `style.css` (styling), `main.rs` (Rust API). The Rust endpoint `/admin/api/metrics/dashboard` is extended with per-user heatmap data and richer quality stats. The frontend gets interactive behaviors (click filtering, drag resize) and new chart sections.

**Tech Stack:** Vanilla JS, CSS3, Rust/axum. No external libraries.

---

### Task 1: Expand Color Palette to 30 Colors

**Files:**
- Modify: `core/viewer/app.js:10497-10501` (color palette + hash function)

**Step 1: Replace the color palette and hash function**

Replace lines 10497-10501 in app.js with:

```javascript
var _admUserColors = [
  "#e8922f","#3b9dda","#49b86d","#c75dba","#d65757","#c9b83e","#6ec4c4","#8b7dd6",
  "#e06080","#40c090","#d4a030","#5c8de0","#c0604c","#50d0b0","#a070e0","#d09050",
  "#60b858","#9060c0","#e07898","#44b8c8","#b8a040","#7088d8","#c87858","#48c868",
  "#b860a8","#e0a870","#58a0d0","#a0c048","#d870a0","#60d0a0"
];
function _admUserColor(name) {
  var hash = 5381;
  for (var i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  return _admUserColors[hash % _admUserColors.length];
}
```

Key changes:
- 30 visually distinct colors (up from 8)
- Parameter renamed from `identity` to `name` — hashes on display name for cross-session consistency
- Uses djb2 hash (better distribution than old shift-subtract)
- `>>> 0` ensures unsigned (no negative modulo issues)

**Step 2: Update all callers to pass `name` instead of `identity`**

In `renderAdminDashboard()`, the leaderboard section (~line 10538) currently calls `_admUserColor(u.identity)`. Change to `_admUserColor(u.name)`.

In the timeline section (~line 10620), change `_admUserColor(uname)` — this already uses the display name, so no change needed there.

**Step 3: Commit**

```
feat: expand admin color palette to 30 unique colors
```

---

### Task 2: Resizable Admin Panel

**Files:**
- Modify: `core/viewer/style.css:4036-4050` (panel styles)
- Modify: `core/viewer/app.js:10372-10394` (toggleAdminDash)

**Step 1: Add CSS for resize handle**

After the `.admin-dash-panel` rule (line 4050), add:

```css
.admin-dash-resize-handle {
  position: absolute;
  top: 0;
  left: -4px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  z-index: 41;
}
.admin-dash-resize-handle::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 3px;
  width: 2px;
  height: 40px;
  transform: translateY(-50%);
  background: rgba(255,255,255,0.15);
  border-radius: 1px;
  transition: background 0.15s;
}
.admin-dash-resize-handle:hover::after,
.admin-dash-resize-handle:active::after {
  background: rgba(245,158,11,0.6);
}
```

Also change `.admin-dash-panel` width from `420px` to use a CSS variable:

```css
.admin-dash-panel {
  /* change width: 420px to: */
  width: var(--admin-panel-width, 420px);
  min-width: 400px;
  max-width: 80vw;
}
```

**Step 2: Add drag resize JavaScript**

Add after `toggleAdminDash()` function (after line 10394):

```javascript
(function initAdminResize() {
  var panel = document.getElementById("admin-dash-panel");
  if (!panel) return;
  var handle = document.createElement("div");
  handle.className = "admin-dash-resize-handle";
  panel.appendChild(handle);

  var saved = localStorage.getItem("admin-panel-width");
  if (saved) panel.style.setProperty("--admin-panel-width", saved + "px");

  var dragging = false;
  handle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });
  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var w = window.innerWidth - e.clientX;
    if (w < 400) w = 400;
    if (w > window.innerWidth * 0.8) w = window.innerWidth * 0.8;
    panel.style.setProperty("--admin-panel-width", w + "px");
  });
  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    var current = panel.style.getPropertyValue("--admin-panel-width");
    if (current) localStorage.setItem("admin-panel-width", parseInt(current));
  });
})();
```

**Step 3: Commit**

```
feat: add resizable admin panel with drag handle
```

---

### Task 3: Rust — Expand Heatmap Data & StatsSnapshot

**Files:**
- Modify: `core/control/src/main.rs:119-126` (StatsSnapshot struct)
- Modify: `core/control/src/main.rs:1622-1627` (DashboardMetricsResponse)
- Modify: `core/control/src/main.rs:1605-1614` (UserMetrics struct)
- Modify: `core/control/src/main.rs:1799-1806` (snapshot creation)
- Modify: `core/control/src/main.rs:1687-1786` (admin_dashboard_metrics handler)
- Modify: `core/control/src/main.rs:1825-1897` (admin_metrics handler)

**Step 1: Add HeatmapJoin struct and expand StatsSnapshot**

Add `HeatmapJoin` struct near the other dashboard structs (~line 1645):
```rust
#[derive(Clone, Serialize)]
struct HeatmapJoin {
    timestamp: u64,
    name: String,
}
```

Expand `StatsSnapshot` (line 119) to capture encoder and ICE data:
```rust
#[derive(Clone, Serialize, Deserialize)]
struct StatsSnapshot {
    identity: String,
    name: String,
    timestamp: u64,
    screen_fps: Option<f64>,
    screen_bitrate_kbps: Option<u32>,
    quality_limitation: Option<String>,
    encoder: Option<String>,
    ice_local_type: Option<String>,
    ice_remote_type: Option<String>,
}
```

**Step 2: Update snapshot creation in admin_report_stats**

At line 1799, add the new fields:
```rust
let snapshot = StatsSnapshot {
    identity: entry.identity.clone(),
    name: entry.name.clone(),
    timestamp: entry.updated_at,
    screen_fps: entry.screen_fps,
    screen_bitrate_kbps: entry.screen_bitrate_kbps,
    quality_limitation: entry.quality_limitation.clone(),
    encoder: entry.encoder.clone(),
    ice_local_type: entry.ice_local_type.clone(),
    ice_remote_type: entry.ice_remote_type.clone(),
};
```

**Step 3: Change DashboardMetricsResponse to use HeatmapJoin**

```rust
struct DashboardMetricsResponse {
    summary: DashboardSummary,
    per_user: Vec<UserSessionStats>,
    heatmap_joins: Vec<HeatmapJoin>,  // was Vec<u64>
    timeline_events: Vec<TimelineEvent>,
}
```

**Step 4: Update admin_dashboard_metrics handler**

Where join events are pushed to `heatmap_joins`, change from pushing just the timestamp to pushing `HeatmapJoin { timestamp, name }`:

Find the line where `heatmap_joins.push(ev.timestamp)` (or similar) and change to:
```rust
heatmap_joins.push(HeatmapJoin {
    timestamp: ev.timestamp,
    name: ev.name.clone(),
});
```

**Step 5: Expand UserMetrics with encoder and ICE fields**

```rust
struct UserMetrics {
    identity: String,
    name: String,
    sample_count: usize,
    avg_fps: f64,
    avg_bitrate_kbps: f64,
    pct_bandwidth_limited: f64,
    pct_cpu_limited: f64,
    total_minutes: f64,
    encoder: Option<String>,
    ice_local_type: Option<String>,
    ice_remote_type: Option<String>,
}
```

**Step 6: Aggregate encoder/ICE in admin_metrics handler**

In the per-identity grouping loop (~line 1841), add most-common encoder and ICE type calculation:

```rust
// Most common encoder
let mut enc_counts: HashMap<String, usize> = HashMap::new();
for s in snaps.iter() {
    if let Some(ref e) = s.encoder {
        *enc_counts.entry(e.clone()).or_default() += 1;
    }
}
let encoder = enc_counts.into_iter().max_by_key(|(_,c)| *c).map(|(e,_)| e);

// Most common ICE types
let mut ice_local_counts: HashMap<String, usize> = HashMap::new();
let mut ice_remote_counts: HashMap<String, usize> = HashMap::new();
for s in snaps.iter() {
    if let Some(ref t) = s.ice_local_type {
        *ice_local_counts.entry(t.clone()).or_default() += 1;
    }
    if let Some(ref t) = s.ice_remote_type {
        *ice_remote_counts.entry(t.clone()).or_default() += 1;
    }
}
let ice_local_type = ice_local_counts.into_iter().max_by_key(|(_,c)| *c).map(|(t,_)| t);
let ice_remote_type = ice_remote_counts.into_iter().max_by_key(|(_,c)| *c).map(|(t,_)| t);
```

Then include in the `UserMetrics` push:
```rust
users.push(UserMetrics {
    // ...existing fields...
    encoder,
    ice_local_type,
    ice_remote_type,
});
```

**Step 7: Commit**

```
feat: expand Rust stats with encoder/ICE data and per-user heatmap joins
```

---

### Task 4: Interactive Leaderboard → Heatmap Filtering

**Files:**
- Modify: `core/viewer/app.js:10532-10582` (leaderboard + heatmap rendering in renderAdminDashboard)

**Step 1: Add click handler to leaderboard bars**

In the leaderboard rendering loop, make each bar clickable. Add a module-level variable to track the selected user:

```javascript
var _admSelectedUser = null;
```

Each leaderboard bar gets an `onclick` that sets `_admSelectedUser` and re-renders the heatmap:

```javascript
// In the leaderboard bar HTML:
'<div class="adm-leaderboard-bar' + (_admSelectedUser === u.name ? ' adm-lb-selected' : '') + '" onclick="_admSelectUser(\'' + escAdm(u.name).replace(/'/g, "\\'") + '\')">'
```

Add the handler function:
```javascript
function _admSelectUser(name) {
  _admSelectedUser = (_admSelectedUser === name) ? null : name;
  renderAdminDashboard();
}
```

**Step 2: Update heatmap rendering to support per-user filtering**

The heatmap data now has `{ timestamp, name }` objects instead of plain timestamps. Update the grouping:

```javascript
var heatJoins = d.heatmap_joins || [];
if (heatJoins.length > 0) {
  // Build heatmap with per-user data
  var heatmap = {};       // dateKey -> hour -> count
  var heatmapUsers = {};  // dateKey -> hour -> { name: count }
  heatJoins.forEach(function(j) {
    var dt = new Date(j.timestamp * 1000);
    var dateKey = dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
    var hour = dt.getHours();
    if (!heatmap[dateKey]) { heatmap[dateKey] = {}; heatmapUsers[dateKey] = {}; }
    if (!heatmapUsers[dateKey][hour]) heatmapUsers[dateKey][hour] = {};
    var name = j.name || "Unknown";
    heatmapUsers[dateKey][hour][name] = (heatmapUsers[dateKey][hour][name] || 0) + 1;

    // Count: either all or filtered
    if (!_admSelectedUser || name === _admSelectedUser) {
      heatmap[dateKey][hour] = (heatmap[dateKey][hour] || 0) + 1;
    }
  });
  // ... render grid as before, but cells use filtered counts
  // ... if _admSelectedUser, color cells with user's color instead of orange
}
```

Store `heatmapUsers` at module scope so cell click popups can access it:
```javascript
var _admHeatmapUsers = {};
```

**Step 3: Add selected leaderboard bar CSS**

```css
.adm-leaderboard-bar { cursor: pointer; transition: opacity 0.15s; }
.adm-leaderboard-bar:hover { opacity: 0.85; }
.adm-lb-selected { outline: 2px solid #f59e0b; outline-offset: 2px; border-radius: 4px; }
```

**Step 4: Add "Show All" button when a user is selected**

When `_admSelectedUser` is set, show a small button above the heatmap:
```javascript
if (_admSelectedUser) {
  html += '<div style="margin-bottom:8px;"><button class="adm-show-all-btn" onclick="_admSelectUser(null)">Show All</button> Filtered: <strong>' + escAdm(_admSelectedUser) + '</strong></div>';
}
```

```css
.adm-show-all-btn {
  background: rgba(245,158,11,0.15);
  border: 1px solid rgba(245,158,11,0.4);
  color: #f59e0b;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
.adm-show-all-btn:hover { background: rgba(245,158,11,0.25); }
```

**Step 5: Commit**

```
feat: interactive leaderboard click filters heatmap by user
```

---

### Task 5: Clickable Heatmap Cells → User Popup

**Files:**
- Modify: `core/viewer/app.js` (heatmap cell click handler)
- Modify: `core/viewer/style.css` (popup styles)

**Step 1: Make each heatmap cell clickable**

Add `data-day` and `data-hour` attributes to each cell, plus an onclick:

```javascript
'<div class="adm-heatmap-cell" data-day="' + dk + '" data-hour="' + hr + '" onclick="_admHeatCellClick(event, \'' + dk + '\',' + hr + ')" ...'
```

**Step 2: Add popup handler**

```javascript
function _admHeatCellClick(e, dateKey, hour) {
  // Remove existing popup
  var old = document.getElementById("adm-heat-popup");
  if (old) old.remove();

  var users = (_admHeatmapUsers[dateKey] && _admHeatmapUsers[dateKey][hour]) || {};
  var names = Object.keys(users);
  if (names.length === 0) return;

  names.sort(function(a, b) { return users[b] - users[a]; });

  var dt = new Date(dateKey + "T00:00:00");
  var dayLabel = dt.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  var hourLabel = (hour % 12 || 12) + (hour < 12 ? "a" : "p");

  var html = '<div class="adm-heat-popup-title">' + dayLabel + ' ' + hourLabel + '</div>';
  names.forEach(function(n) {
    html += '<div class="adm-heat-popup-row"><span class="adm-heat-popup-dot" style="background:' + _admUserColor(n) + '"></span>' + escAdm(n) + '<span class="adm-heat-popup-count">' + users[n] + '</span></div>';
  });

  var popup = document.createElement("div");
  popup.id = "adm-heat-popup";
  popup.className = "adm-heat-popup";
  popup.innerHTML = html;
  document.body.appendChild(popup);

  // Position near the clicked cell
  var rect = e.target.getBoundingClientRect();
  popup.style.top = (rect.bottom + 4) + "px";
  popup.style.left = Math.min(rect.left, window.innerWidth - 200) + "px";

  // Close on click outside
  setTimeout(function() {
    document.addEventListener("click", function dismiss(ev) {
      if (!popup.contains(ev.target)) {
        popup.remove();
        document.removeEventListener("click", dismiss);
      }
    });
  }, 0);
}
```

**Step 3: Add popup CSS**

```css
.adm-heat-popup {
  position: fixed;
  z-index: 50;
  background: rgba(15, 20, 35, 0.97);
  border: 1px solid rgba(245,158,11,0.3);
  border-radius: 8px;
  padding: 10px 14px;
  min-width: 140px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  backdrop-filter: blur(12px);
}
.adm-heat-popup-title { font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 6px; }
.adm-heat-popup-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 0; }
.adm-heat-popup-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.adm-heat-popup-count { margin-left: auto; color: rgba(255,255,255,0.5); font-size: 11px; }
```

**Step 4: Commit**

```
feat: clickable heatmap cells show per-user popup
```

---

### Task 6: Fix Bug Reports Display

**Files:**
- Modify: `core/viewer/app.js:10668-10688` (fetchAdminBugs)

**Step 1: Debug the bug reports fetch**

Read the current `fetchAdminBugs()` function carefully. The bug is likely that the HTML is built but never assigned to the element's innerHTML. Check for a missing `el.innerHTML = html` at the end.

Expected fix — the function builds `html` string but may not set it on the DOM element. Ensure:

```javascript
async function fetchAdminBugs() {
  try {
    var res = await fetch(apiUrl("/admin/api/bugs"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    var data = await res.json();
    var el = document.getElementById("admin-dash-bugs");
    if (!el) return;
    var reports = data.reports || [];
    if (reports.length === 0) {
      el.innerHTML = '<div class="adm-empty">No bug reports</div>';
      return;
    }
    var html = "";
    reports.forEach(function(r) {
      html += '<div class="adm-bug"><div class="adm-bug-header"><strong>' +
        escAdm(r.name || r.reporter || r.identity) + '</strong>' +
        '<span class="adm-time">' + fmtTime(r.timestamp) + '</span></div>' +
        '<div class="adm-bug-desc">' + escAdm(r.description) + '</div></div>';
    });
    el.innerHTML = html;  // THIS LINE MAY BE MISSING
  } catch (e) {}
}
```

**Step 2: Commit**

```
fix: bug reports not rendering - add missing innerHTML assignment
```

---

### Task 7: Bug Summary Charts on Metrics Tab

**Files:**
- Modify: `core/viewer/app.js` (renderAdminDashboard, add bug chart sections)
- Modify: `core/viewer/style.css` (bug chart styles)

**Step 1: Fetch bug data in the metrics dashboard**

In `fetchAdminDashboardMetrics()`, also fetch bugs and store for rendering:

```javascript
var _admBugData = null;

async function fetchAdminDashboardMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics/dashboard"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    _admDashData = await res.json();

    // Also fetch bug data for charts
    var bugRes = await fetch(apiUrl("/admin/api/bugs"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (bugRes.ok) _admBugData = await bugRes.json();

    renderAdminDashboard();
  } catch (e) {}
}
```

**Step 2: Add Bugs by User chart in renderAdminDashboard**

After the timeline section, add:

```javascript
// ── Bug Reports Summary ──
var bugs = (_admBugData && _admBugData.reports) || [];
if (bugs.length > 0) {
  // Bugs by User
  var bugsByUser = {};
  bugs.forEach(function(b) {
    var name = b.name || b.reporter || b.identity || "Unknown";
    bugsByUser[name] = (bugsByUser[name] || 0) + 1;
  });
  var bugUserArr = Object.keys(bugsByUser).map(function(n) {
    return { name: n, count: bugsByUser[n] };
  }).sort(function(a,b) { return b.count - a.count; });
  var bugMax = bugUserArr[0].count;

  html += '<div class="adm-section"><div class="adm-section-title">BUG REPORTS BY USER</div>';
  bugUserArr.forEach(function(u) {
    var pct = (u.count / bugMax) * 100;
    html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(u.name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(u.name) + '"></div><div class="adm-leaderboard-count">' + u.count + '</div></div>';
  });
  html += '</div>';

  // Bugs by Day
  var bugsByDay = {};
  bugs.forEach(function(b) {
    var dt = new Date(b.timestamp * 1000);
    var dk = dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0");
    bugsByDay[dk] = (bugsByDay[dk] || 0) + 1;
  });
  var bugDays = Object.keys(bugsByDay).sort();
  var bugDayMax = Math.max.apply(null, bugDays.map(function(d) { return bugsByDay[d]; }));

  html += '<div class="adm-section"><div class="adm-section-title">BUGS BY DAY</div>';
  html += '<div class="adm-bugs-by-day">';
  bugDays.forEach(function(dk) {
    var count = bugsByDay[dk];
    var pct = (count / bugDayMax) * 100;
    var dt = new Date(dk + "T12:00:00");
    var label = dt.toLocaleDateString([], { month: "short", day: "numeric" });
    html += '<div class="adm-bug-day-col"><div class="adm-bug-day-bar" style="height:' + pct + '%" title="' + label + ': ' + count + ' bugs"></div><div class="adm-bug-day-label">' + label + '</div><div class="adm-bug-day-count">' + count + '</div></div>';
  });
  html += '</div></div>';
}
```

**Step 3: Add CSS for bugs by day chart**

```css
.adm-bugs-by-day {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 120px;
  padding-top: 10px;
}
.adm-bug-day-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 24px;
}
.adm-bug-day-bar {
  width: 100%;
  max-width: 30px;
  background: linear-gradient(180deg, #e8922f, #d65757);
  border-radius: 3px 3px 0 0;
  min-height: 2px;
}
.adm-bug-day-label {
  font-size: 9px;
  color: rgba(255,255,255,0.4);
  margin-top: 4px;
  white-space: nowrap;
}
.adm-bug-day-count {
  font-size: 10px;
  color: rgba(255,255,255,0.6);
}
```

**Step 4: Commit**

```
feat: add bug summary charts (by user + by day) to metrics tab
```

---

### Task 8: Quality Summary Cards

**Files:**
- Modify: `core/viewer/app.js` (renderAdminDashboard — add quality cards section)
- Modify: `core/viewer/style.css` (quality card styles if needed)

**Step 1: Fetch quality data in dashboard renderer**

In `toggleAdminDash()`, `fetchAdminMetrics` is already called. Store its data at module scope:

```javascript
var _admQualityData = null;
```

Update `fetchAdminMetrics` to store data and trigger a quality render:

```javascript
async function fetchAdminMetrics() {
  try {
    var res = await fetch(apiUrl("/admin/api/metrics"), {
      headers: { "Authorization": "Bearer " + adminToken }
    });
    if (!res.ok) return;
    _admQualityData = await res.json();
    renderAdminQuality();
  } catch (e) {}
}
```

**Step 2: Add renderAdminQuality function**

This renders into a `<div id="admin-dash-metrics-quality">` at the bottom of the metrics content:

```javascript
function renderAdminQuality() {
  var container = document.getElementById("admin-dash-metrics-quality");
  if (!container || !_admQualityData) return;
  var users = _admQualityData.users || [];
  if (users.length === 0) {
    container.innerHTML = '<div class="adm-empty">No quality data yet</div>';
    return;
  }

  var html = '';

  // ── Quality Summary Cards ──
  var totalFps = 0, totalBitrate = 0, totalBw = 0, totalCpu = 0, n = users.length;
  users.forEach(function(u) {
    totalFps += u.avg_fps;
    totalBitrate += u.avg_bitrate_kbps;
    totalBw += u.pct_bandwidth_limited;
    totalCpu += u.pct_cpu_limited;
  });
  html += '<div class="adm-section"><div class="adm-section-title">STREAM QUALITY OVERVIEW</div>';
  html += '<div class="adm-cards">';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalFps / n).toFixed(1) + '</div><div class="adm-card-label">AVG FPS</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBitrate / n / 1000).toFixed(1) + '</div><div class="adm-card-label">AVG MBPS</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalBw / n).toFixed(1) + '%</div><div class="adm-card-label">BW LIMITED</div></div>';
  html += '<div class="adm-card"><div class="adm-card-value">' + (totalCpu / n).toFixed(1) + '%</div><div class="adm-card-label">CPU LIMITED</div></div>';
  html += '</div></div>';

  // ── Quality Score Ranking ──
  var scored = users.map(function(u) {
    var fpsNorm = Math.min(u.avg_fps / 60, 1);
    var brNorm = Math.min(u.avg_bitrate_kbps / 15000, 1);
    var cleanPct = 1 - (u.pct_bandwidth_limited + u.pct_cpu_limited) / 100;
    if (cleanPct < 0) cleanPct = 0;
    var score = Math.round(fpsNorm * 40 + brNorm * 30 + cleanPct * 30);
    return { name: u.name || u.identity, score: score, u: u };
  }).sort(function(a,b) { return b.score - a.score; });

  html += '<div class="adm-section"><div class="adm-section-title">QUALITY SCORE RANKING</div>';
  scored.forEach(function(s, i) {
    var badgeClass = s.score >= 80 ? 'adm-score-good' : (s.score >= 50 ? 'adm-score-ok' : 'adm-score-bad');
    html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(s.name) + '</div><div class="adm-leaderboard-fill" style="width:' + s.score + '%;background:' + _admUserColor(s.name) + '"></div><div class="adm-score-badge ' + badgeClass + '">' + s.score + '</div></div>';
  });
  html += '</div>';

  // ── Per-User FPS & Bitrate Bars ──
  var maxFps = Math.max.apply(null, users.map(function(u) { return u.avg_fps; }));
  var maxBr = Math.max.apply(null, users.map(function(u) { return u.avg_bitrate_kbps; }));

  html += '<div class="adm-section"><div class="adm-section-title">PER-USER QUALITY</div>';
  html += '<div class="adm-quality-dual">';
  // FPS column
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg FPS</div>';
  users.slice().sort(function(a,b) { return b.avg_fps - a.avg_fps; }).forEach(function(u) {
    var pct = maxFps > 0 ? (u.avg_fps / maxFps) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + u.avg_fps.toFixed(1) + '</div></div>';
  });
  html += '</div>';
  // Bitrate column
  html += '<div class="adm-quality-col"><div class="adm-quality-col-title">Avg Bitrate (Mbps)</div>';
  users.slice().sort(function(a,b) { return b.avg_bitrate_kbps - a.avg_bitrate_kbps; }).forEach(function(u) {
    var pct = maxBr > 0 ? (u.avg_bitrate_kbps / maxBr) * 100 : 0;
    var name = u.name || u.identity;
    html += '<div class="adm-leaderboard-bar"><div class="adm-leaderboard-name">' + escAdm(name) + '</div><div class="adm-leaderboard-fill" style="width:' + pct + '%;background:' + _admUserColor(name) + '"></div><div class="adm-leaderboard-count">' + (u.avg_bitrate_kbps / 1000).toFixed(1) + '</div></div>';
  });
  html += '</div></div></div>';

  // ── Quality Limitation Breakdown ──
  html += '<div class="adm-section"><div class="adm-section-title">QUALITY LIMITATIONS</div>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var clean = Math.max(0, 100 - u.pct_bandwidth_limited - u.pct_cpu_limited);
    html += '<div class="adm-limit-row"><div class="adm-leaderboard-name">' + escAdm(name) + '</div>';
    html += '<div class="adm-limit-bar">';
    if (clean > 0) html += '<div class="adm-limit-seg adm-limit-clean" style="width:' + clean + '%" title="Clean: ' + clean.toFixed(1) + '%"></div>';
    if (u.pct_cpu_limited > 0) html += '<div class="adm-limit-seg adm-limit-cpu" style="width:' + u.pct_cpu_limited + '%" title="CPU: ' + u.pct_cpu_limited.toFixed(1) + '%"></div>';
    if (u.pct_bandwidth_limited > 0) html += '<div class="adm-limit-seg adm-limit-bw" style="width:' + u.pct_bandwidth_limited + '%" title="BW: ' + u.pct_bandwidth_limited.toFixed(1) + '%"></div>';
    html += '</div></div>';
  });
  html += '</div>';

  // ── Encoder & ICE Connection ──
  html += '<div class="adm-section"><div class="adm-section-title">ENCODER & CONNECTION</div>';
  html += '<table class="adm-table"><thead><tr><th>User</th><th>Encoder</th><th>Local ICE</th><th>Remote ICE</th><th>Samples</th><th>Time</th></tr></thead><tbody>';
  users.forEach(function(u) {
    var name = u.name || u.identity;
    var enc = u.encoder || "—";
    var iceL = u.ice_local_type || "—";
    var iceR = u.ice_remote_type || "—";
    var iceClass = iceR === "relay" ? "adm-ice-relay" : (iceL === "host" ? "adm-ice-host" : "adm-ice-srflx");
    html += '<tr><td><span class="adm-heat-popup-dot" style="background:' + _admUserColor(name) + ';display:inline-block;vertical-align:middle;margin-right:4px"></span>' + escAdm(name) + '</td>';
    html += '<td><span class="adm-enc-badge">' + escAdm(enc) + '</span></td>';
    html += '<td>' + escAdm(iceL) + '</td>';
    html += '<td><span class="' + iceClass + '">' + escAdm(iceR) + '</span></td>';
    html += '<td>' + u.sample_count + '</td>';
    html += '<td>' + u.total_minutes.toFixed(1) + 'm</td></tr>';
  });
  html += '</tbody></table></div>';

  container.innerHTML = html;
}
```

**Step 3: Add a placeholder div in renderAdminDashboard**

At the end of `renderAdminDashboard()`, after the timeline, append:
```javascript
html += '<div id="admin-dash-metrics-quality"></div>';
```

**Step 4: Add quality-specific CSS**

```css
.adm-quality-dual { display: flex; gap: 16px; }
.adm-quality-col { flex: 1; }
.adm-quality-col-title { font-size: 11px; color: rgba(255,255,255,0.5); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }

.adm-score-badge { font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 10px; min-width: 32px; text-align: center; }
.adm-score-good { background: rgba(73,184,109,0.2); color: #49b86d; }
.adm-score-ok { background: rgba(201,184,62,0.2); color: #c9b83e; }
.adm-score-bad { background: rgba(214,87,87,0.2); color: #d65757; }

.adm-limit-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.adm-limit-bar { flex: 1; height: 16px; display: flex; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,0.05); }
.adm-limit-seg { height: 100%; transition: width 0.3s; }
.adm-limit-clean { background: rgba(73,184,109,0.6); }
.adm-limit-cpu { background: rgba(201,184,62,0.7); }
.adm-limit-bw { background: rgba(214,87,87,0.7); }

.adm-enc-badge { background: rgba(255,255,255,0.08); padding: 2px 6px; border-radius: 3px; font-size: 11px; font-family: monospace; }
.adm-ice-host { color: #49b86d; }
.adm-ice-srflx { color: #3b9dda; }
.adm-ice-relay { color: #e8922f; }
```

**Step 5: Commit**

```
feat: add quality dashboard with scores, limitations, encoder/ICE info
```

---

### Task 9: Build and Deploy

**Files:**
- Build: `cargo build -p echo-core-control` in worktree `core/`
- Copy: binary + `app.js` + `style.css` to main repo
- Restart: kill server (elevated), run `run-core.ps1`, restart SAM-PC client

**Step 1: Build Rust**

```powershell
cd "F:/Codex AI/The Echo Chamber/.claude/worktrees/vigilant-wilson/core"
cargo build -p echo-core-control
```

**Step 2: Kill server (elevated)**

```powershell
Start-Process -FilePath 'taskkill' -ArgumentList '/F', '/IM', 'echo-core-control.exe' -Verb RunAs -Wait
```

**Step 3: Copy files to main repo**

```powershell
Copy-Item 'worktree\core\target\debug\echo-core-control.exe' 'main\core\target\debug\echo-core-control.exe' -Force
Copy-Item 'worktree\core\viewer\app.js' 'main\core\viewer\app.js' -Force
Copy-Item 'worktree\core\viewer\style.css' 'main\core\viewer\style.css' -Force
```

**Step 4: Start server (elevated)**

```powershell
Start-Process powershell -ArgumentList '-ExecutionPolicy', 'Bypass', '-File', 'F:\Codex AI\The Echo Chamber\core\run-core.ps1' -Verb RunAs
```

**Step 5: Health check**

Verify `https://127.0.0.1:9443/health` returns `{"ok":true}`.

**Step 6: Restart SAM-PC**

```powershell
Invoke-WebRequest -Uri 'http://192.168.5.149:8080/restart' -Method POST -UseBasicParsing
```

**Step 7: Commit**

```
feat: admin dashboard v2 - colors, resize, interactivity, quality metrics
```

---

### Task 10: Visual Verification

**Step 1: Open admin panel and verify each section**

- Leaderboard: all users have unique colors
- Click a user: heatmap filters
- Click a heatmap cell: popup shows users
- Drag panel left edge: resizes
- Bugs tab: reports display correctly
- Metrics tab: bug charts, quality cards, score ranking, limitations, encoder/ICE table all render

**Step 2: Fix any issues found during verification**
