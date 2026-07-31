$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "echo-core-host-network-guard.ps1") -NoMain

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Assert-Equal([object]$Expected, [object]$Actual, [string]$Message) {
    if ($Expected -ne $Actual) {
        throw "Assertion failed: $Message. Expected '$Expected', got '$Actual'"
    }
}

function Assert-ThrowsLike([scriptblock]$Action, [string]$Pattern, [string]$Message) {
    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notlike $Pattern) {
            throw "Assertion failed: $Message. Wrong error '$($_.Exception.Message)'"
        }
        return
    }

    throw "Assertion failed: $Message. Expected an exception"
}

function New-TestService([string]$State = "Running", [int]$ProcessId = 7000) {
    return [PSCustomObject]@{
        Name = "EchoCoreHost"
        State = $State
        ProcessId = $ProcessId
    }
}

function New-TestControlProcess([int]$ProcessId, [int]$ParentProcessId) {
    return [PSCustomObject]@{
        Name = "echo-core-control.exe"
        ProcessId = $ProcessId
        ParentProcessId = $ParentProcessId
    }
}

function New-TestListener([string]$Address, [int]$Port, [int]$ProcessId) {
    return [PSCustomObject]@{
        LocalAddress = $Address
        LocalPort = $Port
        OwningProcess = $ProcessId
    }
}

function Write-TestHostConfig([string]$Path, [string]$EnvironmentFilePath) {
    $json = [PSCustomObject]@{ control_env_file = $EnvironmentFilePath } |
        ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($Path, $json)
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("echo-core-host-network-guard-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    $hostConfigPath = Join-Path $testRoot "echo-core-host.json"
    $environmentPath = Join-Path $testRoot "production.env"
    [System.IO.File]::WriteAllLines($environmentPath, @(
        "CORE_BIND=0.0.0.0",
        "CORE_PORT=9443"
    ))
    Write-TestHostConfig -Path $hostConfigPath -EnvironmentFilePath $environmentPath

    $preflight = Invoke-EchoCoreHostNetworkGuard `
        -RequestedAction Preflight `
        -ConfigPath $hostConfigPath `
        -Attempts 1 `
        -DelayMilliseconds 0
    Assert-Equal ([System.IO.Path]::GetFullPath($environmentPath)) $preflight.EnvironmentFilePath "fully qualified control_env_file is preserved"
    Assert-Equal "0.0.0.0" $preflight.Bind "preflight validates the production wildcard bind"
    Assert-Equal 9443 $preflight.Port "preflight validates the production port"
    Assert-Equal 0 $preflight.Attempts "preflight does not inspect or mutate the service"

    foreach ($invalidRootJson in @(
        '[{"control_env_file":"C:\\production.env"}]',
        '"not-an-object"',
        '42',
        'true',
        'null'
    )) {
        [System.IO.File]::WriteAllText($hostConfigPath, $invalidRootJson)
        Assert-ThrowsLike {
            Invoke-EchoCoreHostNetworkGuard `
                -RequestedAction Preflight `
                -ConfigPath $hostConfigPath `
                -Attempts 1 `
                -DelayMilliseconds 0
        } "*root must be a top-level JSON object*" "non-object host JSON root is rejected"
    }

    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Preflight `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ReadHostConfig { @{ control_env_file = $environmentPath } }
    } "*root must deserialize to a PSCustomObject*" "injected non-PSCustomObject host root is rejected"

    foreach ($nonStringValueJson in @(
        'null',
        '9443',
        'true',
        '["C:\\production.env"]',
        '{"path":"C:\\production.env"}'
    )) {
        [System.IO.File]::WriteAllText(
            $hostConfigPath,
            '{"control_env_file":' + $nonStringValueJson + '}'
        )
        Assert-ThrowsLike {
            Invoke-EchoCoreHostNetworkGuard `
                -RequestedAction Preflight `
                -ConfigPath $hostConfigPath `
                -Attempts 1 `
                -DelayMilliseconds 0
        } "*control_env_file must be a JSON string*" "non-string control_env_file is rejected"
    }

    [System.IO.File]::WriteAllText(
        $hostConfigPath,
        '{"CONTROL_ENV_FILE":"C:\\production.env"}'
    )
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Preflight `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0
    } "*exactly one case-sensitive control_env_file property*" "wrong-case control_env_file does not match Rust HostConfig"

    Write-TestHostConfig -Path $hostConfigPath -EnvironmentFilePath $environmentPath

    foreach ($unsafeEnvironmentPath in @("production.env", "C:production.env", "\production.env")) {
        Write-TestHostConfig -Path $hostConfigPath -EnvironmentFilePath $unsafeEnvironmentPath
        Assert-ThrowsLike {
            Invoke-EchoCoreHostNetworkGuard `
                -RequestedAction Preflight `
                -ConfigPath $hostConfigPath `
                -Attempts 1 `
                -DelayMilliseconds 0
        } "*fully qualified Windows drive-rooted path*" "non-fully-qualified control_env_file '$unsafeEnvironmentPath' is rejected"
    }
    Write-TestHostConfig -Path $hostConfigPath -EnvironmentFilePath $environmentPath

    $script:mutationCount = 0
    [System.IO.File]::WriteAllLines($environmentPath, @(
        "CORE_BIND=127.0.0.1",
        "CORE_PORT=9443"
    ))
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { $script:mutationCount++ }
    } "*CORE_BIND must be exactly 0.0.0.0*" "localhost-only config is rejected before service mutation"
    Assert-Equal 0 $script:mutationCount "unsafe config never reaches the service mutation provider"

    [System.IO.File]::WriteAllLines($environmentPath, @(
        "CORE_BIND=0.0.0.0",
        "CORE_PORT=9443"
    ))
    $script:mutationCount = 0
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Start `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { $script:mutationCount++ } `
            -ServiceProvider { New-TestService }
    } "*Guarded Start requires EchoCoreHost to be Stopped with process ID 0*" "Start rejects an already-running service before mutation"
    Assert-Equal 0 $script:mutationCount "already-running Start never reaches the mutation provider"

    $script:startCompleted = $false
    $start = Invoke-EchoCoreHostNetworkGuard `
        -RequestedAction Start `
        -ConfigPath $hostConfigPath `
        -Attempts 1 `
        -DelayMilliseconds 0 `
        -ServiceMutationProvider { $script:startCompleted = $true } `
        -ServiceProvider {
            if ($script:startCompleted) { New-TestService -ProcessId 8000 }
            else { New-TestService -State "Stopped" -ProcessId 0 }
        } `
        -ControlProcessProvider { New-TestControlProcess -ProcessId 8200 -ParentProcessId 8000 } `
        -HealthProbeProvider { $true } `
        -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 8200 } `
        -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
        -TcpProbeProvider { $true }
    Assert-True $script:startCompleted "guarded Start invokes the service mutation"
    Assert-Equal 8000 $start.ServiceProcessId "guarded Start verifies the newly running service"
    Assert-Equal 8200 $start.ControlProcessId "guarded Start verifies the new direct control child"

    $script:mutationAction = $null
    $script:mutationService = $null
    $script:restartCompleted = $false
    $restart = Invoke-EchoCoreHostNetworkGuard `
        -RequestedAction Restart `
        -ConfigPath $hostConfigPath `
        -Attempts 2 `
        -DelayMilliseconds 0 `
        -ServiceMutationProvider {
            param([string]$Mutation, [string]$ServiceName)
            $script:mutationAction = $Mutation
            $script:mutationService = $ServiceName
            $script:restartCompleted = $true
        } `
        -ServiceProvider {
            if ($script:restartCompleted) { New-TestService -ProcessId 9000 }
            else { New-TestService -ProcessId 7000 }
        } `
        -ControlProcessProvider {
            @(
                (New-TestControlProcess -ProcessId 7100 -ParentProcessId 9999),
                (New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000),
                (New-TestControlProcess -ProcessId 9200 -ParentProcessId 9000)
            )
        } `
        -HealthProbeProvider { $true } `
        -ListenerProvider {
            param([int]$Port)
            New-TestListener -Address "0.0.0.0" -Port $Port -ProcessId 9200
        } `
        -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
        -TcpProbeProvider {
            param([string]$Address, [int]$Port)
            $Address -eq "192.168.5.70" -and $Port -eq 9443
        }
    Assert-Equal "Restart" $script:mutationAction "the guarded restart performs the requested mutation"
    Assert-Equal "EchoCoreHost" $script:mutationService "the mutation is scoped to EchoCoreHost"
    Assert-Equal 9000 $restart.ServiceProcessId "the replacement EchoCoreHost PID is reported"
    Assert-Equal 9200 $restart.ControlProcessId "the replacement direct control child is reported"
    Assert-Equal "0.0.0.0" $restart.ListenerAddress "the wildcard listener is verified"
    Assert-Equal "192.168.5.70" $restart.ProbeAddress "the LAN ingress target is verified"

    $script:unchangedRestartCleanupCount = 0
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { } `
            -ServiceCleanupProvider { $script:unchangedRestartCleanupCount++ } `
            -ServiceProvider { New-TestService -ProcessId 7000 } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 7200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $true }
    } "*Guarded Restart did not replace either*" "Restart rejects an unchanged service and control PID"
    Assert-Equal 0 $script:unchangedRestartCleanupCount "safe no-op Restart preserves the proven healthy wildcard-bound service"

    $script:throwingSafeCleanupCount = 0
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { throw "simulated unchanged mutation failure" } `
            -ServiceCleanupProvider { $script:throwingSafeCleanupCount++ } `
            -ServiceProvider { New-TestService -ProcessId 7000 } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 7200 }
    } "*simulated unchanged mutation failure*" "throwing Restart preserves an unchanged hard-safe process"
    Assert-Equal 0 $script:throwingSafeCleanupCount "throwing provider does not stop unchanged hard-safe service and control PIDs"

    $script:throwingChangedPhase = "old"
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider {
                $script:throwingChangedPhase = "changed"
                throw "simulated changed mutation failure"
            } `
            -ServiceCleanupProvider { $script:throwingChangedPhase = "stopped" } `
            -ServiceProvider {
                if ($script:throwingChangedPhase -eq "old") { New-TestService -ProcessId 7000 }
                elseif ($script:throwingChangedPhase -eq "changed") { New-TestService -ProcessId 9000 }
                else { New-TestService -State "Stopped" -ProcessId 0 }
            } `
            -ControlProcessProvider {
                @(
                    (New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000),
                    (New-TestControlProcess -ProcessId 9200 -ParentProcessId 9000)
                )
            } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 9200 }
    } "*simulated changed mutation failure*" "throwing Restart cleans up a changed service/control process"
    Assert-Equal "stopped" $script:throwingChangedPhase "throwing provider with changed PIDs stops the partial-live service"

    $script:throwingUnsafeCleanup = $false
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { throw "simulated unsafe mutation failure" } `
            -ServiceCleanupProvider { $script:throwingUnsafeCleanup = $true } `
            -ServiceProvider {
                if ($script:throwingUnsafeCleanup) { New-TestService -State "Stopped" -ProcessId 0 }
                else { New-TestService -ProcessId 7000 }
            } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "127.0.0.1" -Port 9443 -ProcessId 7200 }
    } "*simulated unsafe mutation failure*" "throwing Restart cleans up an unchanged but unsafe listener"
    Assert-True $script:throwingUnsafeCleanup "throwing provider stops unchanged PIDs when hard safety cannot be proven"

    $script:unsafeNoOpCleanup = $false
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { } `
            -ServiceCleanupProvider { $script:unsafeNoOpCleanup = $true } `
            -ServiceProvider {
                if ($script:unsafeNoOpCleanup) { New-TestService -State "Stopped" -ProcessId 0 }
                else { New-TestService -ProcessId 7000 }
            } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "127.0.0.1" -Port 9443 -ProcessId 7200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $true }
    } "*hard production safety failed*IPv4 wildcard TCP listener*" "unsafe no-op Restart listener fails hard"
    Assert-True $script:unsafeNoOpCleanup "unsafe no-op Restart stops the partial-live service"

    $script:ancillaryFailurePhase = "old"
    $script:ancillaryCleanupCount = 0
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider { $script:ancillaryFailurePhase = "new" } `
            -ServiceCleanupProvider { $script:ancillaryCleanupCount++ } `
            -ServiceProvider {
                if ($script:ancillaryFailurePhase -eq "old") { New-TestService -ProcessId 7000 }
                else { New-TestService -ProcessId 9000 }
            } `
            -ControlProcessProvider {
                @(
                    (New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000),
                    (New-TestControlProcess -ProcessId 9200 -ParentProcessId 9000)
                )
            } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 9200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $false }
    } "*remained healthy and wildcard-bound*LAN ingress was not verified*" "ancillary LAN failure remains visible"
    Assert-Equal 0 $script:ancillaryCleanupCount "ancillary LAN failure does not stop a healthy wildcard-bound service"
    Assert-Equal "new" $script:ancillaryFailurePhase "healthy replacement remains running for external verification"

    $script:serviceAttempt = 0
    $script:sleepCount = 0
    $retried = Invoke-EchoCoreHostNetworkGuard `
        -RequestedAction Verify `
        -ConfigPath $hostConfigPath `
        -Attempts 3 `
        -DelayMilliseconds 1 `
        -ServiceProvider {
            $script:serviceAttempt++
            if ($script:serviceAttempt -eq 1) {
                New-TestService -State "Start Pending" -ProcessId 0
            }
            else {
                New-TestService
            }
        } `
        -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
        -HealthProbeProvider { $true } `
        -ListenerProvider {
            param([int]$Port)
            New-TestListener -Address "0.0.0.0" -Port $Port -ProcessId 7200
        } `
        -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
        -TcpProbeProvider { $true } `
        -SleepProvider { $script:sleepCount++ }
    Assert-Equal 2 $retried.Attempts "post-start verification retries transient service state"
    Assert-Equal 1 $script:sleepCount "bounded retry sleeps only between failed attempts"

    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Verify `
            -ConfigPath $hostConfigPath `
            -Attempts 2 `
            -DelayMilliseconds 0 `
            -ServiceProvider { New-TestService } `
            -ControlProcessProvider {
                @(
                    (New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000),
                    (New-TestControlProcess -ProcessId 7300 -ParentProcessId 7000)
                )
            } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 7200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $true }
    } "*after 2 attempts*exactly one direct echo-core-control.exe child*found 2*" "multiple direct control children fail closed after bounded retries"

    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Verify `
            -ConfigPath $hostConfigPath `
            -Attempts 2 `
            -DelayMilliseconds 0 `
            -ServiceProvider { New-TestService } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "127.0.0.1" -Port 9443 -ProcessId 7200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $true }
    } "*after 2 attempts*does not own the IPv4 wildcard TCP listener*9443*" "a localhost-only live child never passes post-start verification"

    $alternateEnvironmentPath = Join-Path $testRoot "alternate.env"
    [System.IO.File]::WriteAllLines($alternateEnvironmentPath, @(
        "CORE_BIND=0.0.0.0",
        "CORE_PORT=9443"
    ))
    $script:configRaceCleanup = $false
    Assert-ThrowsLike {
        Invoke-EchoCoreHostNetworkGuard `
            -RequestedAction Restart `
            -ConfigPath $hostConfigPath `
            -Attempts 1 `
            -DelayMilliseconds 0 `
            -ServiceMutationProvider {
                Write-TestHostConfig -Path $hostConfigPath -EnvironmentFilePath $alternateEnvironmentPath
            } `
            -ServiceCleanupProvider { $script:configRaceCleanup = $true } `
            -ServiceProvider {
                if ($script:configRaceCleanup) { New-TestService -State "Stopped" -ProcessId 0 }
                else { New-TestService }
            } `
            -ControlProcessProvider { New-TestControlProcess -ProcessId 7200 -ParentProcessId 7000 } `
            -HealthProbeProvider { $true } `
            -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 7200 } `
            -DefaultRouteLanIPv4Provider { "192.168.5.70" } `
            -TcpProbeProvider { $true }
    } "*control_env_file changed during the service mutation*" "a host-config swap during restart fails closed"
    Assert-True $script:configRaceCleanup "host-config race stops the partial-live service"

    Write-Host "echo-core-host-network-guard tests passed"
}
finally {
    if (Test-Path -LiteralPath $testRoot -PathType Container) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}
