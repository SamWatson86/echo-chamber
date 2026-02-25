# Admin Deploy History Tab — Design

**Date:** 2026-02-25
**Status:** Approved

## Goal

Add a "Deploys" tab to the admin dashboard showing recent commits on main with their deploy status, so Sam can monitor what's being deployed to his server by any contributor.

## Architecture

Three changes working together:

1. **Deploy watcher upgrade** — Write structured `deploy-history.json` alongside the plain text log. Each deploy attempt recorded with SHA, status, timestamp, and error reason.

2. **New Rust endpoint** — `/admin/api/deploys` reads `deploy-history.json` + runs `git log --format` for recent commits. Merges them: every commit gets a deploy status (deployed, failed, pending). Returns JSON.

3. **New admin tab** — "Deploys" tab in the embedded admin panel. Renders a timeline of commits with colored status badges.

## Deploy History JSON

**File:** `core/deploy/deploy-history.json`

Written by the deploy watcher after each deploy attempt:

```json
[
  {
    "sha": "e56d4d5",
    "status": "success",
    "timestamp": "2026-02-24T21:45:35",
    "duration_seconds": 8,
    "error": null
  },
  {
    "sha": "abc1234",
    "status": "failed",
    "timestamp": "2026-02-24T22:10:05",
    "duration_seconds": 45,
    "error": "Tests FAILED (exit code 1)"
  }
]
```

Status values: `success`, `failed`, `rollback`

Max 50 entries (oldest pruned on write).

## Rust Endpoint

**Route:** `GET /admin/api/deploys` (JWT auth required)

**Response:**

```json
{
  "commits": [
    {
      "sha": "e56d4d5",
      "short_sha": "e56d4d5",
      "author": "Spencer Strombotne",
      "message": "Foundation: unified automated verification",
      "timestamp": "2026-02-24T22:00:49Z",
      "deploy_status": "success",
      "deploy_timestamp": "2026-02-24T21:45:35",
      "deploy_error": null
    }
  ]
}
```

`deploy_status` values: `"success"`, `"failed"`, `"pending"` (commit exists but not yet deployed), `null` (commit predates deploy watcher)

Returns last 30 commits.

## Admin UI

New 5th tab: **Deploys**

Each commit rendered as a card/row:
- Left: colored status dot (green = deployed, red = failed, yellow = pending, gray = pre-watcher)
- Author name + short SHA
- Commit message (first line)
- Relative timestamp ("2 hours ago")
- Failed deploys: expandable error reason

Styled to match existing admin panel (frosted glass, same fonts/colors).

## What This Does NOT Do

- Does not show PR numbers or CI results (would require GitHub API calls)
- Does not auto-refresh (manual refresh like other admin tabs)
- Does not show Tauri client releases (only server deploys)
