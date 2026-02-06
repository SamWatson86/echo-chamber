$root = $PSScriptRoot
$controlDir = Join-Path $root "control"
$pidFile = Join-Path $controlDir "core-control.pid"
if (Test-Path $pidFile) {
  $procId = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($procId) { try { Stop-Process -Id $procId -Force } catch {} }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

try {
  Push-Location (Join-Path $root "sfu")
  docker compose down | Out-Null
  Pop-Location
} catch {}

Write-Host "Core services stopped." -ForegroundColor Yellow
