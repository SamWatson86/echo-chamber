$root = $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }
$runLog = Join-Path $logsDir "run-core.log"
function Log([string]$msg) {
  $ts = (Get-Date).ToString("s")
  Add-Content -Path $runLog -Value "$ts $msg"
}

Log "SFU retry helper started."
$ErrorActionPreference = "SilentlyContinue"
$tries = 0
while ($tries -lt 120) {
  try {
    docker info | Out-Null
    Push-Location (Join-Path $root "sfu")
    docker compose up -d | Out-Null
    Pop-Location
    Log "SFU started by retry helper."
    exit 0
  } catch {
    # ignore
  }
  Start-Sleep -Seconds 5
  $tries++
}
Log "SFU retry helper timed out."
