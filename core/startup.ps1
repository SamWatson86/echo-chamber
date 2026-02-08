# Echo Chamber Auto-Start
# Launched by scheduled task at system boot.
# Starts LiveKit SFU (native), control plane, and TURN server.
# No Docker required.

$root = "F:\Codex AI\The Echo Chamber\core"
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }
$logFile = Join-Path $logsDir "startup.log"

function Log([string]$msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    $line | Out-File $logFile -Append
}

Log "=== Echo Chamber startup ==="

# Load .env
$envFile = Join-Path $root "control\.env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith("#")) { return }
        $parts = $line.Split("=", 2)
        if ($parts.Count -ge 2) {
            $name = $parts[0].Trim()
            $value = $parts[1].Trim()
            if ($name) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
        }
    }
    Log "Loaded .env"
}

# Start LiveKit SFU (native, no Docker)
$lkExe = Join-Path $root "sfu\livekit-server.exe"
$lkConfig = Join-Path $root "sfu\livekit.yaml"
if (Test-Path $lkExe) {
    $lkOut = Join-Path $logsDir "livekit.out.log"
    $lkErr = Join-Path $logsDir "livekit.err.log"
    $lkProc = Start-Process -FilePath $lkExe -ArgumentList "--config `"$lkConfig`"" -WorkingDirectory (Join-Path $root "sfu") -PassThru -WindowStyle Hidden -RedirectStandardOutput $lkOut -RedirectStandardError $lkErr
    $lkPidFile = Join-Path $root "sfu\livekit-server.pid"
    Set-Content -Path $lkPidFile -Value $lkProc.Id -Encoding ascii
    Log "LiveKit SFU started natively (PID $($lkProc.Id))"
} else {
    Log "LiveKit exe not found at $lkExe"
}

# Start control plane
$exe = Join-Path $root "target\debug\echo-core-control.exe"
if (Test-Path $exe) {
    $out = Join-Path $logsDir "core-control.out.log"
    $err = Join-Path $logsDir "core-control.err.log"
    $proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    $pidFile = Join-Path $root "control\core-control.pid"
    Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
    Log "Control plane started (PID $($proc.Id))"
} else {
    Log "Control plane exe not found at $exe"
}

# Start TURN server (native)
$turnExe = Join-Path $root "turn\echo-turn.exe"
if (Test-Path $turnExe) {
    $turnOut = Join-Path $logsDir "turn.out.log"
    $turnErr = Join-Path $logsDir "turn.err.log"
    $turnProc = Start-Process -FilePath $turnExe -WorkingDirectory (Join-Path $root "turn") -PassThru -WindowStyle Hidden -RedirectStandardOutput $turnOut -RedirectStandardError $turnErr
    $turnPidFile = Join-Path $root "turn\echo-turn.pid"
    Set-Content -Path $turnPidFile -Value $turnProc.Id -Encoding ascii
    Log "TURN server started (PID $($turnProc.Id))"
} else {
    Log "TURN server exe not found at $turnExe"
}

Log "=== Startup complete ==="
