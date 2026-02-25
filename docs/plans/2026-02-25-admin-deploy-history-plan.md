# Admin Deploy History Tab — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Deploys" tab to the admin dashboard showing recent commits with deploy status (success/failed/pending).

**Architecture:** Deploy watcher writes structured JSON after each deploy attempt. Rust endpoint reads that JSON + runs `git log` to merge commit info with deploy outcomes. Admin panel renders a new 5th tab with a deploy timeline.

**Tech Stack:** PowerShell (deploy watcher), Rust/axum (API endpoint), vanilla JS (admin UI), CSS (styling)

---

### Task 1: Upgrade Deploy Watcher to Write Structured JSON

**Files:**
- Modify: `core/deploy/deploy-watcher.ps1`

**Step 1: Add JSON history writer function**

Add after the `Set-LastDeployedSha` function (~line 75). This function reads existing history, appends a new entry, prunes to 50 max, and writes back:

```powershell
function Write-DeployEvent([string]$sha, [string]$status, [int]$durationSec, [string]$errorMsg) {
    $historyFile = Join-Path $deployDir "deploy-history.json"
    $history = @()
    if (Test-Path $historyFile) {
        try { $history = @(Get-Content $historyFile -Raw | ConvertFrom-Json) } catch { $history = @() }
    }
    $entry = @{
        sha = $sha
        status = $status
        timestamp = (Get-Date).ToString("s")
        duration_seconds = $durationSec
        error = $errorMsg
    }
    $history = @($entry) + @($history)
    if ($history.Count -gt 50) { $history = $history[0..49] }
    $json = $history | ConvertTo-Json -Depth 3
    if ($history.Count -eq 1) { $json = "[$json]" }
    [System.IO.File]::WriteAllText($historyFile, $json)
}
```

**Step 2: Wire into deploy sequence**

In the main loop deploy section, track timing and write events. After `Deploy-BlueGreen` returns, record the result. Modify the deploy sequence (~line 220-240) to:

- Record `$deployStart = Get-Date` before the deploy sequence begins (before `Run-Tests`)
- After successful deploy: `Write-DeployEvent $remoteSha "success" $duration $null`
- After test failure: `Write-DeployEvent $remoteSha "failed" $duration "Tests failed"`
- After build failure: `Write-DeployEvent $remoteSha "failed" $duration "Build failed"`
- After rollback: `Write-DeployEvent $remoteSha "rollback" $duration "Health check failed - rolled back"`

**Step 3: Add deploy-history.json to .gitignore**

Append `core/deploy/deploy-history.json` to `.gitignore` (it's per-machine state like `.last-deployed-sha`).

**Step 4: Test**

Run deploy watcher with a fake old SHA to trigger a deploy, verify `deploy-history.json` is created with a valid entry:

```powershell
printf '0000000' > core/deploy/.last-deployed-sha
powershell -ExecutionPolicy Bypass -File core/deploy/deploy-watcher.ps1 -Once
cat core/deploy/deploy-history.json
```

---

### Task 2: Add Rust API Endpoint

**Files:**
- Modify: `core/control/src/main.rs` (route at ~line 751, handler after admin_bug_reports at ~line 2041)

**Step 1: Add the route**

After line 751, add:

```rust
.route("/admin/api/deploys", get(admin_deploys))
```

**Step 2: Add the handler function**

After `admin_bug_reports` handler (~line 2041), add:

```rust
async fn admin_deploys(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ensure_admin(&state, &headers)?;

    // Read deploy history JSON
    let deploy_dir = std::path::Path::new("core/deploy");
    let history_file = deploy_dir.join("deploy-history.json");
    let deploy_events: Vec<serde_json::Value> = if history_file.exists() {
        match std::fs::read_to_string(&history_file) {
            Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
            Err(_) => vec![],
        }
    } else {
        vec![]
    };

    // Build a SHA -> deploy status map
    let mut deploy_map: std::collections::HashMap<String, &serde_json::Value> =
        std::collections::HashMap::new();
    for event in &deploy_events {
        if let Some(sha) = event.get("sha").and_then(|v| v.as_str()) {
            // Only keep the most recent deploy attempt per SHA
            deploy_map.entry(sha.to_string()).or_insert(event);
        }
    }

    // Run git log for recent commits
    let git_output = std::process::Command::new("git")
        .args(["log", "--format=%H|%an|%s|%aI", "-30", "origin/main"])
        .output();

    let mut commits = vec![];
    if let Ok(output) = git_output {
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            if parts.len() < 4 { continue; }
            let sha = parts[0];
            let short_sha = &sha[..7.min(sha.len())];
            let author = parts[1];
            let message = parts[2];
            let timestamp = parts[3];

            let (deploy_status, deploy_ts, deploy_error) =
                if let Some(event) = deploy_map.get(short_sha)
                    .or_else(|| deploy_map.get(sha))
                {
                    let status = event.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
                    let ts = event.get("timestamp").and_then(|v| v.as_str()).map(|s| s.to_string());
                    let err = event.get("error").and_then(|v| v.as_str()).map(|s| s.to_string());
                    (Some(status.to_string()), ts, err)
                } else {
                    (None, None, None)
                };

            commits.push(serde_json::json!({
                "sha": sha,
                "short_sha": short_sha,
                "author": author,
                "message": message,
                "timestamp": timestamp,
                "deploy_status": deploy_status,
                "deploy_timestamp": deploy_ts,
                "deploy_error": deploy_error,
            }));
        }
    }

    Ok(Json(serde_json::json!({ "commits": commits })))
}
```

**Step 3: Build and verify**

```powershell
cd core && cargo build -p echo-core-control
```

Verify with curl after restart:

```bash
curl -sk https://127.0.0.1:9443/admin/api/deploys -H "Authorization: Bearer $TOKEN"
```

---

### Task 3: Add Deploys Tab to Admin HTML

**Files:**
- Modify: `core/viewer/index.html` (lines 338-347)

**Step 1: Add the tab button**

After the Bugs tab button (line 341), add:

```html
<button type="button" class="adm-tab" onclick="switchAdminTab(this,'admin-dash-deploys')">Deploys</button>
```

**Step 2: Add the content div**

After the bugs content div (before the closing `</div>` of admin-dash-panel, ~line 347), add:

```html
<div id="admin-dash-deploys" class="admin-dash-content hidden"><div class="adm-empty">Loading...</div></div>
```

---

### Task 4: Add Deploys Tab JavaScript

**Files:**
- Modify: `core/viewer/app.js` (after `fetchAdminBugs` function, ~line 11077)

**Step 1: Add the fetch and render function**

```javascript
async function fetchAdminDeploys() {
  var deploysDiv = document.getElementById("admin-dash-deploys");
  if (!deploysDiv) return;
  try {
    var resp = await fetch(apiUrl() + "/admin/api/deploys", {
      headers: { Authorization: "Bearer " + adminToken },
    });
    if (!resp.ok) { deploysDiv.innerHTML = '<div class="adm-empty">Failed to load (' + resp.status + ')</div>'; return; }
    var data = await resp.json();
    renderAdminDeploys(data.commits || [], deploysDiv);
  } catch (e) {
    deploysDiv.innerHTML = '<div class="adm-empty">Error: ' + e.message + '</div>';
  }
}

function renderAdminDeploys(commits, container) {
  if (!commits.length) {
    container.innerHTML = '<div class="adm-empty">No deploy history yet</div>';
    return;
  }
  var html = '<div class="adm-deploy-list">';
  for (var i = 0; i < commits.length; i++) {
    var c = commits[i];
    var statusClass = "adm-deploy-pending";
    var statusLabel = "Pending";
    if (c.deploy_status === "success") { statusClass = "adm-deploy-success"; statusLabel = "Deployed"; }
    else if (c.deploy_status === "failed") { statusClass = "adm-deploy-failed"; statusLabel = "Failed"; }
    else if (c.deploy_status === "rollback") { statusClass = "adm-deploy-failed"; statusLabel = "Rolled Back"; }
    else if (!c.deploy_status) { statusClass = "adm-deploy-none"; statusLabel = "Pre-watcher"; }

    var timeAgo = formatTimeAgo(c.timestamp);
    var msg = escapeHtml(c.message.length > 80 ? c.message.substring(0, 77) + "..." : c.message);
    var author = escapeHtml(c.author);

    html += '<div class="adm-deploy-row">';
    html += '<div class="adm-deploy-dot ' + statusClass + '"></div>';
    html += '<div class="adm-deploy-info">';
    html += '<div class="adm-deploy-msg">' + msg + '</div>';
    html += '<div class="adm-deploy-meta">' + author + ' &middot; ' + c.short_sha + ' &middot; ' + timeAgo + '</div>';
    if (c.deploy_error) {
      html += '<div class="adm-deploy-error">' + escapeHtml(c.deploy_error) + '</div>';
    }
    html += '</div>';
    html += '<div class="adm-deploy-badge ' + statusClass + '">' + statusLabel + '</div>';
    html += '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function formatTimeAgo(isoStr) {
  var then = new Date(isoStr);
  var now = new Date();
  var diffMs = now - then;
  var mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  var days = Math.floor(hrs / 24);
  return days + "d ago";
}
```

**Step 2: Wire into the admin tab switching**

In the `switchAdminTab` function (~line 10610), add a fetch trigger. After `btn.classList.add("active")`, add:

```javascript
if (tabId === "admin-dash-deploys") fetchAdminDeploys();
```

Also add to `toggleAdminDash` (~wherever the initial fetches fire) so Deploys tab data loads when panel opens.

---

### Task 5: Add Deploys Tab CSS

**Files:**
- Modify: `core/viewer/style.css` (after existing admin styles, ~line 4507)

**Step 1: Add deploy tab styles**

```css
/* Deploy History Tab */
.adm-deploy-list { display: flex; flex-direction: column; gap: 6px; }
.adm-deploy-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 8px;
  background: rgba(255,255,255,0.04);
}
.adm-deploy-row:hover { background: rgba(255,255,255,0.08); }
.adm-deploy-dot {
  width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
}
.adm-deploy-dot.adm-deploy-success { background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.4); }
.adm-deploy-dot.adm-deploy-failed { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.4); }
.adm-deploy-dot.adm-deploy-pending { background: #facc15; box-shadow: 0 0 6px rgba(250,204,21,0.4); }
.adm-deploy-dot.adm-deploy-none { background: #6b7280; }
.adm-deploy-info { flex: 1; min-width: 0; }
.adm-deploy-msg {
  font-size: 13px; font-weight: 500; color: #e2e8f0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.adm-deploy-meta { font-size: 11px; color: #94a3b8; margin-top: 2px; }
.adm-deploy-error {
  font-size: 11px; color: #fca5a5; margin-top: 4px;
  padding: 4px 8px; border-radius: 4px; background: rgba(248,113,113,0.1);
}
.adm-deploy-badge {
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px;
  flex-shrink: 0; text-transform: uppercase; letter-spacing: 0.5px;
}
.adm-deploy-badge.adm-deploy-success { background: rgba(74,222,128,0.15); color: #4ade80; }
.adm-deploy-badge.adm-deploy-failed { background: rgba(248,113,113,0.15); color: #f87171; }
.adm-deploy-badge.adm-deploy-pending { background: rgba(250,204,21,0.15); color: #facc15; }
.adm-deploy-badge.adm-deploy-none { background: rgba(107,114,128,0.15); color: #6b7280; }
```

---

### Task 6: Build, Test, Commit, Push via PR

**Step 1: Rebuild Rust control plane**

Kill server, rebuild, restart, verify.

**Step 2: Test end-to-end**

- Open admin dashboard
- Click "Deploys" tab
- Verify commit list appears with deploy statuses
- Verify formatting (author, message, time ago, badges)

**Step 3: Create branch, commit, PR**

```powershell
git checkout -b feat/admin-deploy-history
git add core/deploy/deploy-watcher.ps1 core/viewer/index.html core/viewer/app.js core/viewer/style.css core/control/src/main.rs .gitignore
git commit -m "Add Deploys tab to admin dashboard with deploy history"
git push -u origin feat/admin-deploy-history
gh pr create --title "Add deploy history tab to admin dashboard" --body "..."
```

Wait for CI, then merge.
