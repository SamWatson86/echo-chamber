$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$startupDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$trayScript = Join-Path $repoRoot "tools\echo-tray.ps1"
$psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

if (!(Test-Path $startupDir)) {
  New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
}

# Remove legacy startup entry that shows a console window.
$legacyTurnCmd = Join-Path $startupDir "Echo-Chamber-TURN.cmd"
if (Test-Path $legacyTurnCmd) {
  Remove-Item -Force $legacyTurnCmd
}

$vbsPath = Join-Path $startupDir "Echo Chamber Tray.vbs"
$scriptPath = (Resolve-Path $trayScript).Path

$vbs = @"
Set WshShell = CreateObject("WScript.Shell")
cmd = """" & "$psExe" & """ -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File """" & "$scriptPath" & """ -AutoStart"
WshShell.Run cmd, 0, False
Set WshShell = Nothing
"@

Set-Content -Path $vbsPath -Value $vbs -Encoding ascii
Write-Host "Installed silent startup entry:"
Write-Host "  $vbsPath"

