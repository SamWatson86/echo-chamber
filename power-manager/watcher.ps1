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
        Log "[MODE] Switched to ACTIVE (GPU: ${gpuMaxPower}W, CPU: 100%) - $Reason"
    }
    elseif ($Mode -eq "server") {
        powercfg /setactive $serverGuid
        # Throttle GPU power
        if ($nvidiaSmi -and $gpuServerPower -gt 0) {
            try { & $nvidiaSmi -pl $gpuServerPower 2>&1 | Out-Null } catch {}
        }
        Log "[MODE] Switched to SERVER (GPU: ${gpuServerPower}W, CPU: 30%) - $Reason"
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
