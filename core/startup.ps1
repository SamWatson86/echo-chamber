# Echo Chamber Auto-Start
# Launched by scheduled task at system boot.
# Starts Docker, LiveKit SFU, and the control plane.

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

# Wait for Docker to be ready (up to 2 minutes)
$dockerReady = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        docker info 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $dockerReady = $true
            Log "Docker ready after $($i * 2)s"
            break
        }
    } catch {}
    Start-Sleep -Seconds 2
}

if (-not $dockerReady) {
    Log "Docker not ready after 2 minutes. Aborting."
    exit 1
}

# Start SFU
Push-Location (Join-Path $root "sfu")
docker compose up -d 2>&1 | Out-Null
Pop-Location
Log "SFU started"

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

Log "=== Startup complete ==="
