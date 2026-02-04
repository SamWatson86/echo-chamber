param(
  [switch]$ForceBuild
)

$root = $PSScriptRoot
$logsDir = Join-Path $root "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Path $logsDir | Out-Null }

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
    return $true
  } catch {
    try {
      Start-Process -FilePath "C:\Program Files\Docker\Docker\Docker Desktop.exe" | Out-Null
    } catch {}
  }
  $tries = 0
  while ($tries -lt 30) {
    $tries++
    try {
      docker info | Out-Null
      return $true
    } catch {
      Start-Sleep -Seconds 2
    }
  }
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

# Start SFU
if (Ensure-Docker) {
  Push-Location (Join-Path $root "sfu")
  docker compose up -d | Out-Null
  Pop-Location
} else {
  Write-Host "Docker not ready; SFU not started." -ForegroundColor Yellow
}

# Build + start control
if (Build-Control $controlDir) {
  Start-Control $controlDir | Out-Null
  Write-Host "Core control plane started." -ForegroundColor Green
} else {
  Write-Host "Control plane build failed." -ForegroundColor Red
}
