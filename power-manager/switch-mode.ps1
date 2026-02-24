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
