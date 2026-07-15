$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "deploy-config-lib.ps1")

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

function Read-TestConfig([string]$Path) {
    return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("echo-deploy-config-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    $pushBuildText = [System.IO.File]::ReadAllText((Join-Path $scriptDir "push-build.ps1"))
    $optInGuardIndex = $pushBuildText.IndexOf('if (-not $PushConfig)')
    $capabilityGuardIndex = $pushBuildText.IndexOf('Test-EchoClientConfigUpdateCapability -Health $healthData')
    $configPostIndex = $pushBuildText.IndexOf('Invoke-WebRequest -Uri "$baseUrl/config"')
    Assert-True ($optInGuardIndex -ge 0 -and $optInGuardIndex -lt $configPostIndex) "push-build defaults to skipping config before the config endpoint"
    Assert-True ($capabilityGuardIndex -ge 0 -and $capabilityGuardIndex -lt $configPostIndex) "push-build verifies merge capability before the config endpoint"

    $oldHealth = [PSCustomObject]@{ agent = "ok" }
    $wrongHealth = [PSCustomObject]@{ config_update_mode = "overwrite-v0" }
    $safeHealth = [PSCustomObject]@{ config_update_mode = "preserve-jam-source-v1" }
    Assert-True (-not (Test-EchoClientConfigUpdateCapability -Health $null)) "missing health cannot authorize config upload"
    Assert-True (-not (Test-EchoClientConfigUpdateCapability -Health $oldHealth)) "an old agent without a capability marker cannot authorize config upload"
    Assert-True (-not (Test-EchoClientConfigUpdateCapability -Health $wrongHealth)) "an unknown capability marker cannot authorize config upload"
    Assert-True (Test-EchoClientConfigUpdateCapability -Health $safeHealth) "the exact merge-safe capability authorizes config upload"

    $agentSource = Join-Path $testRoot "agent-source"
    $agentInstall = Join-Path $testRoot "agent-install"
    New-Item -ItemType Directory -Path $agentSource | Out-Null
    New-Item -ItemType Directory -Path $agentInstall | Out-Null
    Set-Content -LiteralPath (Join-Path $agentSource "agent.ps1") -Value "agent-test-content"
    Set-Content -LiteralPath (Join-Path $agentSource "deploy-config-lib.ps1") -Value "library-test-content"
    $installedFiles = @(Install-EchoDeployAgentScripts -SourceDirectory $agentSource -InstallDirectory $agentInstall)
    Assert-Equal 2 $installedFiles.Count "agent setup installs both required scripts"
    Assert-True (Test-Path -LiteralPath (Join-Path $agentInstall "agent.ps1") -PathType Leaf) "agent setup installs agent.ps1"
    Assert-True (Test-Path -LiteralPath (Join-Path $agentInstall "deploy-config-lib.ps1") -PathType Leaf) "agent setup installs the merge helper"

    Remove-Item -LiteralPath (Join-Path $agentSource "deploy-config-lib.ps1") -Force
    $incompleteInstall = Join-Path $testRoot "incomplete-install"
    New-Item -ItemType Directory -Path $incompleteInstall | Out-Null
    $threw = $false
    try {
        Install-EchoDeployAgentScripts -SourceDirectory $agentSource -InstallDirectory $incompleteInstall | Out-Null
    } catch [System.IO.FileNotFoundException] {
        $threw = $true
    }
    Assert-True $threw "agent setup fails when the merge helper is missing"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $incompleteInstall "agent.ps1"))) "agent setup validates the full set before copying anything"

    $configPath = Join-Path $testRoot "config.json"
    $original = @'
{
  "server": "https://old.example.test",
  "obsolete_setting": true,
  "jam_source": {
    "id": "source-host",
    "token": "test-secret-that-must-survive",
    "nested": { "mode": "spotify" }
  }
}
'@
    [System.IO.File]::WriteAllText($configPath, $original, (New-Object System.Text.UTF8Encoding($false)))

    $result = Set-EchoClientConfig -IncomingJson '{"server":"https://new.example.test"}' -ConfigPath $configPath
    $updated = Read-TestConfig $configPath
    Assert-Equal "https://new.example.test" $updated.server "normal server updates are applied"
    Assert-Equal "source-host" $updated.jam_source.id "existing Jam source ID is preserved"
    Assert-Equal "test-secret-that-must-survive" $updated.jam_source.token "existing Jam source token is preserved"
    Assert-Equal "spotify" $updated.jam_source.nested.mode "the complete Jam source block is preserved"
    Assert-True ($null -eq $updated.obsolete_setting) "unprotected settings still follow the incoming config"
    Assert-True $result.JamSourceWasPreserved "the write reports that it preserved Jam source config"
    Assert-True (-not $result.JamSourceWasExplicit) "an omitted Jam source is not treated as explicit"

    $replacement = '{"server":"https://replacement.example.test","jam_source":{"id":"replacement-host","token":"replacement-token"}}'
    $result = Set-EchoClientConfig -IncomingJson $replacement -ConfigPath $configPath
    $updated = Read-TestConfig $configPath
    Assert-Equal "replacement-host" $updated.jam_source.id "an explicit Jam source replaces the installed block"
    Assert-Equal "replacement-token" $updated.jam_source.token "an explicit Jam source token replaces the installed token"
    Assert-True $result.JamSourceWasExplicit "an included Jam source is reported as explicit"
    Assert-True (-not $result.JamSourceWasPreserved) "an explicit replacement is not reported as preserved"

    $result = Set-EchoClientConfig -IncomingJson '{"server":"https://no-source.example.test","jam_source":null}' -ConfigPath $configPath
    $updated = Read-TestConfig $configPath
    $jamSourceProperty = Get-EchoClientConfigProperty -Config $updated -Name "jam_source"
    Assert-True ($null -ne $jamSourceProperty) "an explicit null Jam source remains explicit"
    Assert-True ($null -eq $jamSourceProperty.Value) "an explicit null removes Jam source credentials"
    Assert-True $result.JamSourceWasExplicit "an explicit null is reported as explicit"

    $knownGood = '{"server":"https://known-good.example.test","jam_source":{"id":"safe-host","token":"safe-token"}}'
    [System.IO.File]::WriteAllText($configPath, $knownGood, (New-Object System.Text.UTF8Encoding($false)))
    $beforeRejectedUpdate = [System.IO.File]::ReadAllText($configPath)
    $threw = $false
    try {
        Set-EchoClientConfig -IncomingJson '{not-json' -ConfigPath $configPath | Out-Null
    } catch [System.IO.InvalidDataException] {
        $threw = $true
    }
    Assert-True $threw "malformed incoming JSON is rejected"
    Assert-Equal $beforeRejectedUpdate ([System.IO.File]::ReadAllText($configPath)) "a rejected update leaves installed credentials untouched"

    [System.IO.File]::WriteAllText($configPath, '{broken-existing', (New-Object System.Text.UTF8Encoding($false)))
    $beforeRejectedUpdate = [System.IO.File]::ReadAllText($configPath)
    $threw = $false
    try {
        Set-EchoClientConfig -IncomingJson '{"server":"https://new.example.test"}' -ConfigPath $configPath | Out-Null
    } catch [System.IO.InvalidDataException] {
        $threw = $true
    }
    Assert-True $threw "a malformed existing config fails closed when protected credentials were omitted"
    Assert-Equal $beforeRejectedUpdate ([System.IO.File]::ReadAllText($configPath)) "a failed-closed merge does not overwrite the existing file"

    $result = Set-EchoClientConfig -IncomingJson $replacement -ConfigPath $configPath
    $updated = Read-TestConfig $configPath
    Assert-Equal "replacement-host" $updated.jam_source.id "an explicit Jam source can repair a malformed installed config"
    Assert-True $result.JamSourceWasExplicit "repairing malformed config requires an explicit Jam source"

    Remove-Item -LiteralPath $configPath -Force
    Set-EchoClientConfig -IncomingJson '{"server":"https://first-install.example.test"}' -ConfigPath $configPath | Out-Null
    $updated = Read-TestConfig $configPath
    Assert-Equal "https://first-install.example.test" $updated.server "first install writes normal config without a protected block"
    Assert-True ($null -eq (Get-EchoClientConfigProperty -Config $updated -Name "jam_source")) "first install does not invent Jam source credentials"

    $bytes = [System.IO.File]::ReadAllBytes($configPath)
    $hasUtf8Bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    Assert-True (-not $hasUtf8Bom) "written config uses UTF-8 without a BOM"
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}

Write-Host "deploy-config-lib tests passed"
