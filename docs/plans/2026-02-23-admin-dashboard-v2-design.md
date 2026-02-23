# Admin Dashboard v2 — Design Document
**Date:** 2026-02-23
**Status:** Approved

## Overview
Major enhancements to the in-app admin dashboard: expanded color system, resizable panel, interactive leaderboard/heatmap, bug report fixes + charts, and comprehensive quality metrics visualization.

## 1. Color System (30-Color Palette)

**Goal:** Every user gets a unique, consistent color across all dashboard components.

- **30 curated colors** — visually distinct on dark backgrounds
- **Hash-based on display name** (not identity) — same person always gets the same color regardless of device/session
- **Applied everywhere:** leaderboard bars, heatmap highlights, timeline spans, bug charts, quality bars
- Replaces current 8-color palette

## 2. Resizable Admin Panel

**Goal:** User can drag the panel to their desired width.

- **Drag handle** on the left edge — subtle vertical line, `col-resize` cursor on hover
- **Min width:** 400px
- **Max width:** 80% of viewport width
- **Default:** 420px (current)
- **Persistence:** `localStorage('admin-panel-width')` — remembered across sessions
- Panel remains absolutely positioned on the right side

## 3. Interactive Leaderboard + Heatmap

### Leaderboard Click → Heatmap Filter
- Click a user bar on the leaderboard → heatmap filters to show ONLY that user's joins
- Filtered cells show the user's color (instead of generic orange)
- Non-active cells dimmed (low opacity)
- Selected user bar gets a highlight border/glow
- Click same user again OR click "Show All" button to clear filter
- **Rust change required:** `heatmap_joins` must include user identity/name per timestamp so the frontend can filter by user

### Heatmap Cell Click → User Popup
- Click a heatmap cell → popup showing which users were active in that hour
- Popup lists: color dot + user name + join count for each user
- Click elsewhere to dismiss
- Works in both filtered and unfiltered mode

### Rust Endpoint Change
`heatmap_joins: Vec<u64>` → `heatmap_joins: Vec<HeatmapJoin>` where:
```rust
struct HeatmapJoin {
    timestamp: u64,
    name: String,
}
```

## 4. Bug Report Fixes + Charts

### Fix Bugs Tab
- Investigate and fix why bug reports are not displaying
- Ensure `fetchAdminBugs()` correctly renders reports

### Bug Charts (on Metrics tab)
- **Bugs by User** — horizontal bar chart showing total bug submissions per person (user colors)
- **Bugs by Day** — vertical bar chart showing daily bug submission counts to spot spiky days
- Data source: existing `/admin/api/bugs` endpoint (already returns reporter + timestamp)

## 5. Quality Dashboard (Metrics Tab)

All components rendered on the Metrics tab below existing session data.

### 5a. Quality Summary Cards
- Average FPS across all users
- Average Bitrate (Mbps)
- Average % Bandwidth-Limited
- Average % CPU-Limited
- Same card style as session summary cards

### 5b. Per-User Quality Bars
- Horizontal bars for each user showing:
  - Average FPS (bar)
  - Average Bitrate in Mbps (bar)
- Color-coded by user color
- Sorted by best quality first

### 5c. Quality Limitation Breakdown
- Stacked horizontal bar per user showing:
  - Green = clean (no limitation)
  - Yellow = CPU-limited %
  - Red = Bandwidth-limited %
- Shows at a glance who's struggling and why

### 5d. Quality Score Ranking
- Composite score 0-100 per user
- Weighted formula: `score = (fps_norm * 0.4) + (bitrate_norm * 0.3) + (clean_pct * 0.3)`
  - `fps_norm`: avg_fps / 60 (capped at 1.0)
  - `bitrate_norm`: avg_bitrate / 15000 kbps (capped at 1.0)
  - `clean_pct`: 1.0 - (bw_limited + cpu_limited) / 100
- Sorted best to worst — "who's having the best experience" leaderboard
- Score displayed as colored badge (green 80+, yellow 50-79, red <50)

### 5e. Encoder Distribution
- Per user: which video encoder their browser picked
- Displayed as small badges/pills (e.g., "H264", "VP9", "AV1")
- Data source: existing bug report telemetry has `encoder` field; need to also capture in stats snapshots

### 5f. ICE Connection Type
- Per user: connection path
  - `host` = direct LAN
  - `srflx` = direct internet (STUN)
  - `relay` = TURN relay
- Displayed as badges with color coding (green=host, blue=srflx, orange=relay)
- Data source: existing bug report telemetry has `ice_local_type`/`ice_remote_type`; need to also capture in stats snapshots

### Rust Endpoint Changes for Quality
Extend `/admin/api/metrics` response to include:
- `encoder: Option<String>` per user (most common encoder used)
- `ice_local_type: Option<String>` per user (most common ICE type)
- `ice_remote_type: Option<String>` per user

These fields are already captured in stats snapshots (`admin_report_stats`), just need to be aggregated in the metrics response.

## 6. Metrics Tab Layout Order

Top to bottom on the Metrics tab:
1. Session Summary Cards (existing)
2. User Leaderboard (existing, with new colors + click interaction)
3. Activity Heatmap (existing, with new interactivity)
4. Today's Sessions Timeline (existing)
5. **NEW: Bug Summary Charts** (by user + by day)
6. **NEW: Quality Summary Cards**
7. **NEW: Quality Score Ranking**
8. **NEW: Per-User Quality Bars** (FPS + Bitrate)
9. **NEW: Quality Limitation Breakdown**
10. **NEW: Encoder & ICE Connection Info**
11. Stream Quality Table (existing, kept as detailed reference)

## Files Modified

- `core/viewer/app.js` — all frontend rendering changes
- `core/viewer/style.css` — all styling changes
- `core/control/src/main.rs` — Rust endpoint changes (heatmap joins with user info, quality metrics aggregation)
- `core/viewer/index.html` — no changes expected (panel structure stays the same)
