$ErrorActionPreference = "Stop"

$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$vbsPath = Join-Path $startupDir "Echo Chamber Tray.vbs"

if (Test-Path $vbsPath) {
  Remove-Item -Force $vbsPath
  Write-Host "Removed startup entry:"
  Write-Host "  $vbsPath"
} else {
  Write-Host "Startup entry not found:"
  Write-Host "  $vbsPath"
}

