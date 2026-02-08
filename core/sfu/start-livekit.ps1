$root = Split-Path $PSScriptRoot -Parent
$sfuDir = $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

$exe = Join-Path $sfuDir "livekit-server.exe"
$config = Join-Path $sfuDir "livekit.yaml"
$pidFile = Join-Path $sfuDir "livekit-server.pid"

# Kill old process if running
if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { try { Stop-Process -Id $old -Force } catch {} }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

$out = Join-Path $logsDir "livekit.out.log"
$err = Join-Path $logsDir "livekit.err.log"
$proc = Start-Process -FilePath $exe -ArgumentList "--config `"$config`"" -WorkingDirectory $sfuDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
Write-Host "LiveKit server started natively (PID $($proc.Id))" -ForegroundColor Green
