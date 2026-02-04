$ErrorActionPreference = "Stop"

$taskName = "Echo Chamber TURN"
try {
  schtasks /Delete /TN $taskName /F | Out-Null
  Write-Host "Scheduled task removed: $taskName"
} catch {
  Write-Host "Scheduled task not found: $taskName"
}
