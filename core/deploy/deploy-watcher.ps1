# Echo Chamber - Deploy Watcher
# Polls GitHub for new commits on main, runs tests, and deploys.
# Runs as a Windows Scheduled Task.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1
#   powershell -ExecutionPolicy Bypass -File deploy-watcher.ps1 -Once

param(
    [switch]$Once,
    # Loads the functions for isolated tests without starting the poll loop or
    # writing repository logs. Production never passes this switch.
    [switch]$NoMain
)

$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent  # repo root
$coreDir = Join-Path $root "core"
$deployDir = $PSScriptRoot
$configFile = Join-Path $deployDir "deploy-watcher.config.json"
$stateFile = Join-Path $deployDir ".last-deployed-sha"
$logDir = Join-Path $coreDir "logs"
$logFile = Join-Path $logDir "deploy-watcher.log"
$envFile = Join-Path $coreDir "control\.env"
$viewerSourceDir = Join-Path $coreDir "viewer"
$viewerRuntimeLib = Join-Path $deployDir "viewer-runtime-lib.ps1"
$productionNetworkLib = Join-Path $deployDir "production-network-lib.ps1"

. $viewerRuntimeLib
if (!(Test-Path -LiteralPath $productionNetworkLib -PathType Leaf)) {
    throw "Required production network guard library is missing: $productionNetworkLib"
}
. $productionNetworkLib

if (!$NoMain -and !(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

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
    if (!$NoMain) {
        Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    }
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
    $proc = $null
    try {
        # A rollback is still a production activation. Never restore a process
        # from a localhost-only or otherwise unsafe production environment.
        Assert-WatcherProductionEnvironment | Out-Null
        Load-Env $envFile
        Write-Log "Restarting control plane..."
        $proc = Start-Process -FilePath $exe -WorkingDirectory $coreDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        if (!$proc) { throw "Start-Process returned no process" }
        [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)")
        Write-Log "Control plane restarted (PID $($proc.Id)); verifying rollback safety..."
        if (-not (Complete-WatcherRollbackActivation -Process $proc)) {
            return $false
        }
        return $true
    }
    catch {
        if ($proc) {
            Stop-TrackedControlProcess $proc | Out-Null
        }
        Write-Log "Control plane restart failed: $_" "ERROR"
        return $false
    }
}

function Test-Health {
    try {
        $result = curl.exe -sk --max-time $healthTimeout $healthUrl 2>&1
        if ($result -match '"ok"\s*:\s*true') { return $true }
    } catch {}
    return $false
}

function Assert-WatcherProductionEnvironment {
    param(
        [string]$EnvFilePath = $envFile,
        # Test-only injection forwarded to the shared guard. Production omits
        # this and reads the exact environment file it is about to activate.
        [scriptblock]$ReadEnvironmentFile
    )

    $guardArgs = @{ EnvFilePath = $EnvFilePath }
    if ($PSBoundParameters.ContainsKey("ReadEnvironmentFile")) {
        $guardArgs.ReadEnvironmentFile = $ReadEnvironmentFile
    }
    $result = Assert-ProductionControlEnvironment @guardArgs
    Write-Log "Production network configuration passed: CORE_BIND=$($result.Bind) CORE_PORT=$($result.Port)"
    return $result
}

function Assert-WatcherProductionIngress {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExpectedControlProcessId,
        # Test-only providers are forwarded only when explicitly supplied.
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider
    )

    $guardArgs = @{ ExpectedControlProcessId = $ExpectedControlProcessId }
    foreach ($providerName in @("ListenerProvider", "DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
        if ($PSBoundParameters.ContainsKey($providerName)) {
            $guardArgs[$providerName] = $PSBoundParameters[$providerName]
        }
    }
    $result = Assert-ProductionControlIngress @guardArgs
    Write-Log "Production ingress passed: PID=$($result.ControlProcessId) listener=$($result.ListenerAddress):$($result.Port) probe=$($result.ProbeAddress)"
    return $result
}

function Wait-ControlHealth {
    Start-Sleep -Seconds 3
    for ($i = 0; $i -lt $healthTimeout; $i++) {
        if (Test-Health) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Assert-WatcherProductionActivation {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ExpectedControlProcessId,
        [scriptblock]$HealthProbe = { Wait-ControlHealth },
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider
    )

    if (-not (& $HealthProbe)) {
        throw "control plane failed its health check"
    }

    $guardArgs = @{ ExpectedControlProcessId = $ExpectedControlProcessId }
    foreach ($providerName in @("ListenerProvider", "DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
        if ($PSBoundParameters.ContainsKey($providerName)) {
            $guardArgs[$providerName] = $PSBoundParameters[$providerName]
        }
    }
    Assert-WatcherProductionIngress @guardArgs | Out-Null
}

function Assert-WatcherLiveProductionIngress {
    param(
        [string]$EnvFilePath = $envFile,
        [scriptblock]$ReadEnvironmentFile,
        [int]$ExpectedControlProcessId = 0,
        [scriptblock]$HealthProbe = { Wait-ControlHealth },
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider
    )

    $environmentArgs = @{ EnvFilePath = $EnvFilePath }
    if ($PSBoundParameters.ContainsKey("ReadEnvironmentFile")) {
        $environmentArgs.ReadEnvironmentFile = $ReadEnvironmentFile
    }
    Assert-WatcherProductionEnvironment @environmentArgs | Out-Null

    $controlProcessId = $ExpectedControlProcessId
    if ($controlProcessId -le 0) {
        $pidFile = Join-Path $coreDir "control\core-control.pid"
        $controlProcessId = 0
        if (-not [int]::TryParse(
                [System.IO.File]::ReadAllText($pidFile).Trim(),
                [ref]$controlProcessId
            ) -or $controlProcessId -le 0) {
            throw "tracked production control PID is invalid"
        }
        $process = Get-Process -Id $controlProcessId -ErrorAction Stop
        if ($process.ProcessName -ne "echo-core-control") {
            throw "tracked production PID $controlProcessId is not echo-core-control"
        }
    }

    $activationArgs = @{
        ExpectedControlProcessId = $controlProcessId
        HealthProbe = $HealthProbe
    }
    foreach ($providerName in @("ListenerProvider", "DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
        if ($PSBoundParameters.ContainsKey($providerName)) {
            $activationArgs[$providerName] = $PSBoundParameters[$providerName]
        }
    }
    Assert-WatcherProductionActivation @activationArgs
    Write-Log "Live production ingress preflight passed for PID $controlProcessId"

    return $controlProcessId
}

function Complete-WatcherRollbackActivation {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Process,
        [scriptblock]$HealthProbe = { Wait-ControlHealth },
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider,
        [ValidateRange(1, 10)]
        [int]$AncillaryProbeAttempts = 3,
        [ValidateRange(0, 60000)]
        [int]$AncillaryProbeDelayMilliseconds = 1000,
        [scriptblock]$RetryDelayProvider = {
            param([int]$Milliseconds)
            if ($Milliseconds -gt 0) {
                Start-Sleep -Milliseconds $Milliseconds
            }
        },
        [scriptblock]$StopProcessProvider = {
            param([object]$TrackedProcess)
            Stop-TrackedControlProcess $TrackedProcess
        }
    )

    try {
        if (-not (& $HealthProbe)) {
            throw "rollback control plane failed its health check"
        }

        $listenerArgs = @{ ExpectedControlProcessId = [int]$Process.Id }
        if ($PSBoundParameters.ContainsKey("ListenerProvider")) {
            $listenerArgs.ListenerProvider = $ListenerProvider
        }
        $listener = Assert-ProductionControlListener @listenerArgs
        Write-Log "Rollback hard listener passed: PID=$($listener.ControlProcessId) listener=$($listener.ListenerAddress):$($listener.Port)"

        $probeArgs = @{}
        foreach ($providerName in @("DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
            if ($PSBoundParameters.ContainsKey($providerName)) {
                $probeArgs[$providerName] = $PSBoundParameters[$providerName]
            }
        }
        $lastProbeError = $null
        for ($attempt = 1; $attempt -le $AncillaryProbeAttempts; $attempt++) {
            try {
                $probe = Assert-ProductionControlLanProbe @probeArgs
                Write-Log "Rollback LAN probe passed: $($probe.ProbeAddress):$($probe.Port)"
                return $true
            }
            catch {
                $lastProbeError = "$($_.Exception.Message)"
                if ($attempt -lt $AncillaryProbeAttempts) {
                    Write-Log "Rollback LAN probe attempt $attempt/$AncillaryProbeAttempts failed; retrying: $lastProbeError" "WARN"
                    & $RetryDelayProvider $AncillaryProbeDelayMilliseconds | Out-Null
                }
            }
        }

        # The route table or a self-LAN probe can be transiently unavailable
        # during recovery. Reassert the hard safety boundary before preserving
        # the known-old process; never trade a degraded rollback for an outage.
        if (-not (& $HealthProbe)) {
            throw "rollback control plane lost health after ancillary ingress probe failure"
        }
        Assert-ProductionControlListener @listenerArgs | Out-Null
        Write-Log "Rollback restored a healthy wildcard-bound control process, but LAN ingress remained unverified after $AncillaryProbeAttempts attempts; leaving the known-old process running. Last probe error: $lastProbeError" "WARN"
        return $true
    }
    catch {
        $failure = "$($_.Exception.Message)"
        $stopped = [bool](& $StopProcessProvider $Process)
        Write-Log "Rollback control activation failed hard safety checks: $failure (stopped=$stopped)" "ERROR"
        return $false
    }
}

function Run-Tests {
    Write-Log "Running test suite..."

    $env:VERIFY_SKIP_RUST = "1"  # We do our own cargo build separately
    # Run npm directly instead of bash to avoid Git Bash CWD issues.
    Push-Location $root
    # Run the repository's real quick suite. The old tools/verify/tests glob
    # matched no files, and Node treated that as a successful zero-test run.
    $testOutput = & npm.cmd run verify:quick 2>&1 | Out-String
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

function Get-ViewerRuntimePreflight {
    param(
        [string]$ConfiguredRuntime,
        [string]$SourceDirectory
    )

    $runtime = $null
    $source = $null
    try {
        if (!$PSBoundParameters.ContainsKey("ConfiguredRuntime")) {
            Load-Env $envFile
            $ConfiguredRuntime = $env:ECHO_CORE_VIEWER_DIR
        }
        if ([string]::IsNullOrWhiteSpace($ConfiguredRuntime)) {
            throw "ECHO_CORE_VIEWER_DIR must name a dedicated viewer runtime directory"
        }
        if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
            $SourceDirectory = $viewerSourceDir
        }
        if (!(Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
            throw "Viewer source directory does not exist: $SourceDirectory"
        }

        $source = [IO.Path]::GetFullPath($SourceDirectory).TrimEnd('\', '/')
        $runtime = if ([IO.Path]::IsPathRooted($ConfiguredRuntime)) {
            [IO.Path]::GetFullPath($ConfiguredRuntime).TrimEnd('\', '/')
        }
        else {
            [IO.Path]::GetFullPath((Join-Path $coreDir $ConfiguredRuntime)).TrimEnd('\', '/')
        }

        if ($runtime -ieq $source) {
            throw "ECHO_CORE_VIEWER_DIR must be different from the checked-out viewer source"
        }
        $sourcePrefix = $source + [IO.Path]::DirectorySeparatorChar
        $runtimePrefix = $runtime + [IO.Path]::DirectorySeparatorChar
        if ($runtime.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $source.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Viewer source and runtime directories must not contain one another"
        }

        # A deploy runtime inside the checkout is not isolated from git pull.
        # Require production snapshots to live completely outside this repo.
        $repo = [IO.Path]::GetFullPath($root).TrimEnd('\', '/')
        $repoPrefix = $repo + [IO.Path]::DirectorySeparatorChar
        if ($runtime -ieq $repo -or
            $runtime.StartsWith($repoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "ECHO_CORE_VIEWER_DIR must be outside the git checkout"
        }

        $runtimeParent = Split-Path -Parent $runtime
        if (!(Test-Path -LiteralPath $runtimeParent -PathType Container)) {
            throw "Viewer runtime parent does not exist: $runtimeParent"
        }
        if ((Test-Path -LiteralPath $runtime) -and
            !(Test-Path -LiteralPath $runtime -PathType Container)) {
            throw "Viewer runtime path exists but is not a directory: $runtime"
        }

        return [pscustomobject]@{
            Succeeded = $true
            RuntimeDirectory = $runtime
            SourceDirectory = $source
            Error = $null
        }
    }
    catch {
        return [pscustomobject]@{
            Succeeded = $false
            RuntimeDirectory = $runtime
            SourceDirectory = $source
            Error = "$_"
        }
    }
}

function Publish-ViewerForDeploy {
    param(
        # Tests pass an isolated directory explicitly. Production omits it and
        # must obtain a value from the control environment.
        [string]$ConfiguredRuntime,
        [string]$SourceDirectory,
        [switch]$AllowRunningControl
    )

    $runtime = $null
    try {
        $preflightArgs = @{}
        if ($PSBoundParameters.ContainsKey("ConfiguredRuntime")) {
            $preflightArgs.ConfiguredRuntime = $ConfiguredRuntime
        }
        if ($PSBoundParameters.ContainsKey("SourceDirectory")) {
            $preflightArgs.SourceDirectory = $SourceDirectory
        }
        $preflight = Get-ViewerRuntimePreflight @preflightArgs
        if (!$preflight.Succeeded) {
            throw $preflight.Error
        }
        $runtime = $preflight.RuntimeDirectory
        $source = $preflight.SourceDirectory

        Write-Log "Publishing complete viewer snapshot to $runtime..."
        $result = Publish-ViewerRuntimeSnapshot `
            -SourceDirectory $source `
            -RuntimeDirectory $runtime `
            -AllowRunningControl:$AllowRunningControl
        Write-Log "Viewer snapshot published: $($result.FileCount) files"
        return [pscustomobject]@{
            Succeeded = $true
            Published = $true
            RuntimeDirectory = $result.RuntimeDirectory
            BackupDirectory = $result.BackupDirectory
            HadRuntime = $result.HadRuntime
            ViewerStateSafe = $true
            Error = $null
        }
    }
    catch {
        $viewerStateSafe = !([bool]$_.Exception.Data["ViewerRollbackFailed"])
        Write-Log "Viewer snapshot publish failed: $_" "ERROR"
        return [pscustomobject]@{
            Succeeded = $false
            Published = $false
            RuntimeDirectory = $runtime
            BackupDirectory = $null
            HadRuntime = $false
            ViewerStateSafe = $viewerStateSafe
            Error = "$_"
        }
    }
}

function Restore-ViewerAfterFailedDeploy($viewerPublish) {
    if (!$viewerPublish -or !$viewerPublish.Published) { return $true }
    $runtime = $viewerPublish.RuntimeDirectory
    $backup = $viewerPublish.BackupDirectory
    $hadRuntime = [bool]$viewerPublish.HadRuntime

    if ($hadRuntime -and
        ([string]::IsNullOrWhiteSpace($backup) -or
         !(Test-Path -LiteralPath $backup -PathType Container))) {
        Write-Log "Viewer rollback unavailable: prior runtime backup is missing" "ERROR"
        return $false
    }

    try {
        if (Test-Path -LiteralPath $runtime) {
            $failed = "$runtime.failed-" + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
            Move-Item -LiteralPath $runtime -Destination $failed
            Write-Log "Retained failed viewer snapshot at $failed"
        }
        if ($hadRuntime) {
            Move-Item -LiteralPath $backup -Destination $runtime
            Write-Log "Restored previous viewer runtime snapshot"
        }
        else {
            Write-Log "Restored prior viewer state (no runtime directory)"
        }
        return $true
    }
    catch {
        Write-Log "Viewer rollback failed: $_" "ERROR"
        return $false
    }
}

function Restore-ControlBinary([string]$Executable, [string]$Backup) {
    if (!(Test-Path -LiteralPath $Backup -PathType Leaf)) {
        Write-Log "Control rollback unavailable: backup binary is missing" "ERROR"
        return $false
    }
    try {
        Copy-Item -LiteralPath $Backup -Destination $Executable -Force
        Write-Log "Restored backup control binary"
        return $true
    }
    catch {
        Write-Log "Control binary rollback failed: $_" "ERROR"
        return $false
    }
}

function Invoke-ReleaseRollback($viewerPublish, [string]$Executable, [string]$Backup, [bool]$NewProcessStopped = $true) {
    if (!$NewProcessStopped) {
        Write-Log "Rollback skipped because the new control process is still running" "ERROR"
        return [pscustomobject]@{
            Succeeded = $false
            NewProcessStopped = $false
            BinaryRestored = $false
            ViewerRestored = $false
            ControlRestarted = $false
        }
    }

    $binaryRestored = Restore-ControlBinary -Executable $Executable -Backup $Backup
    $viewerRestored = Restore-ViewerAfterFailedDeploy $viewerPublish
    $controlRestarted = $false
    if ($binaryRestored -and $viewerRestored) {
        $controlRestarted = Start-OldProcess
    }
    else {
        Write-Log "Control restart skipped because rollback prerequisites failed" "ERROR"
    }

    $succeeded = $NewProcessStopped -and $binaryRestored -and $viewerRestored -and $controlRestarted
    if (!$succeeded) {
        Write-Log "ROLLBACK INCOMPLETE: processStopped=$NewProcessStopped binary=$binaryRestored viewer=$viewerRestored restarted=$controlRestarted" "ERROR"
    }
    return [pscustomobject]@{
        Succeeded = $succeeded
        NewProcessStopped = $NewProcessStopped
        BinaryRestored = $binaryRestored
        ViewerRestored = $viewerRestored
        ControlRestarted = $controlRestarted
    }
}

function New-DeployResult([bool]$Succeeded, [bool]$RollbackAttempted, [bool]$RollbackSucceeded, [string]$ErrorMessage) {
    return [pscustomobject]@{
        Succeeded = $Succeeded
        RollbackAttempted = $RollbackAttempted
        RollbackSucceeded = $RollbackSucceeded
        Error = $ErrorMessage
    }
}

function Stop-TrackedControlProcess($Process) {
    if (!$Process) { return $true }
    try {
        if (Get-Process -Id $Process.Id -ErrorAction SilentlyContinue) {
            Stop-Process -Id $Process.Id -Force
        }
        # Windows PowerShell 5.1 has no Wait-Process -Timeout. Poll the exact
        # PID briefly instead of killing every process with the same image name.
        for ($i = 0; $i -lt 20; $i++) {
            if (!(Get-Process -Id $Process.Id -ErrorAction SilentlyContinue)) {
                return $true
            }
            Start-Sleep -Milliseconds 100
        }
        throw "PID $($Process.Id) is still running"
    }
    catch {
        Write-Log "Failed to stop unhealthy control process: $_" "ERROR"
        return $false
    }
}

function Deploy-BlueGreen($viewerPublish) {
    # Process already killed and backup already made before Build-Control.
    $exe = Join-Path $coreDir "target\debug\echo-core-control.exe"
    $bak = "$exe.bak"
    $pidFile = Join-Path $coreDir "control\core-control.pid"
    $outLog = Join-Path $logDir "core-control.out.log"
    $errLog = Join-Path $logDir "core-control.err.log"

    Write-Log "Starting new control plane..."
    $proc = $null
    try {
        # Re-read and validate the exact file at the last responsible moment.
        # The watcher also checks it before polling, but this closes the window
        # for an unsafe edit while a release is building.
        Assert-WatcherProductionEnvironment | Out-Null
        Load-Env $envFile
        $proc = Start-Process -FilePath $exe -WorkingDirectory $coreDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        if (!$proc) { throw "Start-Process returned no process" }
        [System.IO.File]::WriteAllText($pidFile, "$($proc.Id)")
        Write-Log "New control plane started (PID $($proc.Id))"
    }
    catch {
        $startError = "New control plane failed to start: $_"
        Write-Log $startError "ERROR"
        $newProcessStopped = Stop-TrackedControlProcess $proc
        $rollback = Invoke-ReleaseRollback `
            -viewerPublish $viewerPublish `
            -Executable $exe `
            -Backup $bak `
            -NewProcessStopped $newProcessStopped
        return New-DeployResult -Succeeded $false -RollbackAttempted $true -RollbackSucceeded $rollback.Succeeded -ErrorMessage $startError
    }

    Write-Log "Waiting for health check..."
    try {
        # Loopback health alone is insufficient: the production process must
        # own the wildcard listener and answer on the host LAN IP.
        Assert-WatcherProductionActivation -ExpectedControlProcessId $proc.Id
        Write-Log "Health and production ingress checks PASSED - deploy successful"
        if (Test-Path -LiteralPath $bak) {
            Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
        }
        return New-DeployResult -Succeeded $true -RollbackAttempted $false -RollbackSucceeded $false -ErrorMessage $null
    }
    catch {
        $healthError = "New control plane failed its production activation guard: $_"
    }
    Write-Log "$healthError - rolling back" "ERROR"
    $newProcessStopped = Stop-TrackedControlProcess $proc

    $rollback = Invoke-ReleaseRollback `
        -viewerPublish $viewerPublish `
        -Executable $exe `
        -Backup $bak `
        -NewProcessStopped $newProcessStopped
    return New-DeployResult -Succeeded $false -RollbackAttempted $true -RollbackSucceeded $rollback.Succeeded -ErrorMessage $healthError
}

# --- Main Loop ---
if (!$NoMain) {
    Write-Log "========================================="
    Write-Log "Deploy Watcher starting"
    Write-Log "Repo root: $root"
    Write-Log "Poll interval: ${pollInterval}s"
    Write-Log "Max consecutive failures: $maxFailures"
    Write-Log "========================================="

    # These gates MUST run before Get-RemoteSha or git pull. Validate the live
    # process, not only its environment: a healthy loopback-only listener would
    # otherwise survive preflight while remote users remain locked out.
    try {
        Assert-WatcherLiveProductionIngress | Out-Null
    }
    catch {
        Write-Log "CIRCUIT BREAKER: live production ingress preflight failed" "ERROR"
        Write-Log "$_" "ERROR"
        Write-Log "No remote poll or git pull was attempted" "ERROR"
        exit 1
    }

    $startupViewerPreflight = Get-ViewerRuntimePreflight
    if (!$startupViewerPreflight.Succeeded) {
        Write-Log "CIRCUIT BREAKER: viewer runtime preflight failed" "ERROR"
        Write-Log $startupViewerPreflight.Error "ERROR"
        Write-Log "No remote poll or git pull was attempted" "ERROR"
        exit 1
    }
    Write-Log "Viewer runtime preflight passed: $($startupViewerPreflight.RuntimeDirectory)"

    do {
    $remoteSha = Get-RemoteSha
    $localSha = Get-LastDeployedSha

    if (-not $remoteSha) {
        Write-Log "Could not fetch remote SHA - network issue?" "WARN"
    } elseif ($remoteSha -ne $localSha) {
        $shortRemote = $remoteSha.Substring(0, 7)
        $shortLocal = $localSha.Substring(0, 7)
        Write-Log "New commit detected: $shortRemote (was: $shortLocal)"

        # The watcher can remain resident for days. Recheck the full live path
        # before every release transaction so neither an environment edit nor
        # a degraded listener/probe can reach git pull or production mutation.
        try {
            Assert-WatcherLiveProductionIngress | Out-Null
        }
        catch {
            Write-Log "CIRCUIT BREAKER: live production ingress pre-mutation check failed" "ERROR"
            Write-Log "$_" "ERROR"
            Write-Log "No git pull or production mutation was attempted" "ERROR"
            exit 1
        }

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
                # Tests can take long enough for live state or the environment
                # to change. Recheck at the last responsible moment, before
                # copying artifacts or stopping any production process.
                try {
                    Assert-WatcherLiveProductionIngress | Out-Null
                }
                catch {
                    Write-Log "CIRCUIT BREAKER: final live production ingress check failed" "ERROR"
                    Write-Log "$_" "ERROR"
                    Write-Log "No production artifact or process was mutated" "ERROR"
                    exit 1
                }

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
                    $binaryRestored = Restore-ControlBinary -Executable $exe -Backup $bak
                    if ($binaryRestored) {
                        Start-OldProcess | Out-Null
                    }
                    $consecutiveFailures++
                } else {
                    # Publish the complete viewer while control is stopped, then
                    # start the matching binary. A failed health check rolls both
                    # halves back as one release unit.
                    $viewerPublish = Publish-ViewerForDeploy
                    if (-not $viewerPublish.Succeeded) {
                        Write-Log "Viewer publish failed - restoring prior control binary" "ERROR"
                        $binaryRestored = Restore-ControlBinary -Executable $exe -Backup $bak
                        $controlRestarted = $false
                        if ($binaryRestored -and $viewerPublish.ViewerStateSafe) {
                            $controlRestarted = Start-OldProcess
                        }
                        elseif (!$viewerPublish.ViewerStateSafe) {
                            Write-Log "Control restart skipped because viewer publish rollback was incomplete" "ERROR"
                        }
                        $dur = [int]((Get-Date) - $deployStart).TotalSeconds
                        $recoveryMessage = if ($binaryRestored -and $viewerPublish.ViewerStateSafe -and $controlRestarted) {
                            "Viewer snapshot publish failed; prior control restored"
                        }
                        else {
                            "Viewer snapshot publish failed; recovery incomplete (viewerSafe=$($viewerPublish.ViewerStateSafe) binary=$binaryRestored restarted=$controlRestarted)"
                        }
                        Write-DeployEvent $remoteSha "failed" $dur $recoveryMessage
                        $consecutiveFailures++
                    } else {
                        # Deploy (process already killed, binary and viewer already prepared)
                        $deployResult = Deploy-BlueGreen $viewerPublish
                        $dur = [int]((Get-Date) - $deployStart).TotalSeconds
                        if ($deployResult.Succeeded) {
                            Set-LastDeployedSha $remoteSha
                            $consecutiveFailures = 0
                            Write-DeployEvent $remoteSha "success" $dur $null
                            Write-Log "Deploy complete: $shortRemote"
                        } elseif ($deployResult.RollbackSucceeded) {
                            Write-DeployEvent $remoteSha "rollback" $dur "$($deployResult.Error); binary and viewer rolled back"
                            $consecutiveFailures++
                        } else {
                            Write-DeployEvent $remoteSha "failed" $dur "$($deployResult.Error); rollback incomplete"
                            Write-Log "Deploy failed and rollback was incomplete; manual recovery is required" "ERROR"
                            $consecutiveFailures++
                        }
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
}
