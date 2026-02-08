$root = $PSScriptRoot
$controlDir = Join-Path $root "control"
$pidFile = Join-Path $controlDir "core-control.pid"
if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($procId) { try { Stop-Process -Id $procId -Force } catch {} }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Stop TURN server
$turnPidFile = Join-Path $root "turn\echo-turn.pid"
if (Test-Path $turnPidFile) {
  $turnPid = Get-Content $turnPidFile -ErrorAction SilentlyContinue
  if ($turnPid) { try { Stop-Process -Id $turnPid -Force } catch {} }
  Remove-Item $turnPidFile -Force -ErrorAction SilentlyContinue
}

# Stop LiveKit SFU (native)
$lkPidFile = Join-Path $root "sfu\livekit-server.pid"
if (Test-Path $lkPidFile) {
  $lkPid = Get-Content $lkPidFile -ErrorAction SilentlyContinue
  if ($lkPid) { try { Stop-Process -Id $lkPid -Force } catch {} }
  Remove-Item $lkPidFile -Force -ErrorAction SilentlyContinue
}

Write-Host "Core services stopped." -ForegroundColor Yellow
