function Get-ProductionEnvironmentAssignments {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Lines,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $assignments = New-Object System.Collections.Generic.List[string]
    foreach ($rawLine in $Lines) {
        if ($null -eq $rawLine) {
            continue
        }

        $line = ([string]$rawLine).Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            continue
        }

        $separatorIndex = $line.IndexOf("=")
        if ($separatorIndex -lt 1) {
            continue
        }

        $assignmentName = $line.Substring(0, $separatorIndex).Trim()
        if ([string]::Equals($assignmentName, $Name, [System.StringComparison]::OrdinalIgnoreCase)) {
            $assignments.Add($line.Substring($separatorIndex + 1).Trim())
        }
    }

    return $assignments.ToArray()
}

function Assert-ProductionControlEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvFilePath,

        [scriptblock]$ReadEnvironmentFile = {
            param([string]$Path)
            [System.IO.File]::ReadAllLines($Path)
        }
    )

    try {
        $environmentLines = @(& $ReadEnvironmentFile $EnvFilePath)
    } catch {
        throw [System.IO.InvalidDataException]::new("Production control environment could not be read: $($_.Exception.Message)")
    }

    $bindAssignments = @(Get-ProductionEnvironmentAssignments `
        -Lines $environmentLines `
        -Name "CORE_BIND")
    if ($bindAssignments.Count -ne 1) {
        throw [System.IO.InvalidDataException]::new(
            "Production control environment must contain exactly one CORE_BIND assignment; found $($bindAssignments.Count)."
        )
    }
    if ($bindAssignments[0] -cne "0.0.0.0") {
        throw [System.IO.InvalidDataException]::new(
            "Production CORE_BIND must be exactly 0.0.0.0; found '$($bindAssignments[0])'."
        )
    }

    $portAssignments = @(Get-ProductionEnvironmentAssignments `
        -Lines $environmentLines `
        -Name "CORE_PORT")
    if ($portAssignments.Count -ne 1) {
        throw [System.IO.InvalidDataException]::new(
            "Production control environment must contain exactly one CORE_PORT assignment; found $($portAssignments.Count)."
        )
    }
    if ($portAssignments[0] -cne "9443") {
        throw [System.IO.InvalidDataException]::new(
            "Production CORE_PORT must be exactly 9443; found '$($portAssignments[0])'."
        )
    }

    return [PSCustomObject]@{
        Bind = "0.0.0.0"
        Port = 9443
    }
}

function Test-ProductionListenerAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address
    )

    # Production is configured for the IPv4 wildcard specifically. A concrete
    # LAN address can disappear after an adapter or DHCP change, and IPv6Any
    # does not prove that the required IPv4 ingress path exists.
    return $Address -ceq "0.0.0.0"
}

function Test-ProductionLanIPv4Address {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address
    )

    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
        return $false
    }

    $bytes = $parsed.GetAddressBytes()
    if ($parsed.Equals([System.Net.IPAddress]::Any) -or
        $parsed.Equals([System.Net.IPAddress]::Broadcast) -or
        [System.Net.IPAddress]::IsLoopback($parsed) -or
        ($bytes[0] -eq 169 -and $bytes[1] -eq 254) -or
        $bytes[0] -ge 224) {
        return $false
    }

    return $true
}

function Get-ProductionDefaultRouteLanIPv4 {
    $routes = @(Get-NetRoute `
        -AddressFamily IPv4 `
        -DestinationPrefix "0.0.0.0/0" `
        -ErrorAction Stop |
        Sort-Object -Property RouteMetric, InterfaceMetric, InterfaceIndex)

    foreach ($route in $routes) {
        $addresses = @(Get-NetIPAddress `
            -AddressFamily IPv4 `
            -InterfaceIndex $route.InterfaceIndex `
            -ErrorAction Stop |
            Sort-Object -Property SkipAsSource, IPAddress)

        foreach ($address in $addresses) {
            $candidate = [string]$address.IPAddress
            if (Test-ProductionLanIPv4Address -Address $candidate) {
                return $candidate
            }
        }
    }

    throw [System.InvalidOperationException]::new(
        "No usable LAN IPv4 address was found on an IPv4 default route."
    )
}

function Test-ProductionTcpProbe {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address,

        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $client = New-Object System.Net.Sockets.TcpClient(
        [System.Net.Sockets.AddressFamily]::InterNetwork
    )
    $asyncResult = $null
    try {
        $asyncResult = $client.BeginConnect($Address, $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(3000, $false)) {
            return $false
        }

        $client.EndConnect($asyncResult)
        return $client.Connected
    } catch {
        return $false
    } finally {
        if ($null -ne $asyncResult) {
            $asyncResult.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Assert-ProductionControlListener {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$ExpectedControlProcessId,

        [scriptblock]$ListenerProvider = {
            param([int]$Port)
            Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
                Select-Object LocalAddress, LocalPort, OwningProcess
        }
    )

    $requiredPort = 9443
    try {
        $listeners = @(& $ListenerProvider $requiredPort)
    } catch {
        throw [System.InvalidOperationException]::new(
            "Production control listener query failed: $($_.Exception.Message)"
        )
    }

    $ownedListener = $null
    foreach ($listener in $listeners) {
        if ($null -eq $listener) {
            continue
        }

        $listenerPort = 0
        $listenerProcessId = 0L
        if (-not [int]::TryParse([string]$listener.LocalPort, [ref]$listenerPort) -or
            -not [long]::TryParse([string]$listener.OwningProcess, [ref]$listenerProcessId)) {
            continue
        }

        $listenerAddress = [string]$listener.LocalAddress
        if ($listenerPort -eq $requiredPort -and
            $listenerProcessId -eq $ExpectedControlProcessId -and
            (Test-ProductionListenerAddress -Address $listenerAddress)) {
            $ownedListener = $listener
            break
        }
    }

    if ($null -eq $ownedListener) {
        throw [System.InvalidOperationException]::new(
            "Expected control PID $ExpectedControlProcessId does not own the IPv4 wildcard TCP listener 0.0.0.0 on port $requiredPort."
        )
    }

    return [PSCustomObject]@{
        ControlProcessId = $ExpectedControlProcessId
        ListenerAddress = [string]$ownedListener.LocalAddress
        Port = $requiredPort
    }
}

function Assert-ProductionControlLanProbe {
    param(
        [scriptblock]$DefaultRouteLanIPv4Provider = {
            Get-ProductionDefaultRouteLanIPv4
        },

        [scriptblock]$TcpProbeProvider = {
            param([string]$Address, [int]$Port)
            Test-ProductionTcpProbe -Address $Address -Port $Port
        }
    )

    $requiredPort = 9443
    try {
        $probeAddresses = @(& $DefaultRouteLanIPv4Provider)
    } catch {
        throw [System.InvalidOperationException]::new(
            "Production default-route LAN IPv4 lookup failed: $($_.Exception.Message)"
        )
    }
    if ($probeAddresses.Count -ne 1) {
        throw [System.InvalidOperationException]::new(
            "Production ingress verification requires exactly one default-route LAN IPv4 address; found $($probeAddresses.Count)."
        )
    }

    $probeAddress = [string]$probeAddresses[0]
    if (-not (Test-ProductionLanIPv4Address -Address $probeAddress)) {
        throw [System.InvalidOperationException]::new(
            "Production default-route address '$probeAddress' is not a usable LAN IPv4 address."
        )
    }

    try {
        $probeResults = @(& $TcpProbeProvider $probeAddress $requiredPort)
    } catch {
        throw [System.InvalidOperationException]::new(
            "Production LAN TCP probe failed: $($_.Exception.Message)"
        )
    }
    if ($probeResults.Count -ne 1 -or $probeResults[0] -isnot [bool] -or -not $probeResults[0]) {
        throw [System.InvalidOperationException]::new(
            "Production control did not accept a TCP connection at ${probeAddress}:$requiredPort."
        )
    }

    return [PSCustomObject]@{
        Port = $requiredPort
        ProbeAddress = $probeAddress
    }
}

function Assert-ProductionControlIngress {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateRange(1, [int]::MaxValue)]
        [int]$ExpectedControlProcessId,

        [scriptblock]$ListenerProvider = {
            param([int]$Port)
            Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
                Select-Object LocalAddress, LocalPort, OwningProcess
        },

        [scriptblock]$DefaultRouteLanIPv4Provider = {
            Get-ProductionDefaultRouteLanIPv4
        },

        [scriptblock]$TcpProbeProvider = {
            param([string]$Address, [int]$Port)
            Test-ProductionTcpProbe -Address $Address -Port $Port
        }
    )

    $listener = Assert-ProductionControlListener `
        -ExpectedControlProcessId $ExpectedControlProcessId `
        -ListenerProvider $ListenerProvider
    $probe = Assert-ProductionControlLanProbe `
        -DefaultRouteLanIPv4Provider $DefaultRouteLanIPv4Provider `
        -TcpProbeProvider $TcpProbeProvider

    return [PSCustomObject]@{
        ControlProcessId = $listener.ControlProcessId
        ListenerAddress = $listener.ListenerAddress
        Port = $listener.Port
        ProbeAddress = $probe.ProbeAddress
    }
}
