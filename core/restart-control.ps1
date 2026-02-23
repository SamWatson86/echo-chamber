$root = $PSScriptRoot
$controlDir = Join-Path $root "control"
$envFile = Join-Path $controlDir ".env"

# Load env
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -lt 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    if ($name) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
  }
}

# Kill old control plane
$pidFile = Join-Path $controlDir "core-control.pid"
if (Test-Path $pidFile) {
  $old = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($old) { try { Stop-Process -Id $old -Force } catch {} }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Start control plane
$exe = Join-Path $root "target\debug\echo-core-control.exe"
$logsDir = Join-Path $root "logs"
$out = Join-Path $logsDir "core-control.out.log"
$err = Join-Path $logsDir "core-control.err.log"
$proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Host "Control plane started (PID $($proc.Id))" -ForegroundColor Green
