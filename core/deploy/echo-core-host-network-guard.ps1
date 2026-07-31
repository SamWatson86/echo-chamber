[CmdletBinding()]
param(
    [ValidateSet("Preflight", "Verify", "Start", "Restart")]
    [string]$Action = "Verify",

    [ValidateRange(1, 120)]
    [int]$VerificationAttempts = 15,

    [ValidateRange(0, 30000)]
    [int]$RetryDelayMilliseconds = 1000,

    # Loads the functions for isolated tests without reading or mutating the
    # live EchoCoreHost service. Production never passes this switch.
    [switch]$NoMain
)

$ErrorActionPreference = "Stop"

$productionNetworkLib = Join-Path $PSScriptRoot "production-network-lib.ps1"
if (!(Test-Path -LiteralPath $productionNetworkLib -PathType Leaf)) {
    throw "Required production network guard library is missing: $productionNetworkLib"
}
. $productionNetworkLib

$canonicalHostConfigPath = "C:\ProgramData\Echo Chamber\echo-core-host.json"

function Get-EchoCoreHostProductionConfiguration {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [scriptblock]$ReadHostConfig = {
            param([string]$Path)
            $rawJson = [System.IO.File]::ReadAllText($Path)
            if ([string]::IsNullOrWhiteSpace($rawJson) -or $rawJson.TrimStart()[0] -cne '{') {
                throw [System.IO.InvalidDataException]::new(
                    "EchoCoreHost configuration root must be a top-level JSON object."
                )
            }
            $rawJson | ConvertFrom-Json
        },

        [scriptblock]$ReadEnvironmentFile = {
            param([string]$Path)
            [System.IO.File]::ReadAllLines($Path)
        }
    )

    try {
        $resolvedConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
        $hostConfigs = @(& $ReadHostConfig $resolvedConfigPath)
    }
    catch {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost configuration could not be read: $($_.Exception.Message)"
        )
    }

    if ($hostConfigs.Count -ne 1 -or $null -eq $hostConfigs[0]) {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost configuration must contain exactly one JSON object."
        )
    }

    $hostConfig = $hostConfigs[0]
    if ($hostConfig -isnot [System.Management.Automation.PSCustomObject]) {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost configuration root must deserialize to a PSCustomObject."
        )
    }

    $environmentProperties = @(
        $hostConfig.PSObject.Properties |
            Where-Object { $_.Name -ceq "control_env_file" }
    )
    if ($environmentProperties.Count -ne 1) {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost configuration must define exactly one case-sensitive control_env_file property."
        )
    }
    if ($environmentProperties[0].Value -isnot [string]) {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost control_env_file must be a JSON string."
        )
    }

    $rawEnvironmentPath = [string]$environmentProperties[0].Value
    if ([string]::IsNullOrWhiteSpace($rawEnvironmentPath)) {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost configuration must define control_env_file."
        )
    }

    if ($rawEnvironmentPath -notmatch '^[A-Za-z]:[\\/]') {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost control_env_file must be a fully qualified Windows drive-rooted path."
        )
    }

    try {
        $environmentPath = [System.IO.Path]::GetFullPath($rawEnvironmentPath)
    }
    catch {
        throw [System.IO.InvalidDataException]::new(
            "EchoCoreHost control_env_file path is invalid: $($_.Exception.Message)"
        )
    }

    $environment = Assert-ProductionControlEnvironment `
        -EnvFilePath $environmentPath `
        -ReadEnvironmentFile $ReadEnvironmentFile

    return [PSCustomObject]@{
        HostConfigPath = $resolvedConfigPath
        EnvironmentFilePath = $environmentPath
        Bind = $environment.Bind
        Port = $environment.Port
    }
}

function Get-EchoCoreHostServiceRecord {
    param(
        [scriptblock]$ServiceProvider = {
            Get-CimInstance Win32_Service `
                -Filter "Name='EchoCoreHost'" `
                -ErrorAction Stop |
                Select-Object Name, State, ProcessId
        }
    )

    $services = @(& $ServiceProvider)
    if ($services.Count -ne 1 -or $null -eq $services[0]) {
        throw [System.InvalidOperationException]::new(
            "Expected exactly one EchoCoreHost service record; found $($services.Count)."
        )
    }

    $service = $services[0]
    if ([string]$service.Name -cne "EchoCoreHost") {
        throw [System.InvalidOperationException]::new(
            "The service provider did not return EchoCoreHost."
        )
    }
    $serviceProcessId = 0L
    if (-not [long]::TryParse([string]$service.ProcessId, [ref]$serviceProcessId) -or
        $serviceProcessId -lt 0 -or
        $serviceProcessId -gt [int]::MaxValue) {
        throw [System.InvalidOperationException]::new(
            "EchoCoreHost does not have a valid service process ID."
        )
    }

    return [PSCustomObject]@{
        Name = "EchoCoreHost"
        State = [string]$service.State
        ProcessId = [int]$serviceProcessId
    }
}

function Get-EchoCoreHostDirectControlChild {
    param(
        [object]$ServiceRecord,

        [scriptblock]$ServiceProvider = {
            Get-CimInstance Win32_Service `
                -Filter "Name='EchoCoreHost'" `
                -ErrorAction Stop |
                Select-Object Name, State, ProcessId
        },

        [scriptblock]$ControlProcessProvider = {
            Get-CimInstance Win32_Process `
                -Filter "Name='echo-core-control.exe'" `
                -ErrorAction Stop |
                Select-Object Name, ProcessId, ParentProcessId
        }
    )

    $service = if ($PSBoundParameters.ContainsKey("ServiceRecord")) {
        $ServiceRecord
    }
    else {
        Get-EchoCoreHostServiceRecord -ServiceProvider $ServiceProvider
    }
    if ($null -eq $service -or [string]$service.State -ine "Running" -or [int]$service.ProcessId -lt 1) {
        throw [System.InvalidOperationException]::new(
            "EchoCoreHost is not running; current state is '$($service.State)'."
        )
    }
    $serviceProcessId = [int]$service.ProcessId

    $directChildren = @()
    foreach ($process in @(& $ControlProcessProvider)) {
        if ($null -eq $process -or [string]$process.Name -ine "echo-core-control.exe") {
            continue
        }

        $processId = 0L
        $parentProcessId = 0L
        if (-not [long]::TryParse([string]$process.ProcessId, [ref]$processId) -or
            -not [long]::TryParse([string]$process.ParentProcessId, [ref]$parentProcessId)) {
            continue
        }
        if ($parentProcessId -eq $serviceProcessId -and
            $processId -ge 1 -and
            $processId -le [int]::MaxValue) {
            $directChildren += $process
        }
    }

    if ($directChildren.Count -ne 1) {
        throw [System.InvalidOperationException]::new(
            "Expected exactly one direct echo-core-control.exe child of EchoCoreHost PID $serviceProcessId; found $($directChildren.Count)."
        )
    }

    return [PSCustomObject]@{
        ServiceProcessId = [int]$serviceProcessId
        ControlProcessId = [int]$directChildren[0].ProcessId
    }
}

function Assert-EchoCoreHostProductionHardSafetyOnce {
    param(
        [scriptblock]$ServiceProvider,
        [scriptblock]$ControlProcessProvider,
        [scriptblock]$ListenerProvider,
        [scriptblock]$HealthProbeProvider = {
            $response = curl.exe -sk --max-time 5 https://127.0.0.1:9443/health 2>&1
            return $LASTEXITCODE -eq 0 -and $response -match '"ok"\s*:\s*true'
        }
    )

    $processArgs = @{}
    if ($null -ne $ServiceProvider) {
        $processArgs.ServiceProvider = $ServiceProvider
    }
    if ($null -ne $ControlProcessProvider) {
        $processArgs.ControlProcessProvider = $ControlProcessProvider
    }
    $processes = Get-EchoCoreHostDirectControlChild @processArgs

    $healthResults = @(& $HealthProbeProvider)
    if ($healthResults.Count -ne 1 -or $healthResults[0] -isnot [bool] -or -not $healthResults[0]) {
        throw [System.InvalidOperationException]::new(
            "EchoCoreHost direct control child failed its loopback health check."
        )
    }

    $listenerArgs = @{ ExpectedControlProcessId = $processes.ControlProcessId }
    if ($null -ne $ListenerProvider) {
        $listenerArgs.ListenerProvider = $ListenerProvider
    }
    $listener = Assert-ProductionControlListener @listenerArgs

    return [PSCustomObject]@{
        ServiceProcessId = $processes.ServiceProcessId
        ControlProcessId = $processes.ControlProcessId
        ListenerAddress = $listener.ListenerAddress
        Port = $listener.Port
    }
}

function Assert-EchoCoreHostProductionIngressOnce {
    param(
        [scriptblock]$ServiceProvider,
        [scriptblock]$ControlProcessProvider,
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider,
        [scriptblock]$HealthProbeProvider
    )

    $hardArgs = @{}
    foreach ($providerName in @(
        "ServiceProvider",
        "ControlProcessProvider",
        "ListenerProvider",
        "HealthProbeProvider"
    )) {
        $provider = Get-Variable -Name $providerName -ValueOnly
        if ($null -ne $provider) {
            $hardArgs[$providerName] = $provider
        }
    }
    $hardSafety = Assert-EchoCoreHostProductionHardSafetyOnce @hardArgs

    $probeArgs = @{}
    foreach ($providerName in @("DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
        $provider = Get-Variable -Name $providerName -ValueOnly
        if ($null -ne $provider) {
            $probeArgs[$providerName] = $provider
        }
    }
    $probe = Assert-ProductionControlLanProbe @probeArgs

    return [PSCustomObject]@{
        ServiceProcessId = $hardSafety.ServiceProcessId
        ControlProcessId = $hardSafety.ControlProcessId
        ListenerAddress = $hardSafety.ListenerAddress
        Port = $hardSafety.Port
        ProbeAddress = $probe.ProbeAddress
    }
}

function Wait-EchoCoreHostProductionIngress {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 120)]
        [int]$Attempts,

        [Parameter(Mandatory = $true)]
        [ValidateRange(0, 30000)]
        [int]$DelayMilliseconds,

        [scriptblock]$ServiceProvider,
        [scriptblock]$ControlProcessProvider,
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider,
        [scriptblock]$HealthProbeProvider,
        [scriptblock]$SleepProvider = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        }
    )

    $lastError = "verification did not run"
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $assertArgs = @{}
            foreach ($providerName in @(
                "ServiceProvider",
                "ControlProcessProvider",
                "ListenerProvider",
                "DefaultRouteLanIPv4Provider",
                "TcpProbeProvider",
                "HealthProbeProvider"
            )) {
                $provider = Get-Variable -Name $providerName -ValueOnly
                if ($null -ne $provider) {
                    $assertArgs[$providerName] = $provider
                }
            }
            $ingress = Assert-EchoCoreHostProductionIngressOnce @assertArgs
            $ingress | Add-Member -NotePropertyName Attempts -NotePropertyValue $attempt
            return $ingress
        }
        catch {
            $lastError = $_.Exception.Message
        }

        if ($attempt -lt $Attempts -and $DelayMilliseconds -gt 0) {
            & $SleepProvider $DelayMilliseconds | Out-Null
        }
    }

    # Separate a hard post-activation failure from an ancillary LAN-route/probe
    # failure. The former must stop the partial-live service; the latter must
    # leave a healthy wildcard-bound service running for manual LAN/WAN checks.
    try {
        $hardArgs = @{}
        foreach ($providerName in @(
            "ServiceProvider",
            "ControlProcessProvider",
            "ListenerProvider",
            "HealthProbeProvider"
        )) {
            $provider = Get-Variable -Name $providerName -ValueOnly
            if ($null -ne $provider) {
                $hardArgs[$providerName] = $provider
            }
        }
        $hardSafety = Assert-EchoCoreHostProductionHardSafetyOnce @hardArgs
    }
    catch {
        $hardFailure = [System.InvalidOperationException]::new(
            "EchoCoreHost hard production safety failed after $Attempts attempts: $($_.Exception.Message)"
        )
        $hardFailure.Data["EchoHardSafetyFailure"] = $true
        throw $hardFailure
    }

    try {
        $probeArgs = @{}
        foreach ($providerName in @("DefaultRouteLanIPv4Provider", "TcpProbeProvider")) {
            $provider = Get-Variable -Name $providerName -ValueOnly
            if ($null -ne $provider) {
                $probeArgs[$providerName] = $provider
            }
        }
        $probe = Assert-ProductionControlLanProbe @probeArgs
        return [PSCustomObject]@{
            ServiceProcessId = $hardSafety.ServiceProcessId
            ControlProcessId = $hardSafety.ControlProcessId
            ListenerAddress = $hardSafety.ListenerAddress
            Port = $hardSafety.Port
            ProbeAddress = $probe.ProbeAddress
            Attempts = $Attempts
        }
    }
    catch {
        $ancillaryFailure = [System.InvalidOperationException]::new(
            "EchoCoreHost remained healthy and wildcard-bound, but LAN ingress was not verified after $Attempts attempts: $($_.Exception.Message)"
        )
        $ancillaryFailure.Data["EchoAncillaryLanFailure"] = $true
        throw $ancillaryFailure
    }
}

function Stop-EchoCoreHostAfterFailedMutation {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 120)]
        [int]$Attempts,

        [Parameter(Mandatory = $true)]
        [ValidateRange(0, 30000)]
        [int]$DelayMilliseconds,

        [scriptblock]$ServiceCleanupProvider = {
            Stop-Service -Name "EchoCoreHost" -ErrorAction Stop
        },
        [scriptblock]$ServiceProvider,
        [scriptblock]$SleepProvider = {
            param([int]$Milliseconds)
            Start-Sleep -Milliseconds $Milliseconds
        }
    )

    & $ServiceCleanupProvider | Out-Null
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $serviceArgs = @{}
        if ($null -ne $ServiceProvider) {
            $serviceArgs.ServiceProvider = $ServiceProvider
        }
        $service = Get-EchoCoreHostServiceRecord @serviceArgs
        if ($service.State -ieq "Stopped" -and $service.ProcessId -eq 0) {
            return $true
        }
        if ($attempt -lt $Attempts -and $DelayMilliseconds -gt 0) {
            & $SleepProvider $DelayMilliseconds | Out-Null
        }
    }

    throw [System.InvalidOperationException]::new(
        "EchoCoreHost cleanup did not reach Stopped/PID 0 after $Attempts attempts."
    )
}

function Invoke-EchoCoreHostNetworkGuard {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Preflight", "Verify", "Start", "Restart")]
        [string]$RequestedAction,

        [Parameter(Mandatory = $true)]
        [string]$ConfigPath,

        [Parameter(Mandatory = $true)]
        [ValidateRange(1, 120)]
        [int]$Attempts,

        [Parameter(Mandatory = $true)]
        [ValidateRange(0, 30000)]
        [int]$DelayMilliseconds,

        [scriptblock]$ReadHostConfig,
        [scriptblock]$ReadEnvironmentFile,
        [scriptblock]$ServiceMutationProvider = {
            param([string]$Mutation, [string]$ServiceName)
            if ($Mutation -eq "Start") {
                Start-Service -Name $ServiceName -ErrorAction Stop
            }
            elseif ($Mutation -eq "Restart") {
                Restart-Service -Name $ServiceName -ErrorAction Stop
            }
            else {
                throw "Unsupported EchoCoreHost service mutation '$Mutation'."
            }
        },
        [scriptblock]$ServiceProvider,
        [scriptblock]$ControlProcessProvider,
        [scriptblock]$ListenerProvider,
        [scriptblock]$DefaultRouteLanIPv4Provider,
        [scriptblock]$TcpProbeProvider,
        [scriptblock]$HealthProbeProvider,
        [scriptblock]$ServiceCleanupProvider,
        [scriptblock]$SleepProvider
    )

    $configurationArgs = @{ ConfigPath = $ConfigPath }
    if ($null -ne $ReadHostConfig) {
        $configurationArgs.ReadHostConfig = $ReadHostConfig
    }
    if ($null -ne $ReadEnvironmentFile) {
        $configurationArgs.ReadEnvironmentFile = $ReadEnvironmentFile
    }

    # This is the pre-mutation circuit breaker. It reads the canonical host
    # JSON and validates the exact environment file that EchoCoreHost will use.
    $configuration = Get-EchoCoreHostProductionConfiguration @configurationArgs

    if ($RequestedAction -eq "Preflight") {
        return [PSCustomObject]@{
            Action = $RequestedAction
            HostConfigPath = $configuration.HostConfigPath
            EnvironmentFilePath = $configuration.EnvironmentFilePath
            Bind = $configuration.Bind
            Port = $configuration.Port
            ServiceProcessId = $null
            ControlProcessId = $null
            ListenerAddress = $null
            ProbeAddress = $null
            Attempts = 0
        }
    }

    $preMutationService = $null
    $preMutationControlProcessId = 0
    $mutationPerformed = $false
    $mutationProviderFailed = $false
    if ($RequestedAction -eq "Start" -or $RequestedAction -eq "Restart") {
        $serviceRecordArgs = @{}
        if ($null -ne $ServiceProvider) {
            $serviceRecordArgs.ServiceProvider = $ServiceProvider
        }
        $preMutationService = Get-EchoCoreHostServiceRecord @serviceRecordArgs

        if ($RequestedAction -eq "Start") {
            if ($preMutationService.State -ine "Stopped" -or $preMutationService.ProcessId -ne 0) {
                throw [System.InvalidOperationException]::new(
                    "Guarded Start requires EchoCoreHost to be Stopped with process ID 0; found state '$($preMutationService.State)' PID $($preMutationService.ProcessId)."
                )
            }
        }
        else {
            if ($preMutationService.State -ine "Running" -or $preMutationService.ProcessId -lt 1) {
                throw [System.InvalidOperationException]::new(
                    "Guarded Restart requires EchoCoreHost to be Running before mutation."
                )
            }
            $preChildArgs = @{ ServiceRecord = $preMutationService }
            if ($null -ne $ControlProcessProvider) {
                $preChildArgs.ControlProcessProvider = $ControlProcessProvider
            }
            $preMutationChild = Get-EchoCoreHostDirectControlChild @preChildArgs
            $preMutationControlProcessId = $preMutationChild.ControlProcessId
        }
    }

    try {
        if ($RequestedAction -eq "Start" -or $RequestedAction -eq "Restart") {
            $mutationPerformed = $true
            try {
                & $ServiceMutationProvider $RequestedAction "EchoCoreHost" | Out-Null
            }
            catch {
                $mutationProviderFailed = $true
                throw
            }

            # Close the host-config race around the service mutation. A
            # promotion must not swap the active environment between
            # validation and startup.
            $postMutationConfiguration = Get-EchoCoreHostProductionConfiguration @configurationArgs
            if ($postMutationConfiguration.EnvironmentFilePath -ine $configuration.EnvironmentFilePath) {
                throw [System.InvalidOperationException]::new(
                    "EchoCoreHost control_env_file changed during the service mutation."
                )
            }
        }

        $waitArgs = @{
            Attempts = $Attempts
            DelayMilliseconds = $DelayMilliseconds
        }
        foreach ($providerName in @(
            "ServiceProvider",
            "ControlProcessProvider",
            "ListenerProvider",
            "DefaultRouteLanIPv4Provider",
            "TcpProbeProvider",
            "HealthProbeProvider",
            "SleepProvider"
        )) {
            $provider = Get-Variable -Name $providerName -ValueOnly
            if ($null -ne $provider) {
                $waitArgs[$providerName] = $provider
            }
        }
        $ingress = Wait-EchoCoreHostProductionIngress @waitArgs

        if ($RequestedAction -eq "Restart" -and
            $ingress.ServiceProcessId -eq $preMutationService.ProcessId -and
            $ingress.ControlProcessId -eq $preMutationControlProcessId) {
            $noTransition = [System.InvalidOperationException]::new(
                "Guarded Restart did not replace either the EchoCoreHost service PID or its direct control child PID."
            )
            $noTransition.Data["EchoSafeNoTransition"] = $true
            throw $noTransition
        }
    }
    catch {
        $activationFailure = $_.Exception
        $ancillaryOnly = [bool]$activationFailure.Data["EchoAncillaryLanFailure"]
        $safeNoTransition = [bool]$activationFailure.Data["EchoSafeNoTransition"]
        $safeUnchangedMutationFailure = $false
        if ($mutationProviderFailed -and $RequestedAction -eq "Restart") {
            try {
                $postErrorConfiguration = Get-EchoCoreHostProductionConfiguration @configurationArgs
                if ($postErrorConfiguration.EnvironmentFilePath -ine $configuration.EnvironmentFilePath) {
                    throw "EchoCoreHost control_env_file changed while the service mutation failed."
                }

                $hardArgs = @{}
                foreach ($providerName in @(
                    "ServiceProvider",
                    "ControlProcessProvider",
                    "ListenerProvider",
                    "HealthProbeProvider"
                )) {
                    $provider = Get-Variable -Name $providerName -ValueOnly
                    if ($null -ne $provider) {
                        $hardArgs[$providerName] = $provider
                    }
                }
                $postErrorSafety = Assert-EchoCoreHostProductionHardSafetyOnce @hardArgs
                $safeUnchangedMutationFailure =
                    $postErrorSafety.ServiceProcessId -eq $preMutationService.ProcessId -and
                    $postErrorSafety.ControlProcessId -eq $preMutationControlProcessId
            }
            catch {
                $safeUnchangedMutationFailure = $false
            }
        }

        if ($mutationPerformed -and
            -not $ancillaryOnly -and
            -not $safeNoTransition -and
            -not $safeUnchangedMutationFailure) {
            try {
                $cleanupArgs = @{
                    Attempts = $Attempts
                    DelayMilliseconds = $DelayMilliseconds
                }
                foreach ($providerName in @("ServiceCleanupProvider", "ServiceProvider", "SleepProvider")) {
                    $provider = Get-Variable -Name $providerName -ValueOnly
                    if ($null -ne $provider) {
                        $cleanupArgs[$providerName] = $provider
                    }
                }
                Stop-EchoCoreHostAfterFailedMutation @cleanupArgs | Out-Null
            }
            catch {
                throw [System.InvalidOperationException]::new(
                    "EchoCoreHost activation failed ('$($activationFailure.Message)') and cleanup also failed: $($_.Exception.Message)"
                )
            }
        }
        throw $activationFailure
    }

    return [PSCustomObject]@{
        Action = $RequestedAction
        HostConfigPath = $configuration.HostConfigPath
        EnvironmentFilePath = $configuration.EnvironmentFilePath
        Bind = $configuration.Bind
        Port = $configuration.Port
        ServiceProcessId = $ingress.ServiceProcessId
        ControlProcessId = $ingress.ControlProcessId
        ListenerAddress = $ingress.ListenerAddress
        ProbeAddress = $ingress.ProbeAddress
        Attempts = $ingress.Attempts
    }
}

if (!$NoMain) {
    $result = Invoke-EchoCoreHostNetworkGuard `
        -RequestedAction $Action `
        -ConfigPath $canonicalHostConfigPath `
        -Attempts $VerificationAttempts `
        -DelayMilliseconds $RetryDelayMilliseconds

    if ($Action -eq "Preflight") {
        Write-Host "EchoCoreHost production network preflight passed: CORE_BIND=$($result.Bind) CORE_PORT=$($result.Port) env=$($result.EnvironmentFilePath)"
    }
    else {
        Write-Host "EchoCoreHost production network verification passed: servicePID=$($result.ServiceProcessId) controlPID=$($result.ControlProcessId) listener=$($result.ListenerAddress):$($result.Port) probe=$($result.ProbeAddress) attempts=$($result.Attempts)"
    }
}
