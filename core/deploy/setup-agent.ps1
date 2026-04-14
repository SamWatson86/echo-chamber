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
$clientTaskName = "EchoChamberClient"
$exePath = Join-Path $InstallDir "echo-core-client.exe"

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

# 4. Scheduled task for the deploy agent
# The live agent should support both the sandbox binary under C:\EchoChamber
# and the normal installed app under LocalAppData. The HTTP endpoints are used
# by the dev PC to launch the correct path explicitly instead of guessing.
$taskName = "EchoChamberDeployAgent"
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "[OK] Removed old scheduled task" -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agentDst`" -Port $Port -InstallDir `"$InstallDir`""
$triggers = @(
    New-ScheduledTaskTrigger -AtStartup
    New-ScheduledTaskTrigger -AtLogOn
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description "Echo Chamber deploy agent - receives builds from dev PC" | Out-Null
Write-Host "[OK] Scheduled task installed (runs at startup + logon as SYSTEM)" -ForegroundColor Green

# 5. Scheduled task for the actual Echo client in the interactive user session
$existingClientTask = Get-ScheduledTask -TaskName $clientTaskName -ErrorAction SilentlyContinue
if ($existingClientTask) {
    Unregister-ScheduledTask -TaskName $clientTaskName -Confirm:$false
    Write-Host "[OK] Removed old client launch task" -ForegroundColor Yellow
}

$clientAction = New-ScheduledTaskAction -Execute $exePath -WorkingDirectory $InstallDir
$clientSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$clientPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$clientTask = New-ScheduledTask -Action $clientAction -Principal $clientPrincipal -Settings $clientSettings
Register-ScheduledTask -TaskName $clientTaskName -InputObject $clientTask -Description "Echo Chamber desktop client - launched on demand in the interactive user session" | Out-Null
Write-Host "[OK] Client launch task installed for user $env:USERNAME" -ForegroundColor Green

# 6. Start it now
Start-ScheduledTask -TaskName $taskName
Write-Host "[OK] Agent started!" -ForegroundColor Green

Write-Host ""
Write-Host "Setup complete! Test from dev PC:" -ForegroundColor Cyan
Write-Host "  curl http://$(hostname):$Port/health" -ForegroundColor White
Write-Host ""
