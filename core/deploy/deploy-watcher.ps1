# Echo Chamber - Deploy Watcher
# Polls GitHub for new commits on main, runs tests, and deploys.
# Runs as a Windows Scheduled Task.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1 -Once

param([switch]$Once)

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent  # repo root
$coreDir = Join-Path $root "core"
$deployDir = $PSScriptRoot
$configFile = Join-Path $deployDir "deploy-watcher.config.json"
$stateFile = Join-Path $deployDir ".last-deployed-sha"
$logDir = Join-Path $coreDir "logs"
$logFile = Join-Path $logDir "deploy-watcher.log"
$envFile = Join-Path $coreDir "control\.env"

if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Load config
$config = Get-Content $configFile -Raw | ConvertFrom-Json
$pollInterval = $config.pollIntervalSeconds
$healthUrl = $config.healthCheckUrl
$healthTimeout = $config.healthCheckTimeoutSeconds
$maxFailures = $config.maxConsecutiveFailures

$consecutiveFailures = 0

function Write-Log([string]$msg, [string]$level = "INFO") {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$level] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
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
        if ($name) { [Environment]::SetEnvironmentVariable($name, $value, "Process") }
    }
}

function Get-RemoteSha {
    try {
        $output = git -C $root ls-remote origin refs/heads/main 2>&1
        if ($LASTEXITCODE -eq 0 -and $output) {
            return ($output -split "\s")[0]
        }
    } catch {}
    return $null
}

function Get-LastDeployedSha {
    if (Test-Path $stateFile) {
        return (Get-Content $stateFile -Raw).Trim()
    }
    # First run: use current HEAD so we don't re-deploy what's already running
    $sha = git -C $root rev-parse HEAD 2>&1
    if ($LASTEXITCODE -eq 0) {
        [System.IO.File]::WriteAllText($stateFile, $sha.Trim())
        return $sha.Trim()
    }
    return ""
}

function Set-LastDeployedSha([string]$sha) {
    [System.IO.File]::WriteAllText($stateFile, $sha)
}

function Write-DeployEvent([string]$sha, [string]$status, [int]$durationSec, [string]$errorMsg) {
    $historyFile = Join-Path $deployDir "deploy-history.json"
    $shortSha = $sha.Substring(0, [Math]::Min(7, $sha.Length))
    $ts = (Get-Date).ToString("s")

    # Build new entry as JSON string to avoid PowerShell object nesting issues
    $entryJson = '{"sha":"' + $shortSha + '","status":"' + $status + '","timestamp":"' + $ts + '","duration_seconds":' + $durationSec + ',"error":"' + ($errorMsg -replace '"','\"') + '"}'

    # Read existing file as raw text, parse as array of raw JSON entries
    $entries = [System.Collections.ArrayList]@()
    if (Test-Path $historyFile) {
        try {
            $existing = Get-Content $historyFile -Raw | ConvertFrom-Json
            foreach ($e in $existing) {
                $j = $e | ConvertTo-Json -Compress -Depth 2
                [void]$entries.Add($j)
            }
        } catch {}
    }

    # Prepend new entry, cap at 50
    $entries.Insert(0, $entryJson)
    while ($entries.Count -gt 50) { $entries.RemoveAt($entries.Count - 1) }

    # Write clean JSON array
    $json = "[`n  " + ($entries -join ",`n  ") + "`n]"
    [System.IO.File]::WriteAllText($historyFile, $json)
    Write-Log "Deploy event recorded: $status ($shortSha)"
}

function Start-OldProcess {
    $exe = Join-Path $coreDir "target\debug\echo-core-control.exe"
    $pidFile = Join-Path $coreDir "control\core-control.pid"
    $outLog = Join-Path $logDir "core-control.out.log"
    $errLog = Join-Path $logDir "core-control.err.log"
    Load-Env $envFile
    Write-Log "Restarting control plane..."
    $proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc) {
        [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)")
        Write-Log "Control plane restarted (PID $($proc.Id))"
    }
}

function Test-Health {
    try {
        $result = curl.exe -sk --max-time $healthTimeout $healthUrl 2>&1
        if ($result -match '"ok"\s*:\s*true') { return $true }
    } catch {}
    return $false
}

function Run-Tests {
    Write-Log "Running test suite..."
    $bashExe = "C:\Program Files\Git\usr\bin\bash.exe"
    if (!(Test-Path $bashExe)) { $bashExe = "bash" }

    $env:VERIFY_SKIP_RUST = "1"  # We do our own cargo build separately
    Push-Location $root
    $testOutput = & $bashExe "tools/verify/quick.sh" 2>&1 | Out-String
    $testExitCode = $LASTEXITCODE
    Pop-Location

    if ($testExitCode -eq 0) {
        Write-Log "Tests PASSED"
        return $true
    } else {
        Write-Log "Tests FAILED (exit code $testExitCode)" "ERROR"
        # Log first 50 lines of output to avoid huge logs
        $lines = $testOutput -split "`n" | Select-Object -First 50
        foreach ($l in $lines) { Write-Log "  test: $l" "ERROR" }
        return $false
    }
}

function Build-Control {
    Write-Log "Building control plane..."
    Push-Location $coreDir
    try {
        $cargoExe = Join-Path $env:USERPROFILE ".cargo\bin\cargo.exe"
        if (!(Test-Path $cargoExe)) { $cargoExe = "cargo" }

        $buildOutput = & $cargoExe build -p echo-core-control 2>&1 | Out-String
        $buildExitCode = $LASTEXITCODE
        Pop-Location

        if ($buildExitCode -eq 0) {
            Write-Log "Build PASSED"
            return $true
        } else {
            Write-Log "Build FAILED (exit code $buildExitCode)" "ERROR"
            $lines = $buildOutput -split "`n" | Select-Object -First 30
            foreach ($l in $lines) { Write-Log "  cargo: $l" "ERROR" }
            return $false
        }
    } catch {
        Write-Log "Build exception: $_" "ERROR"
        Pop-Location
        return $false
    }
}

function Deploy-BlueGreen {
    # Process already killed and backup already made before Build-Control
    $exe = Join-Path $coreDir "target\debug\echo-core-control.exe"
    $bak = "$exe.bak"
    $pidFile = Join-Path $coreDir "control\core-control.pid"
    $outLog = Join-Path $logDir "core-control.out.log"
    $errLog = Join-Path $logDir "core-control.err.log"

    # Load env vars for the new process
    Load-Env $envFile

    # Start new process
    Write-Log "Starting new control plane..."
    $proc = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc) {
        [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)")
        Write-Log "New control plane started (PID $($proc.Id))"
    } else {
        Write-Log "Failed to start new control plane!" "ERROR"
        return $false
    }

    # Health check with retry
    Write-Log "Waiting for health check..."
    Start-Sleep -Seconds 3
    $healthy = $false
    for ($i = 0; $i -lt $healthTimeout; $i++) {
        if (Test-Health) {
            $healthy = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if ($healthy) {
        Write-Log "Health check PASSED - deploy successful"
        if (Test-Path $bak) { Remove-Item $bak -Force -ErrorAction SilentlyContinue }
        return $true
    } else {
        Write-Log "Health check FAILED - rolling back!" "ERROR"
        # Kill the bad process
        try {
            Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe 2>$null"' -Verb RunAs -Wait -WindowStyle Hidden
        } catch {}
        Start-Sleep -Seconds 2

        # Restore backup
        if (Test-Path $bak) {
            Copy-Item $bak $exe -Force
            Write-Log "Restored backup binary"
            $proc2 = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
            if ($proc2) {
                [System.IO.File]::WriteAllText($pidFile, "$($proc2.Id)")
                Write-Log "Rollback complete - old binary restarted (PID $($proc2.Id))"
            }
        } else {
            Write-Log "No backup binary found - cannot rollback!" "ERROR"
        }
        return $false
    }
}

# --- Main Loop ---
Write-Log "========================================="
Write-Log "Deploy Watcher starting"
Write-Log "Repo root: $root"
Write-Log "Poll interval: ${pollInterval}s"
Write-Log "Max consecutive failures: $maxFailures"
Write-Log "========================================="

do {
    $remoteSha = Get-RemoteSha
    $localSha = Get-LastDeployedSha

    if (-not $remoteSha) {
        Write-Log "Could not fetch remote SHA - network issue?" "WARN"
    } elseif ($remoteSha -ne $localSha) {
        $shortRemote = $remoteSha.Substring(0, 7)
        $shortLocal = $localSha.Substring(0, 7)
        Write-Log "New commit detected: $shortRemote (was: $shortLocal)"

        # Pull
        Write-Log "Pulling latest from origin/main..."
        $pullOutput = git -C $root pull origin main --ff-only 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            Write-Log "git pull failed (exit code $LASTEXITCODE)" "ERROR"
            Write-Log "  $pullOutput" "ERROR"
            $consecutiveFailures++
        } else {
            Write-Log "Pull successful"
            $deployStart = Get-Date

            # Test
            $testsPassed = Run-Tests
            if (-not $testsPassed) {
                Write-Log "Skipping deploy - tests failed" "ERROR"
                $dur = [int]((Get-Date) - $deployStart).TotalSeconds
                Write-DeployEvent $remoteSha "failed" $dur "Tests failed"
                $consecutiveFailures++
            } else {
                # Kill process BEFORE build so cargo can overwrite the .exe
                Write-Log "Stopping control plane for rebuild..."
                $exe = Join-Path $coreDir "target\debug\echo-core-control.exe"
                $bak = "$exe.bak"
                if (Test-Path $exe) {
                    Copy-Item $exe $bak -Force
                    Write-Log "Backed up current binary to .bak"
                }
                try {
                    Start-Process powershell -ArgumentList '-Command "taskkill /F /IM echo-core-control.exe 2>$null"' -Verb RunAs -Wait -WindowStyle Hidden
                } catch {
                    Write-Log "Kill command failed: $_" "WARN"
                }
                Start-Sleep -Seconds 2

                # Build
                $buildPassed = Build-Control
                if (-not $buildPassed) {
                    Write-Log "Build failed - restoring backup and restarting" "ERROR"
                    $dur = [int]((Get-Date) - $deployStart).TotalSeconds
                    Write-DeployEvent $remoteSha "failed" $dur "Build failed"
                    # Restore backup and restart
                    if (Test-Path $bak) {
                        Copy-Item $bak $exe -Force
                        Write-Log "Restored backup binary"
                    }
                    Start-OldProcess
                    $consecutiveFailures++
                } else {
                    # Deploy (process already killed, binary already built)
                    $deployed = Deploy-BlueGreen
                    $dur = [int]((Get-Date) - $deployStart).TotalSeconds
                    if ($deployed) {
                        Set-LastDeployedSha $remoteSha
                        $consecutiveFailures = 0
                        Write-DeployEvent $remoteSha "success" $dur $null
                        Write-Log "Deploy complete: $shortRemote"
                    } else {
                        Write-DeployEvent $remoteSha "rollback" $dur "Health check failed - rolled back"
                        $consecutiveFailures++
                    }
                }
            }
        }

        # Circuit breaker
        if ($consecutiveFailures -ge $maxFailures) {
            Write-Log "CIRCUIT BREAKER: $consecutiveFailures consecutive failures. Stopping." "ERROR"
            Write-Log "Fix the issue and restart the deploy watcher manually." "ERROR"
            break
        }
    }

    if (!$Once) {
        Start-Sleep -Seconds $pollInterval
    }
} while (!$Once)
