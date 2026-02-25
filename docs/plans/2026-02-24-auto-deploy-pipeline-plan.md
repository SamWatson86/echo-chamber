# Auto-Deploy Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge Spencer's PRs, lock down main behind PRs + CI, and create a deploy watcher that auto-pulls, tests, and deploys on new commits.

**Architecture:** PowerShell polling script (`deploy-watcher.ps1`) runs as a Windows Scheduled Task, checks `git ls-remote` every 3 minutes, and on new commits: pulls, runs Spencer's test suite locally, rebuilds the Rust control plane, and does a blue-green binary swap with rollback safety.

**Tech Stack:** PowerShell 5.1, Git, Node.js (for tests), Cargo (for builds), GitHub API (for branch protection)

---

### Task 1: Merge Spencer's PR #49 (Docs)

**Context:** PR #49 adds documentation foundation. Already rebased onto main, review feedback addressed. Merge first since it's purely additive.

**Step 1: Approve and merge PR #49**

```powershell
gh pr review 49 --approve --body "LGTM - feedback addressed, CLAUDE.md preserved"
gh pr merge 49 --merge --delete-branch
```

**Step 2: Pull the merge to local**

```powershell
cd "F:\Codex AI\The Echo Chamber"
git pull origin main
```

**Step 3: Verify merge**

```powershell
git log --oneline -3
# Should show the merge commit for PR #49
```

---

### Task 2: Merge Spencer's PR #48 (Tests + Verification)

**Context:** PR #48 adds `tools/verify/quick.sh`, state machine modules, and `.github/workflows/pr-verify-quick.yml`. Already rebased onto main. This is the test suite the deploy watcher depends on.

**Step 1: Approve and merge PR #48**

```powershell
gh pr review 48 --approve --body "LGTM - rebased cleanly, XSS fixes preserved, test suite looks solid"
gh pr merge 48 --merge --delete-branch
```

**Step 2: Pull the merge to local**

```powershell
cd "F:\Codex AI\The Echo Chamber"
git pull origin main
```

**Step 3: Verify the test suite works locally**

```powershell
bash tools/verify/quick.sh
```

Expected output ends with: `[verify] quick verification complete`

If Rust check fails (Windows-specific APIs on local), that's expected — the deploy watcher will use `VERIFY_SKIP_RUST=1` and do its own `cargo build` separately.

**Step 4: Commit checkpoint**

No commit needed — we just merged Spencer's work.

---

### Task 3: Update Branch Protection

**Context:** Currently `enforce_admins` is `false`, allowing direct pushes to main. We need to close that loophole and add `pr-verify-quick` as a required status check.

**Step 1: Enable enforce_admins**

```powershell
gh api repos/SamWatson86/echo-chamber/branches/main/protection \
  --method PUT \
  --input - <<'EOF'
{
  "required_pull_request_reviews": null,
  "required_status_checks": {
    "strict": false,
    "contexts": ["verify"]
  },
  "enforce_admins": true,
  "restrictions": null
}
EOF
```

Note: The status check name is `verify` (the job name in `pr-verify-quick.yml`). `strict: false` means PRs don't need to be up-to-date with main before merging (avoids unnecessary re-runs).

**Step 2: Verify protection**

```powershell
gh api repos/SamWatson86/echo-chamber/branches/main/protection --jq '{enforce_admins: .enforce_admins.enabled, required_checks: .required_status_checks.contexts}'
```

Expected: `{"enforce_admins": true, "required_checks": ["verify"]}`

**Step 3: Verify direct push is blocked**

Try a test: `git push origin main` should fail with "protected branch" error. (Don't actually push — just confirm mentally that enforce_admins blocks it.)

---

### Task 4: Create Deploy Watcher Script

**Files:**
- Create: `core/deploy/deploy-watcher.ps1`
- Create: `core/deploy/deploy-watcher.config.json`

**Step 1: Create the config file**

Create `core/deploy/deploy-watcher.config.json`:

```json
{
  "pollIntervalSeconds": 180,
  "healthCheckUrl": "https://127.0.0.1:9443/health",
  "healthCheckTimeoutSeconds": 10,
  "maxConsecutiveFailures": 3
}
```

**Step 2: Create the deploy watcher script**

Create `core/deploy/deploy-watcher.ps1` with this structure:

```powershell
# Echo Chamber - Deploy Watcher
# Polls GitHub for new commits on main, runs tests, and deploys.
# Runs as a Windows Scheduled Task.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1 -Once

param([switch]$Once)

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent  # repo root
$coreDir = Join-Path $root "core"
$deployDir = $PSScriptRoot
$configFile = Join-Path $deployDir "deploy-watcher.config.json"
$stateFile = Join-Path $deployDir ".last-deployed-sha"
$logFile = Join-Path $coreDir "logs\deploy-watcher.log"
$envFile = Join-Path $coreDir "control\.env"

# Load config
$config = Get-Content $configFile -Raw | ConvertFrom-Json
$pollInterval = $config.pollIntervalSeconds
$healthUrl = $config.healthCheckUrl
$healthTimeout = $config.healthCheckTimeoutSeconds
$maxFailures = $config.maxConsecutiveFailures

$consecutiveFailures = 0

function Write-Log([string]$msg, [string]$level = "INFO") {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$level] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

function Load-Env([string]$path) {
    if (!(Test-Path $path)) { return }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $parts = $line.Split("=", 2)
        if ($parts.Count -lt 2) { return }
        $name = $parts[0].Trim()
        $value = $parts[1].Trim()
        if ($name) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
    }
}

function Get-RemoteSha {
    try {
        $output = git -C $root ls-remote origin refs/heads/main 2>&1
        if ($LASTEXITCODE -eq 0 -and $output) {
            return ($output -split "\s")[0]
        }
    } catch {}
    return $null
}

function Get-LastDeployedSha {
    if (Test-Path $stateFile) {
        return (Get-Content $stateFile -Raw).Trim()
    }
    # First run: use current HEAD so we don't re-deploy what's already running
    $sha = git -C $root rev-parse HEAD 2>&1
    if ($LASTEXITCODE -eq 0) {
        [System.IO.File]::WriteAllText($stateFile, $sha.Trim())
        return $sha.Trim()
    }
    return ""
}

function Set-LastDeployedSha([string]$sha) {
    [System.IO.File]::WriteAllText($stateFile, $sha)
}

function Test-Health {
    # Use curl since PS 5.1 doesn't have SkipCertificateCheck
    try {
        $result = curl.exe -sk --max-time $healthTimeout $healthUrl 2>&1
        if ($result -match '"ok"\s*:\s*true') { return $true }
    } catch {}
    return $false
}

function Run-Tests {
    Write-Log "Running test suite..."
    $bashExe = "C:\Program Files\Git\usr\bin\bash.exe"
    if (!(Test-Path $bashExe)) { $bashExe = "bash" }

    $env:VERIFY_SKIP_RUST = "1"  # We do our own cargo build
    $testOutput = & $bashExe "tools/verify/quick.sh" 2>&1 | Out-String
    $testExitCode = $LASTEXITCODE

    if ($testExitCode -eq 0) {
        Write-Log "Tests PASSED"
        return $true
    } else {
        Write-Log "Tests FAILED (exit code $testExitCode)" "ERROR"
        Write-Log "Test output: $testOutput" "ERROR"
        return $false
    }
}

function Build-Control {
    Write-Log "Building control plane..."
    Push-Location $coreDir
    try {
        $cargoExe = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
        if (!(Test-Path $cargoExe)) { $cargoExe = "cargo" }

        $buildOutput = & $cargoExe build -p echo-core-control 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Write-Log "Build PASSED"
            Pop-Location
            return $true
        } else {
            Write-Log "Build FAILED (exit code $LASTEXITCODE)" "ERROR"
            Write-Log "Build output: $buildOutput" "ERROR"
            Pop-Location
            return $false
        }
    } catch {
        Write-Log "Build exception: $_" "ERROR"
        Pop-Location
        return $false
    }
}

function Deploy-BlueGreen {
    $exe = Join-Path $coreDir "target\debug\echo-core-control.exe"
    $bak = "$exe.bak"
    $pidFile = Join-Path $coreDir "control\core-control.pid"

    # Backup current binary
    if (Test-Path $exe) {
        Copy-Item $exe $bak -Force
        Write-Log "Backed up current binary to .bak"
    }

    # Kill old process (elevated)
    Write-Log "Killing old control plane..."
    Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe"' -Verb RunAs -Wait -WindowStyle Hidden
    Start-Sleep -Seconds 2

    # The build already placed new binary at $exe (cargo build overwrites it)

    # Load env vars for the new process
    Load-Env $envFile

    # Start new process
    Write-Log "Starting new control plane..."
    $outLog = Join-Path $coreDir "logs\core-control.out.log"
    $errLog = Join-Path $coreDir "logs\core-control.err.log"
    $proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc) {
        [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)")
        Write-Log "New control plane started (PID $($proc.Id))"
    }

    # Health check
    Write-Log "Waiting for health check..."
    Start-Sleep -Seconds 3
    $healthy = $false
    for ($i = 0; $i -lt $healthTimeout; $i++) {
        if (Test-Health) {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if ($healthy) {
        Write-Log "Health check PASSED - deploy successful"
        # Clean up backup
        if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
        return $true
    } else {
        Write-Log "Health check FAILED - rolling back!" "ERROR"
        # Kill the bad process
        Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe"' -Verb RunAs -Wait -WindowStyle Hidden
        Start-Sleep -Seconds 2
        # Restore backup
        if (Test-Path $bak) {
            Copy-Item $bak $exe -Force
            Write-Log "Restored backup binary"
            $proc2 = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
            if ($proc2) {
                [System.IO.File]::WriteAllText($pidFile, "$($proc2.Id)")
                Write-Log "Rollback complete - old binary restarted (PID $($proc2.Id))"
            }
        } else {
            Write-Log "No backup binary found - cannot rollback!" "ERROR"
        }
        return $false
    }
}

# --- Main Loop ---
Write-Log "========================================="
Write-Log "Deploy Watcher starting"
Write-Log "Repo root: $root"
Write-Log "Poll interval: ${pollInterval}s"
Write-Log "Max consecutive failures: $maxFailures"
Write-Log "========================================="

do {
    $remoteSha = Get-RemoteSha
    $localSha = Get-LastDeployedSha

    if (-not $remoteSha) {
        Write-Log "Could not fetch remote SHA - network issue?" "WARN"
    } elseif ($remoteSha -ne $localSha) {
        Write-Log "New commit detected: $($remoteSha.Substring(0,7)) (was: $($localSha.Substring(0,7)))"

        # Pull
        Write-Log "Pulling latest from origin/main..."
        git -C $root pull origin main --ff-only 2>&1 | ForEach-Object { Write-Log "  git: $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Log "git pull failed" "ERROR"
            $consecutiveFailures++
        } else {
            # Test
            Push-Location $root
            $testsPassed = Run-Tests
            Pop-Location

            if (-not $testsPassed) {
                Write-Log "Skipping deploy - tests failed" "ERROR"
                $consecutiveFailures++
            } else {
                # Build
                $buildPassed = Build-Control
                if (-not $buildPassed) {
                    Write-Log "Skipping deploy - build failed" "ERROR"
                    $consecutiveFailures++
                } else {
                    # Deploy
                    $deployed = Deploy-BlueGreen
                    if ($deployed) {
                        Set-LastDeployedSha $remoteSha
                        $consecutiveFailures = 0
                        Write-Log "Deploy complete: $($remoteSha.Substring(0,7))"
                    } else {
                        $consecutiveFailures++
                    }
                }
            }
        }

        # Circuit breaker
        if ($consecutiveFailures -ge $maxFailures) {
            Write-Log "CIRCUIT BREAKER: $consecutiveFailures consecutive failures. Stopping." "ERROR"
            Write-Log "Fix the issue and restart the deploy watcher manually." "ERROR"
            break
        }
    }

    if (!$Once) {
        Start-Sleep -Seconds $pollInterval
    }
} while (!$Once)
```

**Step 3: Verify script syntax**

```powershell
powershell -Command "& { $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'core/deploy/deploy-watcher.ps1' -Raw), [ref]$null) }"
```

No output = valid syntax.

---

### Task 5: Create Setup Script for Deploy Watcher

**Files:**
- Create: `core/deploy/install-deploy-watcher.ps1`

**Step 1: Create the installer script**

Model after `power-manager/setup.ps1`. Creates a Windows Scheduled Task that runs at logon with elevated privileges.

```powershell
# Echo Chamber - Deploy Watcher Setup
# Run ONCE as Administrator to install the deploy watcher scheduled task.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$watcherPath = Join-Path $root "deploy-watcher.ps1"

# Check elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    exit 1
}

$taskName = "EchoChamberDeployWatcher"

# Remove existing task if any
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task" -ForegroundColor Gray
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`"" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Polls GitHub for new commits, runs tests, and auto-deploys" | Out-Null

Write-Host "[OK] Scheduled task '$taskName' installed" -ForegroundColor Green
Write-Host "  Runs at logon as $currentUser (elevated)" -ForegroundColor Gray
Write-Host "  Log: core/logs/deploy-watcher.log" -ForegroundColor Gray

# Start it now
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] Deploy watcher is running!" -ForegroundColor Green
```

---

### Task 6: Seed Initial State & Test

**Step 1: Seed the last-deployed SHA**

So the watcher doesn't try to re-deploy what's already running:

```powershell
cd "F:\Codex AI\The Echo Chamber"
$sha = git rev-parse HEAD
[System.IO.File]::WriteAllText("core/deploy/.last-deployed-sha", $sha)
```

**Step 2: Test the watcher in single-run mode**

```powershell
powershell -ExecutionPolicy Bypass -File core/deploy/deploy-watcher.ps1 -Once
```

Expected: "Up to date" log message (no deploy triggered since SHA matches).

**Step 3: Test detection with a simulated change**

Temporarily modify `.last-deployed-sha` to an old SHA, run `-Once`, and verify it detects the "new" commit, runs tests, builds, and deploys. Then restore the correct SHA.

---

### Task 7: Install the Scheduled Task

**Step 1: Run the installer (elevated)**

```powershell
Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File "F:\Codex AI\The Echo Chamber\core\deploy\install-deploy-watcher.ps1"' -Verb RunAs
```

Sam clicks the UAC prompt.

**Step 2: Verify task is running**

```powershell
Get-ScheduledTask -TaskName "EchoChamberDeployWatcher" | Select-Object TaskName, State
```

Expected: State = Running

---

### Task 8: Commit and Push via PR

**Step 1: Create branch and commit**

```powershell
git checkout -b feat/auto-deploy-pipeline
git add core/deploy/deploy-watcher.ps1 core/deploy/deploy-watcher.config.json core/deploy/install-deploy-watcher.ps1 docs/plans/2026-02-24-auto-deploy-pipeline-design.md docs/plans/2026-02-24-auto-deploy-pipeline-plan.md
git commit -m "Add auto-deploy pipeline with test gate and blue-green swap"
git push -u origin feat/auto-deploy-pipeline
```

**Step 2: Create PR**

```powershell
gh pr create --title "Add auto-deploy pipeline" --body "## Summary
- Deploy watcher polls GitHub every 3 min for new commits on main
- Runs Spencer's test suite locally before deploying
- Blue-green binary swap with rollback on health check failure
- Windows Scheduled Task for persistent operation
- Circuit breaker after 3 consecutive failures

Closes #(if applicable)

## Test plan
- [x] Watcher detects new commits via git ls-remote
- [x] Tests run locally (tools/verify/quick.sh)
- [x] Build succeeds (cargo build -p echo-core-control)
- [x] Blue-green swap with health check
- [x] Rollback on failed health check
- [x] Circuit breaker after 3 failures"
```

**Step 3: Wait for CI, then merge**

```powershell
gh pr merge --merge --delete-branch
git pull origin main
```

---

### Task 9: Update Session Notes

Update `CURRENT_SESSION.md` with:
- Spencer's PRs merged (#48, #49)
- Branch protection updated (enforce_admins, required status check)
- Deploy watcher installed and running
- New workflow: branch → PR → CI → merge → auto-deploy
