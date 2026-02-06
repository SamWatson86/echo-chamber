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

function Ensure-Docker {
  try {
    docker info | Out-Null
    Log "Docker ready."
    return $true
  } catch {
    try {
      Start-Process -FilePath "C:\Program Files\Docker\Docker\Docker Desktop.exe" | Out-Null
      Log "Docker Desktop start requested."
    } catch {}
  }
  $tries = 0
  while ($tries -lt 30) {
    $tries++
    try {
      docker info | Out-Null
      Log "Docker ready after retry."
      return $true
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  Log "Docker not ready after initial retries."
  return $false
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

# Start SFU
if (Ensure-Docker) {
  Push-Location (Join-Path $root "sfu")
  docker compose up -d | Out-Null
  Pop-Location
  Log "SFU started via docker compose."
} else {
  Write-Host "Docker not ready; SFU not started." -ForegroundColor Yellow
  $retry = Join-Path $root "retry-sfu.ps1"
  if (Test-Path $retry) {
    Start-Process -FilePath "powershell" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$retry`"" -WindowStyle Hidden | Out-Null
    Log "SFU retry helper launched."
  } else {
    Log "SFU retry helper missing."
  }
}

# Build + start control
if (Build-Control $controlDir) {
  Start-Control $controlDir | Out-Null
  Write-Host "Core control plane started." -ForegroundColor Green
} else {
  Write-Host "Control plane build failed." -ForegroundColor Red
}
