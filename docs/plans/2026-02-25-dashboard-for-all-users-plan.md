# Dashboard for All Users — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the admin dashboard visible to all connected users, not just the admin-client build.

**Architecture:** Pure client-side change. Every user already has an `adminToken` (they all log in with the room password, which IS the admin password). The dashboard panel is hidden solely by the `admin-only` CSS class, gated behind `isAdminMode()` which checks `window.__ECHO_ADMIN__`. We remove that gate for dashboard elements while preserving it for kick/mute controls.

**Tech Stack:** JavaScript (app.js), HTML (index.html), CSS (style.css)

---

### Task 1: Show Dashboard Button to All Users (index.html)

**Files:**
- Modify: `core/viewer/index.html` (~line 331)

**Step 1: Remove `admin-only` class from dashboard panel**

In `core/viewer/index.html`, the dashboard panel div and the dashboard toggle button both have `class="admin-only"`. Change the panel to remove that class so it's always in the DOM (still hidden by default via `hidden` class):

Find the admin dashboard panel section (~line 331):
```html
<div id="admin-dash-panel" class="admin-only hidden admin-dash-panel">
```
Change to:
```html
<div id="admin-dash-panel" class="hidden admin-dash-panel">
```

**Step 2: Add a dashboard toggle button visible to all users**

Find the toolbar area where other buttons live. Add a dashboard toggle button that does NOT have `admin-only` class. The existing admin dashboard button is in the admin toolbar — we need a new one in the main toolbar area that all users can see.

Search for the existing admin-dash toggle button in index.html — it may be generated in JS or in HTML. If it's in HTML with `admin-only`, create a parallel button without that class. If it's generated in JS inside an `isAdminMode()` check, we move it outside.

---

### Task 2: Show Dashboard Panel for All Users (app.js)

**Files:**
- Modify: `core/viewer/app.js`

**Step 1: Find the dashboard button generation**

Search for where the admin dashboard button/icon is created or shown. This may be:
- In the `isAdminMode()` block that reveals `admin-only` elements
- A dynamically generated button in the toolbar
- An HTML element with `admin-only` class

**Step 2: Show dashboard button for all users**

Whatever creates/shows the dashboard toggle button, make it run for ALL users (not just `isAdminMode()`). The button calls `toggleAdminDash()` which is already a global function.

**Step 3: Keep kick/mute admin-only**

Verify that kick/mute buttons are generated inside `isAdminMode()` checks in the video tile rendering code. These must stay gated. Do NOT touch them.

**Step 4: Stats reporting for all users**

The stats reporting code (~line 2043) already runs for all users who have `adminToken`:
```javascript
if (adminToken) {
  fetch(apiUrl("/admin/api/stats"), ...
```
All users have `adminToken` since they all log in. No change needed here.

---

### Task 3: Rename UI Label (Optional Polish)

**Files:**
- Modify: `core/viewer/index.html`
- Modify: `core/viewer/app.js`

**Step 1: Rename "Admin Dashboard" to "Dashboard"**

Since it's no longer admin-exclusive, update the header text:

In `index.html` (~line 333):
```html
<h3>Admin Dashboard</h3>
```
Change to:
```html
<h3>Dashboard</h3>
```

Also search `app.js` for any references to "Admin Dashboard" in rendered HTML strings and change to "Dashboard".

---

### Task 4: Build, Test, Commit

**Step 1: Kill running server**
```powershell
Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe"' -Verb RunAs
```

**Step 2: Rebuild** (only if Rust changes were made — likely not needed)
```powershell
cd "F:\Codex AI\The Echo Chamber\core"
cargo build -p echo-core-control
```

**Step 3: Restart server**
```powershell
Start-Process -FilePath .\target\debug\echo-core-control.exe -WorkingDirectory "F:\Codex AI\The Echo Chamber\core" -WindowStyle Hidden
```

**Step 4: Verify**
- Open viewer in browser: `https://127.0.0.1:9443/viewer/`
- Connect as regular user (NOT admin-client)
- Dashboard button should be visible in toolbar
- Click dashboard → all 5 tabs should load data
- Kick/mute buttons should NOT appear on participant tiles

**Step 5: Commit + PR**
```bash
git checkout -b feat/dashboard-for-all-users
git add core/viewer/index.html core/viewer/app.js core/viewer/style.css
git commit -m "feat: show dashboard to all connected users, not just admin"
git push -u origin feat/dashboard-for-all-users
gh pr create --title "feat: dashboard visible to all users" --body "..."
```
