$ErrorActionPreference = "Stop"

$runScript = Join-Path $PSScriptRoot "run-turn.ps1"
$startupDir = Join-Path $env:APPDATA "Microsoft\\Windows\\Start Menu\\Programs\\Startup"
$cmdPath = Join-Path $startupDir "Echo-Chamber-TURN.cmd"

$cmd = "@echo off`r`n`"" + "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" + "`" -ExecutionPolicy Bypass -File `"" + $runScript + "`"`r`n"
Set-Content -Path $cmdPath -Value $cmd -Encoding ASCII

Write-Host "Startup shortcut installed: $cmdPath"
