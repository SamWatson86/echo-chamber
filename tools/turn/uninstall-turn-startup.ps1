$ErrorActionPreference = "Stop"

$startupDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Startup"
$cmdPath = Join-Path $startupDir "Echo-Chamber-TURN.cmd"

if (Test-Path $cmdPath) {
  Remove-Item $cmdPath -Force
  Write-Host "Startup shortcut removed: $cmdPath"
} else {
  Write-Host "Startup shortcut not found: $cmdPath"
}
