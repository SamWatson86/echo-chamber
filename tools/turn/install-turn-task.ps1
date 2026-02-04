$ErrorActionPreference = "Stop"

$taskName = "Echo Chamber TURN"
$runScript = Join-Path $PSScriptRoot "run-turn.ps1"
$ps = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"

$taskCmd = "`"$ps`" -ExecutionPolicy Bypass -File `"$runScript`""

try {
  schtasks /Query /TN $taskName | Out-Null
  schtasks /Delete /TN $taskName /F | Out-Null
} catch {
  # Task may not exist; ignore
}

$action = New-ScheduledTaskAction -Execute $ps -Argument "-ExecutionPolicy Bypass -File `"$runScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null
  Write-Host "Scheduled task installed: $taskName"
} catch {
  Write-Host "Failed to register scheduled task (try running as Administrator)."
  Write-Host "Fallback: tools\\turn\\install-turn-startup.ps1"
  throw
}
