param(
  [switch]$ForceBuild
)

$root = $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }
$runLog = Join-Path $logsDir "run-core.log"
function Log([string]$msg) {
  $ts = (Get-Date).ToString("s")
  Add-Content -Path $runLog -Value "$ts $msg"
}

function Load-Env([string]$path) {
  if (!(Test-Path $path)) { return }
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -lt 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ($name) { [Environment]::SetEnvironmentVariable($name, $expanded, "Process") }
  }
}


function Build-Control([string]$controlDir) {
  $exe = Join-Path $root "target\debug\echo-core-control.exe"
  if (!$ForceBuild -and (Test-Path $exe)) { return $true }

  $cargoExe = "$env:USERPROFILE\.cargo\bin\cargo.exe"
  if (!(Test-Path $cargoExe)) { Write-Host "cargo not found." -ForegroundColor Yellow; return $false }

  $vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
  if (Test-Path $vcvars) {
    $cmd = @"
call \"$vcvars\"
cd /d \"$root\"
\"%USERPROFILE%\.cargo\bin\cargo.exe\" build -p echo-core-control
"@
    $tmp = Join-Path $root ".tmp-build-control.cmd"
    Set-Content -Path $tmp -Value $cmd -Encoding ascii
    cmd /c $tmp
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  } else {
    Push-Location $root
    & $cargoExe build -p echo-core-control
    Pop-Location
  }

  return (Test-Path $exe)
}

function Start-Control([string]$controlDir) {
  $exe = Join-Path $root "target\debug\echo-core-control.exe"
  if (!(Test-Path $exe)) { Write-Host "Control plane exe not found." -ForegroundColor Yellow; return $false }

  $pidFile = Join-Path $controlDir "core-control.pid"
  if (Test-Path $pidFile) {
    $old = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($old) { try { Stop-Process -Id $old -Force } catch {} }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  }

  $out = Join-Path $logsDir "core-control.out.log"
  $err = Join-Path $logsDir "core-control.err.log"
  $proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
  Set-Content -Path $pidFile -Value $proc.Id -Encoding ascii
  return $true
}

# Ensure env
$controlDir = Join-Path $root "control"
$envFile = Join-Path $controlDir ".env"
if (!(Test-Path $envFile)) {
  $example = Join-Path $controlDir ".env.example"
  if (Test-Path $example) {
    Copy-Item -Path $example -Destination $envFile -Force
    Write-Host "Created $envFile from example. Update values before use." -ForegroundColor Yellow
  }
}

Load-Env $envFile

# Ensure TLS certs if configured
if ($env:CORE_TLS_SELF_SIGNED) {
  # No file generation needed; cert is generated in-memory by the control server.
} elseif ($env:CORE_TLS_CERT -and $env:CORE_TLS_KEY) {
  $certPath = Join-Path $root $env:CORE_TLS_CERT
  $keyPath = Join-Path $root $env:CORE_TLS_KEY
  if (!(Test-Path $certPath) -or !(Test-Path $keyPath)) {
    $gen = Join-Path $root "control\generate-cert.ps1"
    if (Test-Path $gen) {
      powershell -ExecutionPolicy Bypass -File $gen | Out-Null
    }
  }
}

# Start LiveKit SFU (native, no Docker)
$lkExe = Join-Path $root "sfu\livekit-server.exe"
$lkConfig = Join-Path $root "sfu\livekit.yaml"
$lkPidFile = Join-Path $root "sfu\livekit-server.pid"
if (Test-Path $lkExe) {
  if (Test-Path $lkPidFile) {
    $oldLk = Get-Content $lkPidFile -ErrorAction SilentlyContinue
    if ($oldLk) { try { Stop-Process -Id $oldLk -Force } catch {} }
    Remove-Item $lkPidFile -Force -ErrorAction SilentlyContinue
  }
  $lkOut = Join-Path $logsDir "livekit.out.log"
  $lkErr = Join-Path $logsDir "livekit.err.log"
  $lkProc = Start-Process -FilePath $lkExe -ArgumentList "--config `"$lkConfig`"" -WorkingDirectory (Join-Path $root "sfu") -PassThru -WindowStyle Hidden -RedirectStandardOutput $lkOut -RedirectStandardError $lkErr
  Set-Content -Path $lkPidFile -Value $lkProc.Id -Encoding ascii
  Write-Host "LiveKit SFU started natively (PID $($lkProc.Id))." -ForegroundColor Green
  Log "LiveKit SFU started natively (PID $($lkProc.Id))."
} else {
  Write-Host "LiveKit exe not found at $lkExe" -ForegroundColor Red
  Log "LiveKit exe not found at $lkExe"
}

# Build + start control
if (Build-Control $controlDir) {
  Start-Control $controlDir | Out-Null
  Write-Host "Core control plane started." -ForegroundColor Green
} else {
  Write-Host "Control plane build failed." -ForegroundColor Red
}

# Start TURN server (native, outside Docker)
$turnExe = Join-Path $root "turn\echo-turn.exe"
if (Test-Path $turnExe) {
  # Kill old TURN process if running
  $turnPidFile = Join-Path $root "turn\echo-turn.pid"
  if (Test-Path $turnPidFile) {
    $oldTurn = Get-Content $turnPidFile -ErrorAction SilentlyContinue
    if ($oldTurn) { try { Stop-Process -Id $oldTurn -Force } catch {} }
    Remove-Item $turnPidFile -Force -ErrorAction SilentlyContinue
  }
  $turnOut = Join-Path $logsDir "turn.out.log"
  $turnErr = Join-Path $logsDir "turn.err.log"
  $turnProc = Start-Process -FilePath $turnExe -WorkingDirectory (Join-Path $root "turn") -PassThru -WindowStyle Hidden -RedirectStandardOutput $turnOut -RedirectStandardError $turnErr
  Set-Content -Path $turnPidFile -Value $turnProc.Id -Encoding ascii
  Write-Host "TURN server started (PID $($turnProc.Id))." -ForegroundColor Green
  Log "TURN server started (PID $($turnProc.Id))."
} else {
  Write-Host "TURN server exe not found. Skipping." -ForegroundColor Yellow
  Log "TURN server exe not found at $turnExe"
}
