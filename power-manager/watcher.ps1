# ═══════════════════════════════════════════════════════════════════
#  Echo Chamber Power Watcher
#  Runs in the background (via Scheduled Task). Monitors GPU usage
#  and game processes. Automatically switches between Echo Server
#  and Echo Gaming power plans.
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
$gpuThreshold     = $config.gpuThresholdPct
$idleCooldown     = $config.idleCooldownSec
$checkInterval    = $config.checkIntervalSec

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
$lastGamingTime = [datetime]::MinValue

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

# ── GPU utilization check ──
function Get-GpuUtilization {
    if (-not $nvidiaSmi) { return 0 }
    try {
        $output = & $nvidiaSmi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>&1
        if ($LASTEXITCODE -eq 0) {
            return [int]($output.Trim())
        }
    } catch {}
    return 0
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
    param([string]$Mode)
    if ($Mode -eq $currentMode) { return }

    if ($Mode -eq "gaming") {
        powercfg /setactive $gamingGuid
        # Restore full GPU power
        if ($nvidiaSmi -and $gpuMaxPower -gt 0) {
            try { & $nvidiaSmi -pl $gpuMaxPower 2>&1 | Out-Null } catch {}
        }
        Log "[MODE] Switched to GAMING (GPU: ${gpuMaxPower}W, CPU: 100%)"
    }
    elseif ($Mode -eq "server") {
        powercfg /setactive $serverGuid
        # Throttle GPU power
        if ($nvidiaSmi -and $gpuServerPower -gt 0) {
            try { & $nvidiaSmi -pl $gpuServerPower 2>&1 | Out-Null } catch {}
        }
        Log "[MODE] Switched to SERVER (GPU: ${gpuServerPower}W, CPU: 30%)"
    }
    $script:currentMode = $Mode
}

# ── Detect current active plan on startup ──
function Get-CurrentMode {
    $active = powercfg /getactivescheme
    if ($active -match $gamingGuid) { return "gaming" }
    if ($active -match $serverGuid) { return "server" }
    return "other"
}

# ═══════════════════════════════════════════════════════════════════
#  Main loop
# ═══════════════════════════════════════════════════════════════════
Log "=== Watcher started ==="
Log "Server plan: $serverGuid"
Log "Gaming plan: $gamingGuid"
Log "GPU threshold: ${gpuThreshold}%, cooldown: ${idleCooldown}s, check: ${checkInterval}s"
Log "Game processes monitored: $($gameProcesses.Count)"

$currentMode = Get-CurrentMode
Log "Current mode on startup: $currentMode"

# Start in server mode if not already in a known mode
if ($currentMode -eq "other") {
    Switch-Mode "server"
}

while ($true) {
    try {
        $gpuUtil = Get-GpuUtilization
        $gameDetected = Test-GameRunning
        $gamingDetected = ($gpuUtil -gt $gpuThreshold) -or $gameDetected

        if ($gamingDetected) {
            $lastGamingTime = Get-Date

            if ($currentMode -ne "gaming") {
                $reason = if ($gameDetected) { "game process" } else { "GPU at ${gpuUtil}%" }
                Log "[DETECT] Gaming activity: $reason"
                Switch-Mode "gaming"
            }
        }
        else {
            # Check if cooldown has passed since last gaming activity
            $idleSeconds = ((Get-Date) - $lastGamingTime).TotalSeconds

            if ($currentMode -eq "gaming" -and $idleSeconds -ge $idleCooldown) {
                Log "[DETECT] Idle for $([math]::Floor($idleSeconds))s, GPU at ${gpuUtil}%"
                Switch-Mode "server"
            }
        }
    }
    catch {
        Log "[ERROR] $($_.Exception.Message)"
    }

    Start-Sleep -Seconds $checkInterval
}
