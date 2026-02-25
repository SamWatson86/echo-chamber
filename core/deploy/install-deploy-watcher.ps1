# Echo Chamber - Deploy Watcher Setup
# Run ONCE as Administrator to install the deploy watcher as a scheduled task.
#
# Usage:
#   Right-click PowerShell > Run as Administrator
#   powershell -ExecutionPolicy Bypass -File install-deploy-watcher.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$watcherPath = Join-Path $root "deploy-watcher.ps1"

# Check elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Right-click PowerShell > Run as administrator, then run this script." -ForegroundColor Yellow
    exit 1
}

if (!(Test-Path $watcherPath)) {
    Write-Host "ERROR: deploy-watcher.ps1 not found at $watcherPath" -ForegroundColor Red
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
    -Description "Polls GitHub for new commits on main, runs tests, and auto-deploys Echo Chamber" | Out-Null

Write-Host ""
Write-Host "[OK] Scheduled task '$taskName' installed" -ForegroundColor Green
Write-Host "  Runs at logon as $currentUser (elevated)" -ForegroundColor Gray
Write-Host "  Polls GitHub every 3 minutes for new commits" -ForegroundColor Gray
Write-Host "  Log: core/logs/deploy-watcher.log" -ForegroundColor Gray
Write-Host ""

# Start it now
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] Deploy watcher is running!" -ForegroundColor Green
Write-Host ""
Write-Host "  To check status:   Get-ScheduledTask EchoChamberDeployWatcher" -ForegroundColor Cyan
Write-Host "  To stop:           Stop-ScheduledTask EchoChamberDeployWatcher" -ForegroundColor Cyan
Write-Host "  To uninstall:      Unregister-ScheduledTask EchoChamberDeployWatcher" -ForegroundColor Cyan
Write-Host ""
