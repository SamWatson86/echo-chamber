$root = Split-Path $PSScriptRoot -Parent
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

$exe = Join-Path $PSScriptRoot "echo-turn.exe"
$pidFile = Join-Path $PSScriptRoot "echo-turn.pid"

# Kill old process if running
if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { try { Stop-Process -Id $old -Force } catch {} }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$out = Join-Path $logsDir "turn.out.log"
$err = Join-Path $logsDir "turn.err.log"
$proc = Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii

# Health check: wait briefly and verify the process is still running
Start-Sleep -Seconds 2
if ($proc.HasExited) {
    Write-Host "TURN server FAILED to start (exit code $($proc.ExitCode))" -ForegroundColor Red
    if (Test-Path $err) { Get-Content $err -Tail 5 | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow } }
    exit 1
}
Write-Host "TURN server started (PID $($proc.Id))" -ForegroundColor Green
