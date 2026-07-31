$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

function Write-JsonArray {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][object[]]$Items
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $json = if ($Items.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $Items -Depth 4 }
    [System.IO.File]::WriteAllText($Path, $json + "`n", $encoding)
}

function New-SessionEvent {
    param(
        [Parameter(Mandatory = $true)][string]$Type,
        [Parameter(Mandatory = $true)][string]$Identity,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Room,
        [Parameter(Mandatory = $true)][UInt64]$Timestamp,
        [Nullable[UInt64]]$Duration
    )
    $event = [ordered]@{
        event_type = $Type
        identity = $Identity
        name = $Name
        room_id = $Room
        timestamp = $Timestamp
    }
    if ($null -ne $Duration) {
        $event['duration_secs'] = [UInt64]$Duration
    }
    return [pscustomobject]$event
}

$scriptPath = Join-Path $PSScriptRoot 'merge-session-history.ps1'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('echo-session-merge-test-' + [Guid]::NewGuid().ToString('N'))
$destination = Join-Path $testRoot 'destination'
$sourceOne = Join-Path $testRoot 'source-one'
$sourceTwo = Join-Path $testRoot 'source-two'
$backup = Join-Path $testRoot 'backup'

try {
    $null = New-Item -ItemType Directory -Path $destination, $sourceOne, $sourceTwo

    $jan1Join = New-SessionEvent `
        -Type 'join' `
        -Identity 'sam-1' `
        -Name 'Sam' `
        -Room 'main' `
        -Timestamp ([DateTimeOffset]::Parse('2026-01-01T00:00:01Z').ToUnixTimeSeconds())
    $jan1Leave = New-SessionEvent `
        -Type 'leave' `
        -Identity 'sam-1' `
        -Name 'Sam' `
        -Room 'main' `
        -Timestamp ([DateTimeOffset]::Parse('2026-01-01T00:05:01Z').ToUnixTimeSeconds()) `
        -Duration 300
    $jan2Join = New-SessionEvent `
        -Type 'join' `
        -Identity 'friend-1' `
        -Name 'Friend' `
        -Room 'main' `
        -Timestamp ([DateTimeOffset]::Parse('2026-01-02T01:00:00Z').ToUnixTimeSeconds())
    $jan2CaseVariant = New-SessionEvent `
        -Type 'join' `
        -Identity 'FRIEND-1' `
        -Name 'Friend' `
        -Room 'main' `
        -Timestamp ([DateTimeOffset]::Parse('2026-01-02T01:00:00Z').ToUnixTimeSeconds())

    $destinationFile = Join-Path $destination 'sessions-2026-01-01.json'
    Write-JsonArray -Path $destinationFile -Items @($jan1Join)
    $destinationHashBefore = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
    Write-JsonArray `
        -Path (Join-Path $sourceOne 'sessions-2026-01-01.json') `
        -Items @($jan1Join, $jan1Leave)
    Write-JsonArray `
        -Path (Join-Path $sourceTwo 'sessions-2026-01-02.json') `
        -Items @($jan1Leave, $jan2Join, $jan2CaseVariant)

    $previewJson = & $scriptPath `
        -SourceDirectory @($sourceOne, $sourceTwo) `
        -DestinationDirectory $destination `
        -BackupDirectory $backup
    $preview = $previewJson | ConvertFrom-Json
    Assert-True ($preview.mode -eq 'preview') 'default mode must be preview'
    Assert-True (-not $preview.applied) 'preview must not apply changes'
    Assert-True ($preview.destination_events_before -eq 1) 'preview destination count'
    Assert-True ($preview.source_events_read -eq 5) 'preview source count'
    Assert-True ($preview.source_exact_duplicates -eq 2) 'preview exact dedup count'
    Assert-True ($preview.unique_source_events_added -eq 3) 'preview added count'
    Assert-True ($preview.unique_events_after -eq 4) 'preview union count'
    Assert-True ($preview.changed_files -eq 2) 'preview changed file count'
    Assert-True (-not (Test-Path -LiteralPath $backup)) 'preview must not create a backup'
    Assert-True (
        (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash -eq $destinationHashBefore
    ) 'preview must not modify destination'

    $applyJson = & $scriptPath `
        -SourceDirectory @($sourceOne, $sourceTwo) `
        -DestinationDirectory $destination `
        -BackupDirectory $backup `
        -Apply
    $apply = $applyJson | ConvertFrom-Json
    Assert-True ($apply.mode -eq 'apply') 'apply mode summary'
    Assert-True $apply.applied 'apply must report applied changes'
    Assert-True ($apply.backup_files -eq 1) 'apply must back up every original destination session file'
    Assert-True (Test-Path -LiteralPath (Join-Path $backup 'manifest.json')) 'backup manifest'
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $backup 'manifest.json') | ConvertFrom-Json
    Assert-True ($manifest.schema_version -eq 2) 'backup manifest schema'
    Assert-True (@($manifest.created_paths).Count -eq 1) 'manifest must record every created day file'
    Assert-True (
        [string]::Equals(
            [string]@($manifest.created_paths)[0],
            'sessions-2026-01-02.json',
            [System.StringComparison]::Ordinal
        )
    ) 'manifest created path must be an exact relative session filename'
    Assert-True (
        (Get-FileHash -LiteralPath (Join-Path $backup 'sessions-2026-01-01.json') -Algorithm SHA256).Hash -eq $destinationHashBefore
    ) 'backup must preserve the original destination file'

    $mergedEvents = @()
    Get-ChildItem -LiteralPath $destination -File -Filter 'sessions-*.json' | ForEach-Object {
        $parsed = Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json
        if ($parsed -is [System.Array]) { $mergedEvents += $parsed } else { $mergedEvents += @($parsed) }
    }
    Assert-True ($mergedEvents.Count -eq 4) 'apply must preserve four exact unique events'
    Assert-True (
        @($mergedEvents | Where-Object { $_.identity -ceq 'friend-1' }).Count -eq 1
    ) 'lowercase identity event must remain distinct'
    Assert-True (
        @($mergedEvents | Where-Object { $_.identity -ceq 'FRIEND-1' }).Count -eq 1
    ) 'case-variant identity event must remain distinct'
    Assert-True (
        (Test-Path -LiteralPath (Join-Path $destination 'sessions-2026-01-02.json'))
    ) 'apply must merge events into their UTC-date file'
    Assert-True (
        @(Get-ChildItem -LiteralPath $destination -File -Filter '.echo-session-merge-*.tmp').Count -eq 0
    ) 'atomic writes must not leave temporary files'

    $secondPreviewJson = & $scriptPath `
        -SourceDirectory @($sourceOne, $sourceTwo) `
        -DestinationDirectory $destination `
        -BackupDirectory (Join-Path $testRoot 'second-backup')
    $secondPreview = $secondPreviewJson | ConvertFrom-Json
    Assert-True ($secondPreview.unique_source_events_added -eq 0) 'second merge must be idempotent'
    Assert-True ($secondPreview.changed_files -eq 0) 'idempotent merge must plan no writes'

    $samePathRejected = $false
    try {
        $null = & $scriptPath `
            -SourceDirectory @($destination) `
            -DestinationDirectory $destination `
            -BackupDirectory (Join-Path $testRoot 'same-path-backup')
    }
    catch {
        $samePathRejected = $_.Exception.Message -match 'must not equal'
    }
    Assert-True $samePathRejected 'source equal to destination must be rejected'

    $unsafeSource = Join-Path $testRoot 'unsafe-source'
    $null = New-Item -ItemType Directory -Path $unsafeSource
    [System.IO.File]::WriteAllText(
        (Join-Path $unsafeSource 'sessions-not-a-date.json'),
        '[]',
        (New-Object System.Text.UTF8Encoding($false))
    )
    $unsafeNameRejected = $false
    try {
        $null = & $scriptPath `
            -SourceDirectory @($unsafeSource) `
            -DestinationDirectory $destination `
            -BackupDirectory (Join-Path $testRoot 'unsafe-backup')
    }
    catch {
        $unsafeNameRejected = $_.Exception.Message -match 'unsafe or non-session filenames'
    }
    Assert-True $unsafeNameRejected 'unsafe session-like filenames must be rejected'

    $normalizedDestination = [System.IO.Path]::GetFullPath($destination).TrimEnd([char[]]@('\', '/'))
    $manifestDestination = [System.IO.Path]::GetFullPath([string]$manifest.destination).TrimEnd([char[]]@('\', '/'))
    Assert-True (
        [string]::Equals(
            $manifestDestination,
            $normalizedDestination,
            [System.StringComparison]::OrdinalIgnoreCase
        )
    ) 'rollback manifest destination must match the exact intended directory'

    foreach ($createdPath in @($manifest.created_paths)) {
        $relativeName = [string]$createdPath
        Assert-True (
            $relativeName -cmatch '^sessions-\d{4}-\d{2}-\d{2}\.json$' -and
            [string]::Equals(
                [System.IO.Path]::GetFileName($relativeName),
                $relativeName,
                [System.StringComparison]::Ordinal
            )
        ) 'rollback may remove only a strict relative session filename'
        $createdTarget = [System.IO.Path]::GetFullPath((Join-Path $normalizedDestination $relativeName))
        Assert-True (
            [string]::Equals(
                [System.IO.Path]::GetDirectoryName($createdTarget),
                $normalizedDestination,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        ) 'rollback created path must remain directly inside destination'
        if (Test-Path -LiteralPath $createdTarget -PathType Leaf) {
            Remove-Item -LiteralPath $createdTarget -Force
        }
    }

    foreach ($destinationFileManifest in @($manifest.destination_files)) {
        $originalName = [string]$destinationFileManifest.name
        Assert-True (
            $originalName -cmatch '^sessions-\d{4}-\d{2}-\d{2}\.json$' -and
            [string]::Equals(
                [System.IO.Path]::GetFileName($originalName),
                $originalName,
                [System.StringComparison]::Ordinal
            )
        ) 'rollback may restore only a strict relative session filename'
        $backupFile = Join-Path $backup $originalName
        Assert-True (
            (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash -eq
                [string]$destinationFileManifest.sha256
        ) 'rollback backup hash must match the manifest before restore'
        [System.IO.File]::Copy(
            $backupFile,
            (Join-Path $normalizedDestination $originalName),
            $true
        )
    }

    $restoredNames = @(
        Get-ChildItem -LiteralPath $normalizedDestination -File -Filter 'sessions-*.json' |
            Sort-Object Name |
            ForEach-Object { $_.Name }
    )
    Assert-True ($restoredNames.Count -eq 1) 'rollback must restore the original destination file set'
    Assert-True ($restoredNames[0] -ceq 'sessions-2026-01-01.json') 'rollback must remove created day files'
    Assert-True (
        (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash -eq $destinationHashBefore
    ) 'rollback must restore original destination bytes'

    Write-Host 'merge-session-history tests passed'
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
        $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $expectedPrefix = $resolvedTempRoot.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
        $safeTestRoot = $resolvedTestRoot.StartsWith(
            $expectedPrefix,
            [System.StringComparison]::OrdinalIgnoreCase
        ) -and [System.IO.Path]::GetFileName($resolvedTestRoot).StartsWith(
            'echo-session-merge-test-',
            [System.StringComparison]::Ordinal
        )
        if (-not $safeTestRoot) {
            throw "Refusing to remove unexpected test path: $resolvedTestRoot"
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
