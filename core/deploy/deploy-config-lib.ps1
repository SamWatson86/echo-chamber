$EchoClientConfigUpdateMode = "preserve-jam-source-v1"

function Test-EchoClientConfigUpdateCapability {
    param(
        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Health
    )

    if ($null -eq $Health) {
        return $false
    }

    $modeProperty = $Health.PSObject.Properties |
        Where-Object { $_.Name -ceq "config_update_mode" } |
        Select-Object -First 1
    return $null -ne $modeProperty -and $modeProperty.Value -ceq $EchoClientConfigUpdateMode
}

function Install-EchoDeployAgentScripts {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourceDirectory,

        [Parameter(Mandatory = $true)]
        [string]$InstallDirectory
    )

    $requiredFiles = @("agent.ps1", "deploy-config-lib.ps1")
    foreach ($fileName in $requiredFiles) {
        $sourcePath = Join-Path $SourceDirectory $fileName
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw [System.IO.FileNotFoundException]::new("Required deploy agent file is missing: $fileName")
        }
    }

    foreach ($fileName in $requiredFiles) {
        Copy-Item -LiteralPath (Join-Path $SourceDirectory $fileName) -Destination (Join-Path $InstallDirectory $fileName) -Force -ErrorAction Stop
    }

    return $requiredFiles
}

function ConvertFrom-EchoClientConfigJson {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Json,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    try {
        $config = $Json | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw [System.IO.InvalidDataException]::new("$Description must contain valid JSON.")
    }

    if ($null -eq $config -or $config -is [System.Array] -or $config -isnot [PSCustomObject]) {
        throw [System.IO.InvalidDataException]::new("$Description must contain a JSON object.")
    }

    return $config
}

function Get-EchoClientConfigProperty {
    param(
        [Parameter(Mandatory = $true)]
        [PSCustomObject]$Config,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $Config.PSObject.Properties |
        Where-Object { $_.Name -ceq $Name } |
        Select-Object -First 1
}

function Merge-EchoClientConfigJson {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$IncomingJson,

        [Parameter(Mandatory = $true)]
        [string]$ExistingConfigPath
    )

    $incoming = ConvertFrom-EchoClientConfigJson -Json $IncomingJson -Description "Incoming client config"
    $incomingJamSource = Get-EchoClientConfigProperty -Config $incoming -Name "jam_source"
    $jamSourceWasExplicit = $null -ne $incomingJamSource
    $jamSourceWasPreserved = $false

    if (-not $jamSourceWasExplicit -and (Test-Path -LiteralPath $ExistingConfigPath -PathType Leaf)) {
        try {
            $existingJson = [System.IO.File]::ReadAllText($ExistingConfigPath)
        } catch {
            throw [System.IO.InvalidDataException]::new("Existing client config could not be read safely.")
        }

        $existing = ConvertFrom-EchoClientConfigJson -Json $existingJson -Description "Existing client config"
        $existingJamSource = Get-EchoClientConfigProperty -Config $existing -Name "jam_source"
        if ($null -ne $existingJamSource) {
            $incoming | Add-Member -MemberType NoteProperty -Name "jam_source" -Value $existingJamSource.Value -ErrorAction Stop
            $jamSourceWasPreserved = $true
        }
    }

    return [PSCustomObject]@{
        Json = $incoming | ConvertTo-Json -Depth 100 -ErrorAction Stop
        JamSourceWasExplicit = $jamSourceWasExplicit
        JamSourceWasPreserved = $jamSourceWasPreserved
    }
}

function Set-EchoClientConfig {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$IncomingJson,

        [Parameter(Mandatory = $true)]
        [string]$ConfigPath
    )

    $fullConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
    $configDirectory = Split-Path -Parent $fullConfigPath
    if (-not (Test-Path -LiteralPath $configDirectory -PathType Container)) {
        throw [System.IO.DirectoryNotFoundException]::new("Client config directory does not exist.")
    }

    $merged = Merge-EchoClientConfigJson -IncomingJson $IncomingJson -ExistingConfigPath $fullConfigPath
    $tempPath = Join-Path $configDirectory (".{0}.{1}.tmp" -f ([System.IO.Path]::GetFileName($fullConfigPath)), [Guid]::NewGuid().ToString("N"))

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($tempPath, $merged.Json, $utf8NoBom)

        Move-Item -LiteralPath $tempPath -Destination $fullConfigPath -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }

    return [PSCustomObject]@{
        JamSourceWasExplicit = $merged.JamSourceWasExplicit
        JamSourceWasPreserved = $merged.JamSourceWasPreserved
    }
}
