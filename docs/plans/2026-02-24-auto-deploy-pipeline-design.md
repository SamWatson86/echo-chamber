# Auto-Deploy Pipeline Design

**Date:** 2026-02-24
**Status:** Approved

## Goal

Automate deployment so that merged PRs on main automatically deploy to Sam's server after passing tests. Prevent direct pushes to main.

## Prerequisites

1. Merge Spencer's PR #49 (docs) and #48 (tests + verification) — provides the test suite
2. Both PRs have been rebased onto current main and review feedback addressed

## Branch Protection

- `enforce_admins: true` — no direct pushes to main, even for repo owner
- 0 required reviewers — no human review gate
- Required status check: `pr-verify-quick` — Spencer's CI workflow must pass before merge is allowed
- Spencer's `pr-verify-quick.yml` stays as-is (triggers on PR open/sync)

## Developer Workflow

1. Claude creates feature branch + PR
2. CI runs Spencer's test suite automatically
3. Tests pass → merge immediately (no review wait)
4. Deploy watcher detects new commit on main within 3 minutes
5. Pulls, runs tests locally, builds, deploys (blue-green swap)

## Deploy Watcher Script

**File:** `core/deploy/deploy-watcher.ps1`
**Runs as:** Windows Scheduled Task (like power manager watcher)

### Poll Loop

1. Every 3 minutes: `git ls-remote origin main` → compare SHA against `.last-deployed-sha`
2. New commit detected → begin deploy sequence
3. No change → sleep and poll again

### Deploy Sequence

1. `git pull origin main` (fast-forward only)
2. Run Spencer's test suite (`tools/verify/quick.sh` via Git Bash)
3. If tests fail → log failure, skip deploy, continue polling
4. If tests pass → `cargo build -p echo-core-control` in `core/`
5. If build fails → log failure, skip deploy, continue polling
6. If build succeeds → blue-green swap:
   a. Copy current working binary to `.bak` (rollback safety)
   b. Kill old control plane process (elevated taskkill)
   c. Start new control plane (Start-Process, hidden window, redirected logs)
   d. Health check `https://127.0.0.1:9443/health` within 10 seconds
   e. If health check fails → restore `.bak` binary, restart, log rollback
   f. If health check passes → update `.last-deployed-sha`, log success

### Rollback Safety

- Before each deploy: `echo-core-control.exe` → `echo-core-control.exe.bak`
- Failed health check triggers automatic rollback to `.bak`
- All deploy attempts logged with timestamps and outcomes

### Configuration

**File:** `core/deploy/deploy-watcher.config.json`

```json
{
  "pollIntervalSeconds": 180,
  "healthCheckUrl": "https://127.0.0.1:9443/health",
  "healthCheckTimeoutSeconds": 10,
  "maxConsecutiveFailures": 3,
  "testCommand": "bash tools/verify/quick.sh",
  "logFile": "core/logs/deploy-watcher.log"
}
```

### Scheduled Task Setup

**File:** `core/deploy/install-deploy-watcher.ps1`

- Creates Windows Scheduled Task "EchoChamberDeployWatcher"
- Runs as current user at logon
- Runs elevated (needs to kill/start server processes)

## Logging

All output to `core/logs/deploy-watcher.log`:
- Poll checks (SHA comparisons)
- Test results (pass/fail with output)
- Build results
- Deploy swaps (old PID → new PID)
- Rollbacks
- Errors

## What This Does NOT Do

- Does NOT rebuild the Tauri client (that's still tag-triggered via GitHub Releases)
- Does NOT restart SFU or TURN (those rarely change)
- Does NOT handle viewer-only changes specially (viewer files come with `git pull`, served live on refresh)
