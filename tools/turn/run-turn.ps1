$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envFile)) {
  Write-Host "Missing .env at $envFile"
  exit 1
}

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#")) { return }
  $parts = $line.Split("=", 2)
  if ($parts.Count -lt 2) { return }
  $name = $parts[0].Trim()
  $value = $parts[1].Trim()
  $expanded = [Environment]::ExpandEnvironmentVariables($value)
  if ($name) { [Environment]::SetEnvironmentVariable($name, $expanded, "Process") }
}

$defaultLog = Join-Path $PSScriptRoot "turn.log"
if (-not $env:TURN_LOG_FILE) {
  $env:TURN_LOG_FILE = $defaultLog
}

$binDir = Join-Path $PSScriptRoot "bin"
$exePath = Join-Path $binDir "echo-turn.exe"
if (-not (Test-Path $exePath)) {
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  Push-Location $PSScriptRoot
  try {
    & go build -o $exePath .
  } finally {
    Pop-Location
  }
}

Start-Process -FilePath $exePath -WorkingDirectory $PSScriptRoot
Write-Host "TURN server started."
