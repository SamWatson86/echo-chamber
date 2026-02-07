# Echo Chamber - Push Build to Test PC
# Builds the client in release mode and pushes it to SAM-PC's deploy agent.
#
# Usage: powershell -ExecutionPolicy Bypass -File push-build.ps1 [-SkipBuild] [-Target <ip:port>]

param(
    [string]$Target = "192.168.5.149:8080",
    [switch]$SkipBuild,
    [switch]$LogsOnly,
    [switch]$Restart,
    [switch]$Stop,
    [switch]$Health
)

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$coreDir = Join-Path $root "core"
$exePath = Join-Path $coreDir "target\release\echo-core-client.exe"
$baseUrl = "http://$Target"

function Write-Status([string]$msg, [string]$color = "Cyan") {
    Write-Host "[deploy] " -NoNewline -ForegroundColor DarkGray
    Write-Host $msg -ForegroundColor $color
}

# Health check
if ($Health) {
    Write-Status "Checking agent health..."
    try {
        $resp = Invoke-WebRequest -Uri "$baseUrl/health" -UseBasicParsing -TimeoutSec 5
        $data = $resp.Content | ConvertFrom-Json
        Write-Status "Agent: $($data.agent)" Green
        Write-Status "Client running: $($data.client_running)"
        Write-Status "Client PID: $($data.client_pid)"
        Write-Status "Has exe: $($data.has_exe)"
    } catch {
        Write-Status "Agent not reachable: $_" Red
    }
    return
}

# Logs
if ($LogsOnly) {
    Write-Status "Fetching logs..."
    try {
        $resp = Invoke-WebRequest -Uri "$baseUrl/logs" -UseBasicParsing -TimeoutSec 10
        $data = $resp.Content | ConvertFrom-Json
        Write-Host "`n--- STDOUT ---" -ForegroundColor Yellow
        Write-Host $data.stdout
        Write-Host "`n--- STDERR ---" -ForegroundColor Yellow
        Write-Host $data.stderr
        Write-Host "`n--- AGENT ---" -ForegroundColor Yellow
        Write-Host $data.agent
    } catch {
        Write-Status "Failed to fetch logs: $_" Red
    }
    return
}

# Restart
if ($Restart) {
    Write-Status "Restarting client..."
    try {
        $resp = Invoke-WebRequest -Uri "$baseUrl/restart" -Method POST -UseBasicParsing -TimeoutSec 10
        Write-Status ($resp.Content | ConvertFrom-Json).status Green
    } catch {
        Write-Status "Restart failed: $_" Red
    }
    return
}

# Stop
if ($Stop) {
    Write-Status "Stopping client..."
    try {
        $resp = Invoke-WebRequest -Uri "$baseUrl/stop" -Method POST -UseBasicParsing -TimeoutSec 10
        Write-Status ($resp.Content | ConvertFrom-Json).status Green
    } catch {
        Write-Status "Stop failed: $_" Red
    }
    return
}

# Build + Deploy
if (!$SkipBuild) {
    Write-Status "Building release client..."
    Push-Location $coreDir
    cargo build -p echo-core-client --release 2>&1
    Pop-Location

    if (!(Test-Path $exePath)) {
        Write-Status "Build failed - no exe at $exePath" Red
        return
    }
    $size = (Get-Item $exePath).Length
    Write-Status "Build complete: $([math]::Round($size/1MB, 1)) MB"
}

if (!(Test-Path $exePath)) {
    Write-Status "No release exe found. Run without -SkipBuild first." Red
    return
}

Write-Status "Pushing build to $Target..."
$bytes = [System.IO.File]::ReadAllBytes($exePath)
try {
    $resp = Invoke-WebRequest -Uri "$baseUrl/deploy" -Method POST -Body $bytes -ContentType "application/octet-stream" -UseBasicParsing -TimeoutSec 120
    $data = $resp.Content | ConvertFrom-Json
    Write-Status "Deployed: $($data.status)" Green
} catch {
    Write-Status "Deploy failed: $_" Red
    return
}

# Push config.json so the client knows where the server is
$configFile = Join-Path $PSScriptRoot "config.json"
if (Test-Path $configFile) {
    Write-Status "Pushing config.json..."
    $configBody = Get-Content $configFile -Raw
    try {
        Invoke-WebRequest -Uri "$baseUrl/config" -Method POST -Body $configBody -ContentType "application/json" -UseBasicParsing -TimeoutSec 10 | Out-Null
        Write-Status "Config pushed." Green
    } catch {
        Write-Status "Config push failed (client may use defaults): $_" Yellow
    }
} else {
    Write-Status "No config.json in deploy folder, client will use defaults." Yellow
}
