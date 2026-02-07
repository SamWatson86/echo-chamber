# Echo Chamber Deploy Agent - Setup Script for Test PC
# Run this ONCE on SAM-PC (as Administrator) to:
# 1. Create install directory
# 2. Copy agent script
# 3. Add firewall rule
# 4. Install as scheduled task (runs at startup)
#
# Usage (on SAM-PC, as Admin):
#   powershell -ExecutionPolicy Bypass -File setup-agent.ps1

param(
    [string]$InstallDir = "C:\EchoChamber",
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

Write-Host "Echo Chamber Deploy Agent Setup" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

# 1. Create install directory
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Host "[OK] Created $InstallDir" -ForegroundColor Green
} else {
    Write-Host "[OK] $InstallDir already exists" -ForegroundColor Green
}

# 2. Copy agent script
$agentSrc = Join-Path $PSScriptRoot "agent.ps1"
$agentDst = Join-Path $InstallDir "agent.ps1"
if (Test-Path $agentSrc) {
    Copy-Item $agentSrc $agentDst -Force
    Write-Host "[OK] Copied agent.ps1 to $InstallDir" -ForegroundColor Green
} else {
    Write-Host "[!!] agent.ps1 not found next to this script" -ForegroundColor Red
    Write-Host "     Copy agent.ps1 to $InstallDir manually" -ForegroundColor Yellow
}

# 3. Firewall rule
$ruleName = "Echo Chamber Deploy Agent"
$existing = netsh advfirewall firewall show rule name="$ruleName" 2>$null
if ($existing -match "Rule Name") {
    Write-Host "[OK] Firewall rule already exists" -ForegroundColor Green
} else {
    netsh advfirewall firewall add rule name="$ruleName" dir=in action=allow protocol=tcp localport=$Port | Out-Null
    Write-Host "[OK] Firewall rule added (port $Port)" -ForegroundColor Green
}

# 4. Scheduled task
$taskName = "EchoChamberDeployAgent"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[OK] Removed old scheduled task" -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agentDst`" -Port $Port -InstallDir `"$InstallDir`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Echo Chamber deploy agent - receives builds from dev PC" | Out-Null
Write-Host "[OK] Scheduled task installed (runs at startup as SYSTEM)" -ForegroundColor Green

# 5. Start it now
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] Agent started!" -ForegroundColor Green

Write-Host ""
Write-Host "Setup complete! Test from dev PC:" -ForegroundColor Cyan
Write-Host "  curl http://$(hostname):$Port/health" -ForegroundColor White
Write-Host ""
