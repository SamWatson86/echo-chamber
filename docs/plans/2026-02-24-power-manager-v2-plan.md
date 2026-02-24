# Power Manager v2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace GPU-utilization-based power switching with input-aware polling that detects user activity via GetLastInputInfo, wakes to full power in <10 seconds, and throttles after 60 minutes of idle.

**Architecture:** PowerShell watcher script polls every 10 seconds using Win32 GetLastInputInfo API. Two modes: Active (full power, Echo Gaming plan) and Server (throttled, Echo Server plan). Game process detection acts as safety override — never throttle if a game is running.

**Tech Stack:** PowerShell 5.1, Win32 P/Invoke (user32.dll GetLastInputInfo), Windows Task Scheduler, nvidia-smi

---

### Task 1: Rewrite watcher.ps1 with Input-Aware Polling

**Files:**
- Modify: `power-manager/watcher.ps1` (complete rewrite)

**Step 1: Write the new watcher.ps1**

Replace the entire file with the input-aware version. Key changes:
- Add C# interop type for `GetLastInputInfo` via `Add-Type`
- Replace GPU utilization check with `[UserInput]::GetIdleSeconds()`
- New state machine: SERVER→ACTIVE on input <15s, ACTIVE→SERVER on idle >60min
- Keep game process detection as override (never throttle during games)
- 10-second poll interval instead of 45s
- Startup defaults to ACTIVE mode (user is at PC when booting)
- Rename internal mode labels: "gaming" → "active"

The complete new watcher.ps1:

```powershell
# ═══════════════════════════════════════════════════════════════════
#  Echo Chamber Power Watcher v2
#  Input-aware polling. Detects user activity via GetLastInputInfo.
#  Switches between Active (full power) and Server (low power) modes.
#  Runs as a Scheduled Task (SYSTEM, at startup).
# ═══════════════════════════════════════════════════════════════════

$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"
$gamesPath = Join-Path $root "games.txt"
$logPath = Join-Path $root "watcher.log"

# ── Load config ──
if (-not (Test-Path $configPath)) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [ERROR] config.json not found. Run setup.ps1 first." | Out-File $logPath -Append
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json
$serverGuid      = $config.serverPlanGuid
$gamingGuid       = $config.gamingPlanGuid
$nvidiaSmi        = $config.nvidiaSmi
$gpuMaxPower      = $config.gpuMaxPower
$gpuServerPower   = $config.gpuServerPower
$idleTimeoutSec   = $config.idleTimeoutMin * 60
$pollInterval     = $config.pollIntervalSec
$inputWakeThresh  = $config.inputWakeThresholdSec

# ── Win32 API: GetLastInputInfo ──
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct LASTINPUTINFO {
    public uint cbSize;
    public uint dwTime;
}
public class UserInput {
    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    public static uint GetIdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        GetLastInputInfo(ref lii);
        uint idle = ((uint)Environment.TickCount - lii.dwTime);
        return idle / 1000;
    }
}
"@

# ── Load game process list ──
$gameProcesses = @()
if (Test-Path $gamesPath) {
    $gameProcesses = Get-Content $gamesPath |
        Where-Object { $_ -and $_ -notmatch '^\s*#' } |
        ForEach-Object { $_.Trim().ToLower() -replace '\.exe$', '' } |
        Where-Object { $_ }
}

# ── State ──
$currentMode = "unknown"

# ── Logging ──
function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Out-File $logPath -Append
    # Keep log file under 500KB
    if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 512000) {
        $lines = Get-Content $logPath -Tail 200
        $lines | Set-Content $logPath
    }
}

# ── Game process check ──
function Test-GameRunning {
    if ($gameProcesses.Count -eq 0) { return $false }
    $running = Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $gameProcesses -contains $_.ProcessName.ToLower() }
    return ($null -ne $running -and @($running).Count -gt 0)
}

# ── Switch to a power plan ──
function Switch-Mode {
    param([string]$Mode, [string]$Reason)
    if ($Mode -eq $currentMode) { return }

    if ($Mode -eq "active") {
        powercfg /setactive $gamingGuid
        # Restore full GPU power
        if ($nvidiaSmi -and $gpuMaxPower -gt 0) {
            try { & $nvidiaSmi -pl $gpuMaxPower 2>&1 | Out-Null } catch {}
        }
        Log "[MODE] Switched to ACTIVE (GPU: ${gpuMaxPower}W, CPU: 100%) — $Reason"
    }
    elseif ($Mode -eq "server") {
        powercfg /setactive $serverGuid
        # Throttle GPU power
        if ($nvidiaSmi -and $gpuServerPower -gt 0) {
            try { & $nvidiaSmi -pl $gpuServerPower 2>&1 | Out-Null } catch {}
        }
        Log "[MODE] Switched to SERVER (GPU: ${gpuServerPower}W, CPU: 30%) — $Reason"
    }
    $script:currentMode = $Mode
}

# ── Detect current active plan on startup ──
function Get-CurrentMode {
    $active = powercfg /getactivescheme
    if ($active -match $gamingGuid) { return "active" }
    if ($active -match $serverGuid) { return "server" }
    return "other"
}

# ═══════════════════════════════════════════════════════════════════
#  Main loop
# ═══════════════════════════════════════════════════════════════════
Log "=== Watcher v2 started ==="
Log "Server plan: $serverGuid"
Log "Active plan: $gamingGuid"
Log "Idle timeout: $($config.idleTimeoutMin) min, poll: ${pollInterval}s, wake threshold: ${inputWakeThresh}s"
Log "Game processes monitored: $($gameProcesses.Count)"

$currentMode = Get-CurrentMode
Log "Current mode on startup: $currentMode"

# Default to active on startup (user is at PC when booting)
if ($currentMode -ne "active") {
    Switch-Mode "active" "startup default"
}

while ($true) {
    try {
        $idleSeconds = [UserInput]::GetIdleSeconds()
        $gameRunning = Test-GameRunning

        if ($currentMode -eq "server") {
            # WAKE CHECK: user input detected?
            if ($idleSeconds -lt $inputWakeThresh) {
                Switch-Mode "active" "user input detected (idle ${idleSeconds}s)"
            }
        }
        elseif ($currentMode -eq "active") {
            # IDLE CHECK: been idle long enough AND no game running?
            if ($idleSeconds -ge $idleTimeoutSec -and -not $gameRunning) {
                $idleMin = [math]::Floor($idleSeconds / 60)
                Switch-Mode "server" "idle for ${idleMin} minutes, no game running"
            }
        }
    }
    catch {
        Log "[ERROR] $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $pollInterval
}
```

**Step 2: Verify the script parses correctly**

Run: `powershell.exe -Command "& { $null = [System.Management.Automation.PSParser]::Tokenize((Get-Content 'F:\Codex AI\The Echo Chamber\power-manager\watcher.ps1' -Raw), [ref]$null); Write-Host 'PARSE OK' }"`
Expected: `PARSE OK`

**Step 3: Commit**

```bash
git add power-manager/watcher.ps1
git commit -m "feat: rewrite power watcher with input-aware polling

Replaces GPU utilization detection with GetLastInputInfo Win32 API.
10-second poll, 60-minute idle timeout, <10s wake response."
```

---

### Task 2: Update config.json with New Schema

**Files:**
- Modify: `power-manager/config.json`

**Step 1: Write updated config.json**

```json
{
    "serverPlanGuid": "00980dfc-110e-4fdb-83b6-cc062b856689",
    "gamingPlanGuid": "74a479a6-0367-4a43-a757-f997b65ecfb1",
    "nvidiaSmi": "nvidia-smi",
    "gpuMaxPower": 450,
    "gpuServerPower": 200,
    "idleTimeoutMin": 60,
    "pollIntervalSec": 10,
    "inputWakeThresholdSec": 15
}
```

Removed: `gpuThresholdPct`, `idleCooldownSec`, `checkIntervalSec`.
Added: `idleTimeoutMin`, `pollIntervalSec`, `inputWakeThresholdSec`.

**Step 2: Commit**

```bash
git add power-manager/config.json
git commit -m "chore: update power manager config for v2 schema"
```

---

### Task 3: Update setup.ps1 Config Defaults

**Files:**
- Modify: `power-manager/setup.ps1:193-203` (Step 3: config object)
- Modify: `power-manager/setup.ps1:277-296` (Step 7: activate mode)
- Modify: `power-manager/setup.ps1:288-308` (Done output)

**Step 1: Update the config object in setup.ps1**

Change the `$config` hashtable (around line 194) from:

```powershell
$config = @{
    serverPlanGuid  = $serverGuid
    gamingPlanGuid  = $gamingGuid
    nvidiaSmi       = if ($nvidiaSmi) { $nvidiaSmi } else { "" }
    gpuMaxPower     = $gpuMaxPower
    gpuServerPower  = $gpuServerPower
    gpuThresholdPct = 25
    idleCooldownSec = 180
    checkIntervalSec = 45
}
```

To:

```powershell
$config = @{
    serverPlanGuid       = $serverGuid
    gamingPlanGuid       = $gamingGuid
    nvidiaSmi            = if ($nvidiaSmi) { $nvidiaSmi } else { "" }
    gpuMaxPower          = $gpuMaxPower
    gpuServerPower       = $gpuServerPower
    idleTimeoutMin       = 60
    pollIntervalSec      = 10
    inputWakeThresholdSec = 15
}
```

**Step 2: Update the "How it works" output text**

Change the "Done" section (around line 288) to reflect v2 behavior:

```powershell
Write-Host "  How it works:" -ForegroundColor White
Write-Host "  - Background watcher checks for user activity every 10 seconds" -ForegroundColor Gray
Write-Host "  - Move the mouse or press a key -> full power in under 10 seconds" -ForegroundColor Gray
Write-Host "  - Idle for 60 minutes with no game running -> switches to server mode" -ForegroundColor Gray
Write-Host "  - Echo Chamber runs perfectly in both modes" -ForegroundColor Gray
```

**Step 3: Commit**

```bash
git add power-manager/setup.ps1
git commit -m "chore: update setup.ps1 config defaults for v2 schema"
```

---

### Task 4: Update switch-mode.ps1 Terminology

**Files:**
- Modify: `power-manager/switch-mode.ps1`

**Step 1: Update mode names and help text**

Change the header comment and the "gaming" references to "active":
- Usage line: `.\switch-mode.ps1 active` instead of `.\switch-mode.ps1 gaming`
- Status display: "ACTIVE (full power)" instead of "GAMING (full power)"
- Keep backward compat: accept both "gaming" and "active" as input

```powershell
# ═══════════════════════════════════════════════════════════════════
#  Manual Mode Switch
#  Usage:  .\switch-mode.ps1 server    — Force server mode
#          .\switch-mode.ps1 active    — Force active/full power mode
#          .\switch-mode.ps1           — Show current mode
# ═══════════════════════════════════════════════════════════════════

$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"

if (-not (Test-Path $configPath)) {
    Write-Host "Config not found. Run setup.ps1 first." -ForegroundColor Red
    exit 1
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json

# Show current mode if no argument
if (-not $args[0]) {
    $active = powercfg /getactivescheme
    if ($active -match $config.serverPlanGuid) {
        Write-Host "Current mode: SERVER (low power, CPU 30%)" -ForegroundColor Cyan
    } elseif ($active -match $config.gamingPlanGuid) {
        Write-Host "Current mode: ACTIVE (full power, CPU 100%)" -ForegroundColor Green
    } else {
        Write-Host "Current mode: UNKNOWN (not an Echo plan)" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Usage: .\switch-mode.ps1 [server|active]"
    exit 0
}

$mode = $args[0].ToLower()
$nvidiaSmi = $config.nvidiaSmi

if ($mode -eq "server") {
    powercfg /setactive $config.serverPlanGuid
    if ($nvidiaSmi -and $config.gpuServerPower -gt 0) {
        try { & $nvidiaSmi -pl $config.gpuServerPower 2>&1 | Out-Null } catch {}
    }
    Write-Host "Switched to SERVER mode (CPU 30%, GPU $($config.gpuServerPower)W)" -ForegroundColor Cyan
}
elseif ($mode -eq "active" -or $mode -eq "gaming") {
    powercfg /setactive $config.gamingPlanGuid
    if ($nvidiaSmi -and $config.gpuMaxPower -gt 0) {
        try { & $nvidiaSmi -pl $config.gpuMaxPower 2>&1 | Out-Null } catch {}
    }
    Write-Host "Switched to ACTIVE mode (CPU 100%, GPU $($config.gpuMaxPower)W)" -ForegroundColor Green
}
else {
    Write-Host "Unknown mode '$mode'. Use 'server' or 'active'." -ForegroundColor Red
}
```

**Step 2: Commit**

```bash
git add power-manager/switch-mode.ps1
git commit -m "chore: rename gaming mode to active in switch-mode.ps1"
```

---

### Task 5: Run setup.ps1 to Re-register Watcher

**Files:** None (runtime operation)

**Step 1: Run setup.ps1 as Administrator**

```powershell
Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File "F:\Codex AI\The Echo Chamber\power-manager\setup.ps1"' -Verb RunAs
```

Sam clicks UAC prompt. Check `power-manager/setup.log` for output.

**Step 2: Verify scheduled task exists**

```powershell
Get-ScheduledTask -TaskName 'EchoChamberPowerWatcher' | Select-Object TaskName, State
```

Expected: State = `Running`

**Step 3: Verify watcher is running and in active mode**

```powershell
powercfg /getactivescheme
```

Expected: `Echo Gaming` (active mode, since Sam is at the PC)

Check watcher log:
```powershell
Get-Content 'F:\Codex AI\The Echo Chamber\power-manager\watcher.log' -Tail 10
```

Expected: Lines showing "Watcher v2 started", "Switched to ACTIVE", etc.

---

### Task 6: Final Commit and Cleanup

**Files:**
- Remove: `power-manager/toggle-power.ps1` (unused legacy script)

**Step 1: Delete toggle-power.ps1**

```bash
git rm power-manager/toggle-power.ps1
```

**Step 2: Final commit**

```bash
git commit -m "chore: remove unused toggle-power.ps1"
```

**Step 3: Verify final state**

- Watcher scheduled task running
- Active mode enabled (powercfg shows Echo Gaming)
- Watcher log shows v2 startup
- No parse errors in watcher.log
