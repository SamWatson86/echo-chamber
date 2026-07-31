$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "viewer-runtime-lib.ps1")

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw "Assertion failed: $Message" }
}

# Load the watcher's actual helper functions without entering its poll loop,
# creating production logs, or starting/stopping any process.
. (Join-Path $scriptDir "deploy-watcher.ps1") -NoMain

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("echo-viewer-runtime-test-" + [Guid]::NewGuid().ToString("N"))
$source = Join-Path $testRoot "source"
$runtime = Join-Path $testRoot "runtime"
New-Item -ItemType Directory -Path $source, $runtime | Out-Null

try {
    # Exercise the watcher's production-only adapters with isolated providers.
    # This proves the standard deploy path forwards the exact environment file
    # and expected process ID to the shared guard without inspecting live state.
    $networkEnvFile = Join-Path $testRoot "production.env"
    Set-Content -LiteralPath $networkEnvFile -Value @(
        "CORE_BIND=0.0.0.0",
        "CORE_PORT=9443"
    )
    $networkEnvironment = Assert-WatcherProductionEnvironment -EnvFilePath $networkEnvFile
    Assert-True ($networkEnvironment.Bind -eq "0.0.0.0") "watcher forwards its production environment to the network guard"
    Assert-True ($networkEnvironment.Port -eq 9443) "watcher production environment requires the public control port"

    $networkIngress = Assert-WatcherProductionIngress `
        -ExpectedControlProcessId 4242 `
        -ListenerProvider {
            param([int]$Port)
            [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = $Port; OwningProcess = 4242 }
        } `
        -DefaultRouteLanIPv4Provider { "192.168.50.10" } `
        -TcpProbeProvider {
            param([string]$Address, [int]$Port)
            ($Address -eq "192.168.50.10" -and $Port -eq 9443)
        }
    Assert-True ($networkIngress.ControlProcessId -eq 4242) "watcher forwards the activated control PID to the ingress guard"
    Assert-True ($networkIngress.ProbeAddress -eq "192.168.50.10") "watcher ingress guard probes a LAN address"

    Assert-WatcherProductionActivation `
        -ExpectedControlProcessId 4242 `
        -HealthProbe { $true } `
        -ListenerProvider {
            param([int]$Port)
            [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = $Port; OwningProcess = 4242 }
        } `
        -DefaultRouteLanIPv4Provider { "192.168.50.10" } `
        -TcpProbeProvider { $true }

    $failedPostActivationRejected = $false
    try {
        Assert-WatcherProductionActivation `
            -ExpectedControlProcessId 4242 `
            -HealthProbe { $true } `
            -ListenerProvider {
                param([int]$Port)
                [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = $Port; OwningProcess = 4242 }
            } `
            -DefaultRouteLanIPv4Provider { "192.168.50.10" } `
            -TcpProbeProvider { $true }
    }
    catch { $failedPostActivationRejected = $true }
    Assert-True $failedPostActivationRejected "watcher rejects a healthy localhost-only post-activation listener"

    $liveIngress = Assert-WatcherLiveProductionIngress `
        -EnvFilePath $networkEnvFile `
        -ExpectedControlProcessId 4242 `
        -HealthProbe { $true } `
        -ListenerProvider {
            param([int]$Port)
            [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = $Port; OwningProcess = 4242 }
        } `
        -DefaultRouteLanIPv4Provider { "192.168.50.10" } `
        -TcpProbeProvider { $true }
    Assert-True ($liveIngress -eq 4242) "pre-mutation preflight validates environment, health, listener, and LAN ingress"

    # A restored known-old process must survive a transient route/LAN probe
    # failure once its environment, health, and wildcard listener are safe.
    $script:rollbackStopCount = 0
    $script:rollbackRouteCount = 0
    $script:rollbackProbeCount = 0
    $script:rollbackRetryDelayCount = 0
    $degradedRollbackKeptRunning = Complete-WatcherRollbackActivation `
        -Process ([pscustomobject]@{ Id = 4242 }) `
        -HealthProbe { $true } `
        -ListenerProvider {
            param([int]$Port)
            [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = $Port; OwningProcess = 4242 }
        } `
        -DefaultRouteLanIPv4Provider {
            $script:rollbackRouteCount++
            if ($script:rollbackRouteCount -ne 2) { throw "route temporarily unavailable" }
            "192.168.50.10"
        } `
        -TcpProbeProvider {
            $script:rollbackProbeCount++
            $false
        } `
        -AncillaryProbeAttempts 3 `
        -AncillaryProbeDelayMilliseconds 1 `
        -RetryDelayProvider {
            param([int]$Milliseconds)
            $script:rollbackRetryDelayCount++
        } `
        -StopProcessProvider {
            param([object]$TrackedProcess)
            $script:rollbackStopCount++
            $true
        }
    Assert-True $degradedRollbackKeptRunning "ancillary LAN probe failure does not fail a hard-safe rollback"
    Assert-True ($script:rollbackRouteCount -eq 3) "rollback default-route lookup retries are bounded"
    Assert-True ($script:rollbackProbeCount -eq 1) "rollback also tolerates a LAN TCP failure within the bounded attempts"
    Assert-True ($script:rollbackRetryDelayCount -eq 2) "rollback waits only between bounded ancillary attempts"
    Assert-True ($script:rollbackStopCount -eq 0) "ancillary LAN probe failure does not kill the known-old process"

    $script:rollbackStopCount = 0
    $script:rollbackProbeCount = 0
    $loopbackRollbackRejected = Complete-WatcherRollbackActivation `
        -Process ([pscustomobject]@{ Id = 4242 }) `
        -HealthProbe { $true } `
        -ListenerProvider {
            param([int]$Port)
            [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = $Port; OwningProcess = 4242 }
        } `
        -DefaultRouteLanIPv4Provider {
            $script:rollbackProbeCount++
            "192.168.50.10"
        } `
        -TcpProbeProvider { $true } `
        -StopProcessProvider {
            param([object]$TrackedProcess)
            $script:rollbackStopCount++
            $true
        }
    Assert-True (!$loopbackRollbackRejected) "a loopback-only rollback listener fails hard safety"
    Assert-True ($script:rollbackStopCount -eq 1) "a loopback-only rollback process is stopped"
    Assert-True ($script:rollbackProbeCount -eq 0) "hard listener safety fails before ancillary probes"

    $deployDefinition = (Get-Command Deploy-BlueGreen).Definition
    $rollbackStartDefinition = (Get-Command Start-OldProcess).Definition
    Assert-True ($deployDefinition.Contains("Assert-WatcherProductionEnvironment")) "new deployment rechecks production config immediately before activation"
    Assert-True ($deployDefinition.Contains("Assert-WatcherProductionActivation")) "new deployment verifies production ingress after activation"
    Assert-True ($rollbackStartDefinition.Contains("Assert-WatcherProductionEnvironment")) "rollback restart validates production config before activation"
    Assert-True ($rollbackStartDefinition.Contains("Complete-WatcherRollbackActivation")) "rollback delegates the keep-or-stop decision to the rollback safety guard"

    $watcherScript = Get-Content -Raw -LiteralPath (Join-Path $scriptDir "deploy-watcher.ps1")
    $liveIngressReferences = [regex]::Matches(
        $watcherScript,
        [regex]::Escape("Assert-WatcherLiveProductionIngress")
    ).Count
    Assert-True ($liveIngressReferences -ge 4) "watcher defines and invokes full live ingress at startup, before pull, and immediately before production mutation"

    Set-Content -LiteralPath $networkEnvFile -Value @(
        "CORE_BIND=127.0.0.1",
        "CORE_PORT=9443"
    )
    $unsafeNetworkRejected = $false
    try { Assert-WatcherProductionEnvironment -EnvFilePath $networkEnvFile | Out-Null }
    catch { $unsafeNetworkRejected = $true }
    Assert-True $unsafeNetworkRejected "watcher fails closed on a localhost-only production environment"

    $requiredFiles = @(
        "app.js", "state.js", "settings.js", "urls.js", "debug.js",
        "identity.js", "auth.js", "connect.js", "room-status.js",
        "audio-routing.js", "media-controls.js", "participants.js", "chat.js",
        "soundboard.js", "jam-session-state.js", "jam.js", "style.css",
        "jam.css", "clubhouse-shell.css", "layout-policy.js", "ui-shell.js",
        "livekit-client.umd.js", "rnnoise-processor.js",
        "rnnoise.wasm", "rnnoise_simd.wasm", "ultrainstinct.gif"
    )
    Set-Content -LiteralPath (Join-Path $source "index.html") -Value '<link rel="stylesheet" href="style.css?v=source"><link rel="stylesheet" href="clubhouse-shell.css?v=source"><script src="layout-policy.js?v=source"></script><script src="ui-shell.js?v=source"></script><script src="jam.js?v=source"></script>' -NoNewline
    foreach ($requiredFile in $requiredFiles) {
        Set-Content -LiteralPath (Join-Path $source $requiredFile) -Value ("fixture-" + $requiredFile) -NoNewline
    }
    Set-Content -LiteralPath (Join-Path $source "jam.js") -Value 'var JAM_PROTOCOL_VERSION = 3;' -NoNewline
    Set-Content -LiteralPath (Join-Path $source "jam-session-state.js") -Value 'state-v3' -NoNewline
    New-Item -ItemType Directory -Path (Join-Path $source "assets") | Out-Null
    Set-Content -LiteralPath (Join-Path $source "assets\tone.bin") -Value 'audio' -NoNewline

    foreach ($dynamicAsset in @("rnnoise-processor.js", "rnnoise.wasm", "rnnoise_simd.wasm", "ultrainstinct.gif")) {
        $assetPath = Join-Path $source $dynamicAsset
        $heldPath = "$assetPath.missing"
        Move-Item -LiteralPath $assetPath -Destination $heldPath
        $assetRejected = $false
        try { Assert-ViewerSource -SourceDirectory $source }
        catch { $assetRejected = $true }
        finally { Move-Item -LiteralPath $heldPath -Destination $assetPath }
        Assert-True $assetRejected "missing dynamic asset $dynamicAsset fails closed"
    }

    # Execute the exact startup preflight used before the watcher is allowed to
    # poll or pull. These checks are read-only and use only temporary paths.
    $validPreflight = Get-ViewerRuntimePreflight `
        -ConfiguredRuntime $runtime `
        -SourceDirectory $source
    Assert-True $validPreflight.Succeeded "dedicated runtime passes startup preflight"

    $missingPreflight = Get-ViewerRuntimePreflight `
        -ConfiguredRuntime "" `
        -SourceDirectory $source
    Assert-True (!$missingPreflight.Succeeded) "startup preflight rejects missing ECHO_CORE_VIEWER_DIR"

    $samePreflight = Get-ViewerRuntimePreflight `
        -ConfiguredRuntime $source `
        -SourceDirectory $source
    Assert-True (!$samePreflight.Succeeded) "startup preflight rejects source-as-runtime configuration"

    $nestedPreflightPath = Join-Path $source "runtime"
    $nestedPreflight = Get-ViewerRuntimePreflight `
        -ConfiguredRuntime $nestedPreflightPath `
        -SourceDirectory $source
    Assert-True (!$nestedPreflight.Succeeded) "startup preflight rejects a runtime nested under source"
    Assert-True (!(Test-Path -LiteralPath $nestedPreflightPath)) "startup preflight does not create the runtime"

    $checkoutRuntime = Join-Path $root "unsafe-viewer-runtime-preflight-test"
    $checkoutPreflight = Get-ViewerRuntimePreflight `
        -ConfiguredRuntime $checkoutRuntime `
        -SourceDirectory $source
    Assert-True (!$checkoutPreflight.Succeeded) "startup preflight rejects a runtime inside the git checkout"
    Assert-True (!(Test-Path -LiteralPath $checkoutRuntime)) "checkout safety preflight is non-mutating"

    Set-Content -LiteralPath (Join-Path $runtime "index.html") -Value '<script src="old.js?v=old"></script>' -NoNewline
    Set-Content -LiteralPath (Join-Path $runtime "stale.js") -Value 'stale' -NoNewline

    $published = Publish-ViewerRuntimeSnapshot `
        -SourceDirectory $source `
        -RuntimeDirectory $runtime `
        -AllowRunningControl

    Assert-True (Test-Path -LiteralPath (Join-Path $runtime "jam.js")) "full viewer snapshot is published"
    Assert-True (!(Test-Path -LiteralPath (Join-Path $runtime "stale.js"))) "stale runtime files are not mixed into the new snapshot"
    Assert-True (Test-Path -LiteralPath (Join-Path $published.BackupDirectory "stale.js")) "previous runtime is retained as rollback backup"
    Assert-ViewerSnapshot -SourceDirectory $source -CandidateDirectory $runtime | Out-Null

    # Runtime cache stamping is expected and must not create a false parity failure.
    Set-Content -LiteralPath (Join-Path $runtime "index.html") -Value '<link rel="stylesheet" href="style.css?v=0.6.29.12345"><link rel="stylesheet" href="clubhouse-shell.css?v=0.6.29.12345"><script src="layout-policy.js?v=0.6.29.12345"></script><script src="ui-shell.js?v=0.6.29.12345"></script><script src="jam.js?v=0.6.29.12345"></script>' -NoNewline
    Assert-ViewerSnapshot -SourceDirectory $source -CandidateDirectory $runtime | Out-Null
    & (Join-Path $scriptDir "publish-viewer-runtime.ps1") `
        -SourceDirectory $source `
        -RuntimeDirectory $runtime `
        -VerifyOnly

    Set-Content -LiteralPath (Join-Path $runtime "jam.js") -Value 'drift' -NoNewline
    $driftRejected = $false
    try { Assert-ViewerSnapshot -SourceDirectory $source -CandidateDirectory $runtime | Out-Null }
    catch { $driftRejected = $true }
    Assert-True $driftRejected "content drift fails verification"

    $incomplete = Join-Path $testRoot "incomplete"
    New-Item -ItemType Directory -Path $incomplete | Out-Null
    $incompleteRejected = $false
    try {
        Publish-ViewerRuntimeSnapshot -SourceDirectory $incomplete -RuntimeDirectory $runtime -AllowRunningControl | Out-Null
    }
    catch { $incompleteRejected = $true }
    Assert-True $incompleteRejected "incomplete viewer source fails closed"

    $jamOnly = Join-Path $testRoot "jam-only"
    New-Item -ItemType Directory -Path $jamOnly | Out-Null
    Set-Content -LiteralPath (Join-Path $jamOnly "index.html") -Value '<script src="jam.js"></script>' -NoNewline
    Set-Content -LiteralPath (Join-Path $jamOnly "jam.js") -Value 'jam' -NoNewline
    Set-Content -LiteralPath (Join-Path $jamOnly "jam-session-state.js") -Value 'state' -NoNewline
    $jamOnlyRejected = $false
    try {
        Publish-ViewerRuntimeSnapshot -SourceDirectory $jamOnly -RuntimeDirectory $runtime -AllowRunningControl | Out-Null
    }
    catch { $jamOnlyRejected = $true }
    Assert-True $jamOnlyRejected "a Jam-only partial source cannot replace the production viewer"

    $nestedRejected = $false
    try {
        Publish-ViewerRuntimeSnapshot `
            -SourceDirectory $source `
            -RuntimeDirectory (Join-Path $source "runtime") `
            -AllowRunningControl | Out-Null
    }
    catch { $nestedRejected = $true }
    Assert-True $nestedRejected "nested source/runtime paths fail closed"

    $fileRuntime = Join-Path $testRoot "runtime-is-a-file"
    Set-Content -LiteralPath $fileRuntime -Value "preserve-me" -NoNewline
    $fileRuntimeRejected = $false
    try {
        Publish-ViewerRuntimeSnapshot `
            -SourceDirectory $source `
            -RuntimeDirectory $fileRuntime `
            -AllowRunningControl | Out-Null
    }
    catch { $fileRuntimeRejected = $true }
    Assert-True $fileRuntimeRejected "a file cannot be treated as a viewer runtime directory"
    Assert-True ((Get-Content -LiteralPath $fileRuntime -Raw) -eq "preserve-me") "invalid runtime file is not mutated"

    # Exercise the deploy watcher's real publish/restore helpers against temp
    # paths. AllowRunningControl bypasses only the process-presence guard; these
    # paths cannot touch the configured production viewer runtime.
    $watcherRuntime = Join-Path $testRoot "watcher-runtime"
    New-Item -ItemType Directory -Path $watcherRuntime | Out-Null
    Set-Content -LiteralPath (Join-Path $watcherRuntime "old-marker.txt") -Value "old" -NoNewline
    $watcherPublish = Publish-ViewerForDeploy `
        -ConfiguredRuntime $watcherRuntime `
        -SourceDirectory $source `
        -AllowRunningControl
    Assert-True $watcherPublish.Succeeded "watcher helper publishes a complete viewer snapshot"
    Assert-True $watcherPublish.Published "watcher helper reports a real publish"
    Assert-True $watcherPublish.HadRuntime "watcher helper records the prior runtime"
    Assert-True (Test-Path -LiteralPath (Join-Path $watcherRuntime "jam.js")) "watcher helper swapped in the viewer"
    $watcherRestored = Restore-ViewerAfterFailedDeploy $watcherPublish
    Assert-True $watcherRestored "watcher helper restores an existing prior runtime"
    Assert-True (Test-Path -LiteralPath (Join-Path $watcherRuntime "old-marker.txt")) "prior runtime content is restored"

    $absentRuntime = Join-Path $testRoot "previously-absent-runtime"
    $absentPublish = Publish-ViewerForDeploy `
        -ConfiguredRuntime $absentRuntime `
        -SourceDirectory $source `
        -AllowRunningControl
    Assert-True $absentPublish.Succeeded "watcher helper publishes when no runtime existed"
    Assert-True (!$absentPublish.HadRuntime) "watcher helper records prior runtime absence"
    Assert-True (Restore-ViewerAfterFailedDeploy $absentPublish) "rollback to prior absence succeeds"
    Assert-True (!(Test-Path -LiteralPath $absentRuntime)) "rollback removes the newly introduced runtime"

    $missingConfig = Publish-ViewerForDeploy `
        -ConfiguredRuntime "" `
        -SourceDirectory $source `
        -AllowRunningControl
    Assert-True (!$missingConfig.Succeeded) "missing ECHO_CORE_VIEWER_DIR fails closed"
    Assert-True $missingConfig.ViewerStateSafe "pre-swap configuration failure leaves viewer state safe"

    $sameDirectory = Publish-ViewerForDeploy `
        -ConfiguredRuntime $source `
        -SourceDirectory $source `
        -AllowRunningControl
    Assert-True (!$sameDirectory.Succeeded) "source-as-runtime configuration fails closed"

    $missingBackupRuntime = Join-Path $testRoot "missing-backup-runtime"
    New-Item -ItemType Directory -Path $missingBackupRuntime | Out-Null
    $missingBackupPublish = [pscustomobject]@{
        Published = $true
        RuntimeDirectory = $missingBackupRuntime
        BackupDirectory = (Join-Path $testRoot "does-not-exist")
        HadRuntime = $true
    }
    Assert-True (!(Restore-ViewerAfterFailedDeploy $missingBackupPublish)) "missing rollback backup is reported as failure"

    $failedResult = New-DeployResult `
        -Succeeded $false `
        -RollbackAttempted $true `
        -RollbackSucceeded $false `
        -ErrorMessage "fixture failure"
    Assert-True (!$failedResult.Succeeded -and !$failedResult.RollbackSucceeded) "deploy result preserves incomplete rollback status"

    $guardExe = Join-Path $testRoot "guard-control.exe"
    $guardBackup = "$guardExe.bak"
    Set-Content -LiteralPath $guardExe -Value "new-binary" -NoNewline
    Set-Content -LiteralPath $guardBackup -Value "old-binary" -NoNewline
    $guardRuntime = Join-Path $testRoot "guard-runtime"
    $guardViewerBackup = Join-Path $testRoot "guard-runtime.backup"
    New-Item -ItemType Directory -Path $guardRuntime, $guardViewerBackup | Out-Null
    Set-Content -LiteralPath (Join-Path $guardRuntime "new.txt") -Value "new-viewer" -NoNewline
    Set-Content -LiteralPath (Join-Path $guardViewerBackup "old.txt") -Value "old-viewer" -NoNewline
    $guardPublish = [pscustomobject]@{
        Published = $true
        RuntimeDirectory = $guardRuntime
        BackupDirectory = $guardViewerBackup
        HadRuntime = $true
    }
    $guardRollback = Invoke-ReleaseRollback `
        -viewerPublish $guardPublish `
        -Executable $guardExe `
        -Backup $guardBackup `
        -NewProcessStopped $false
    Assert-True (!$guardRollback.Succeeded) "a live new process makes rollback fail explicitly"
    Assert-True ((Get-Content -LiteralPath $guardExe -Raw) -eq "new-binary") "binary is not swapped under a live process"
    Assert-True (Test-Path -LiteralPath (Join-Path $guardRuntime "new.txt")) "viewer is not rolled back under a live process"
}
finally {
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force
    }
}

Write-Host "viewer-runtime-lib tests passed"
Write-Host "deploy-watcher executable viewer release-unit tests passed"
