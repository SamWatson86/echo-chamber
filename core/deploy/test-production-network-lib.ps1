$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "production-network-lib.ps1")

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
    } catch {
        if ($_.Exception.Message -notlike $Pattern) {
            throw "Assertion failed: $Message. Wrong error '$($_.Exception.Message)'"
        }
        return
    }

    throw "Assertion failed: $Message. Expected an exception"
}

function New-TestListener([string]$Address, [int]$Port, [long]$ProcessId) {
    return [PSCustomObject]@{
        LocalAddress = $Address
        LocalPort = $Port
        OwningProcess = $ProcessId
    }
}

$validEnvironmentReader = {
    param([string]$Path)
    @(
        "# production control network",
        "UNRELATED=value",
        " CORE_BIND = 0.0.0.0 ",
        "CORE_PORT=9443"
    )
}

$environmentReadCount = 0
$singleReadEnvironmentReader = {
    param([string]$Path)
    $script:environmentReadCount++
    & $validEnvironmentReader $Path
}
$environment = Assert-ProductionControlEnvironment `
    -EnvFilePath "injected-production.env" `
    -ReadEnvironmentFile $singleReadEnvironmentReader
Assert-Equal "0.0.0.0" $environment.Bind "the public IPv4 wildcard is accepted"
Assert-Equal 9443 $environment.Port "the production control port is accepted"
Assert-Equal 1 $environmentReadCount "the active environment is read once to avoid mixed snapshots"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=127.0.0.1", "CORE_PORT=9443")
    }
} "*CORE_BIND must be exactly 0.0.0.0*" "an IPv4 loopback bind is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=::1", "CORE_PORT=9443")
    }
} "*CORE_BIND must be exactly 0.0.0.0*" "an IPv6 loopback bind is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_PORT=9443")
    }
} "*exactly one CORE_BIND assignment; found 0*" "a missing bind assignment is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=0.0.0.0", "core_bind=0.0.0.0", "CORE_PORT=9443")
    }
} "*exactly one CORE_BIND assignment; found 2*" "duplicate bind assignments are rejected case-insensitively"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=0.0.0.0")
    }
} "*exactly one CORE_PORT assignment; found 0*" "a missing port assignment is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=0.0.0.0", "CORE_PORT=9443", "CORE_PORT=9443")
    }
} "*exactly one CORE_PORT assignment; found 2*" "duplicate port assignments are rejected"

Assert-ThrowsLike {
    Assert-ProductionControlEnvironment -EnvFilePath "injected.env" -ReadEnvironmentFile {
        @("CORE_BIND=0.0.0.0", "CORE_PORT=8443")
    }
} "*CORE_PORT must be exactly 9443*" "the wrong production port is rejected"

$expectedPid = 4242
$listenerProvider = {
    param([int]$Port)
    New-TestListener -Address "0.0.0.0" -Port $Port -ProcessId 4242
}
$routeProvider = { "192.168.50.20" }
$probeProvider = {
    param([string]$Address, [int]$Port)
    return $Address -eq "192.168.50.20" -and $Port -eq 9443
}

$listener = Assert-ProductionControlListener `
    -ExpectedControlProcessId $expectedPid `
    -ListenerProvider $listenerProvider
Assert-Equal $expectedPid $listener.ControlProcessId "the listener-only guard reports the expected PID"
Assert-Equal "0.0.0.0" $listener.ListenerAddress "the listener-only guard requires the IPv4 wildcard"

$lanProbe = Assert-ProductionControlLanProbe `
    -DefaultRouteLanIPv4Provider $routeProvider `
    -TcpProbeProvider $probeProvider
Assert-Equal "192.168.50.20" $lanProbe.ProbeAddress "the ancillary LAN guard reports its probe address"

$ingress = Assert-ProductionControlIngress `
    -ExpectedControlProcessId $expectedPid `
    -ListenerProvider $listenerProvider `
    -DefaultRouteLanIPv4Provider $routeProvider `
    -TcpProbeProvider $probeProvider
Assert-Equal $expectedPid $ingress.ControlProcessId "the expected control PID is reported"
Assert-Equal "0.0.0.0" $ingress.ListenerAddress "the verified listener is reported"
Assert-Equal 9443 $ingress.Port "the verified port is reported"
Assert-Equal "192.168.50.20" $ingress.ProbeAddress "the probed LAN address is reported"

Assert-ThrowsLike {
    Assert-ProductionControlListener `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider {
            New-TestListener -Address "192.168.50.20" -Port 9443 -ProcessId 4242
        }
} "*does not own*port 9443*" "a concrete non-loopback listener is rejected because production requires the wildcard"

Assert-ThrowsLike {
    Assert-ProductionControlListener `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider {
            New-TestListener -Address "::" -Port 9443 -ProcessId 4242
        }
} "*does not own*port 9443*" "the IPv6 wildcard does not substitute for required IPv4 ingress"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 8443 -ProcessId 4242 } `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $true }
} "*does not own*port 9443*" "a listener on the wrong port is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider { New-TestListener -Address "0.0.0.0" -Port 9443 -ProcessId 9001 } `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $true }
} "*PID 4242 does not own*" "a listener owned by the wrong process is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider { New-TestListener -Address "127.0.0.1" -Port 9443 -ProcessId 4242 } `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $true }
} "*does not own*" "an IPv4 loopback listener is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider { New-TestListener -Address "::1" -Port 9443 -ProcessId 4242 } `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $true }
} "*does not own*" "an IPv6 loopback listener is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider { @() } `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $true }
} "*does not own*" "a missing listener is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider $listenerProvider `
        -DefaultRouteLanIPv4Provider { "127.0.0.1" } `
        -TcpProbeProvider { $true }
} "*not a usable LAN IPv4*" "a loopback probe target is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider $listenerProvider `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { $false }
} "*did not accept a TCP connection*" "a failed LAN TCP probe is rejected"

Assert-ThrowsLike {
    Assert-ProductionControlIngress `
        -ExpectedControlProcessId $expectedPid `
        -ListenerProvider $listenerProvider `
        -DefaultRouteLanIPv4Provider $routeProvider `
        -TcpProbeProvider { @($true, $true) }
} "*did not accept a TCP connection*" "an ambiguous TCP probe result fails closed"

Write-Host "production-network-lib tests passed"
