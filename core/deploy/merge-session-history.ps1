[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SourceDirectory,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$DestinationDirectory,

    [string]$BackupDirectory,

    [switch]$Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sessionFilePattern = '^sessions-(?<date>\d{4}-\d{2}-\d{2})\.json$'
$allowedEventProperties = @(
    'event_type',
    'identity',
    'name',
    'room_id',
    'timestamp',
    'duration_secs'
)
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)

function Get-NormalizedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $root.Length) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    }
    return $fullPath
}

function Resolve-SafeExistingDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Role
    )

    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        throw "$Role is not a directory: $Path"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Role may not be a symlink or junction: $($item.FullName)"
    }

    $fullPath = Get-NormalizedPath -Path $item.FullName
    $root = Get-NormalizedPath -Path ([System.IO.Path]::GetPathRoot($fullPath))
    if ([string]::Equals($fullPath, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Role may not be a filesystem root: $fullPath"
    }
    return $fullPath
}

function Resolve-SafeNewDirectoryPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Role
    )

    $fullPath = Get-NormalizedPath -Path $Path
    $root = Get-NormalizedPath -Path ([System.IO.Path]::GetPathRoot($fullPath))
    if ([string]::Equals($fullPath, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Role may not be a filesystem root: $fullPath"
    }
    return $fullPath
}

function Test-PathEqual {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    return [string]::Equals(
        (Get-NormalizedPath -Path $Left),
        (Get-NormalizedPath -Path $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Child,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $normalizedChild = (Get-NormalizedPath -Path $Child) + [System.IO.Path]::DirectorySeparatorChar
    $normalizedParent = (Get-NormalizedPath -Path $Parent) + [System.IO.Path]::DirectorySeparatorChar
    return $normalizedChild.StartsWith(
        $normalizedParent,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Get-SessionFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][string]$Role
    )

    $allFiles = @(Get-ChildItem -LiteralPath $Directory -File -Force)
    $unsafeSessionNames = @(
        $allFiles | Where-Object {
            $_.Name -imatch '^sessions' -and $_.Name -cnotmatch $sessionFilePattern
        }
    )
    if ($unsafeSessionNames.Count -gt 0) {
        $names = ($unsafeSessionNames | ForEach-Object { $_.Name }) -join ', '
        throw "$Role contains unsafe or non-session filenames with the reserved 'sessions' prefix: $names"
    }

    $sessionFiles = @($allFiles | Where-Object { $_.Name -cmatch $sessionFilePattern } | Sort-Object Name)
    foreach ($file in $sessionFiles) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Role contains a session file that is a symlink or junction: $($file.FullName)"
        }

        $null = $file.Name -cmatch $sessionFilePattern
        $dateText = $Matches['date']
        $parsedDate = [DateTime]::MinValue
        $validDate = [DateTime]::TryParseExact(
            $dateText,
            'yyyy-MM-dd',
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None,
            [ref]$parsedDate
        )
        if (-not $validDate -or $parsedDate.ToString('yyyy-MM-dd') -ne $dateText) {
            throw "$Role contains a session filename with an invalid UTC date: $($file.Name)"
        }
    }

    return $sessionFiles
}

function ConvertTo-UnsignedInteger {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Field,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($null -eq $Value -or $Value -is [bool]) {
        throw "$Context has an invalid $Field value"
    }
    $text = [System.Convert]::ToString($Value, [System.Globalization.CultureInfo]::InvariantCulture)
    if ($text -cnotmatch '^\d+$') {
        throw "$Context has a non-integer $Field value: $text"
    }
    $number = [UInt64]0
    if (-not [UInt64]::TryParse(
        $text,
        [System.Globalization.NumberStyles]::None,
        [System.Globalization.CultureInfo]::InvariantCulture,
        [ref]$number
    )) {
        throw "$Context has an out-of-range $Field value: $text"
    }
    return $number
}

function ConvertTo-NormalizedEvent {
    param(
        [Parameter(Mandatory = $true)]$InputEvent,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($null -eq $InputEvent -or $InputEvent -is [string] -or $InputEvent -is [System.Array]) {
        throw "$Context is not a session event object"
    }

    $properties = @($InputEvent.PSObject.Properties.Name)
    foreach ($required in @('event_type', 'identity', 'name', 'room_id', 'timestamp')) {
        if ($properties -cnotcontains $required) {
            throw "$Context is missing required property '$required'"
        }
    }
    $unknown = @($properties | Where-Object { $allowedEventProperties -cnotcontains $_ })
    if ($unknown.Count -gt 0) {
        throw "$Context contains unsupported properties: $($unknown -join ', ')"
    }

    foreach ($field in @('event_type', 'identity', 'name', 'room_id')) {
        if ($InputEvent.$field -isnot [string]) {
            throw "$Context has a non-string $field value"
        }
    }
    if ($InputEvent.event_type -cnotin @('join', 'leave')) {
        throw "$Context has an unsupported event_type: $($InputEvent.event_type)"
    }

    $timestamp = ConvertTo-UnsignedInteger -Value $InputEvent.timestamp -Field 'timestamp' -Context $Context
    if ($timestamp -eq 0 -or $timestamp -gt 253402300799) {
        throw "$Context has a timestamp outside the supported UTC calendar range: $timestamp"
    }

    $duration = $null
    if ($properties -ccontains 'duration_secs' -and $null -ne $InputEvent.duration_secs) {
        $duration = ConvertTo-UnsignedInteger -Value $InputEvent.duration_secs -Field 'duration_secs' -Context $Context
    }

    $normalized = [ordered]@{
        event_type = [string]$InputEvent.event_type
        identity = [string]$InputEvent.identity
        name = [string]$InputEvent.name
        room_id = [string]$InputEvent.room_id
        timestamp = $timestamp
    }
    if ($null -ne $duration) {
        $normalized['duration_secs'] = $duration
    }

    $dedupShape = [ordered]@{
        event_type = [string]$InputEvent.event_type
        identity = [string]$InputEvent.identity
        name = [string]$InputEvent.name
        room_id = [string]$InputEvent.room_id
        timestamp = $timestamp
        duration_secs = $duration
    }
    $key = ConvertTo-Json -InputObject $dedupShape -Compress -Depth 3
    $utcDate = [DateTimeOffset]::FromUnixTimeSeconds([Int64]$timestamp).UtcDateTime.ToString('yyyy-MM-dd')

    return [pscustomobject]@{
        Key = $key
        UtcDate = $utcDate
        Event = [pscustomobject]$normalized
    }
}

function Read-SessionFile {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    $raw = [System.IO.File]::ReadAllText($File.FullName)
    $trimmed = $raw.Trim()
    if (-not $trimmed.StartsWith('[') -or -not $trimmed.EndsWith(']')) {
        throw "$($File.FullName) must contain a JSON array"
    }

    $parsed = ConvertFrom-Json -InputObject $raw
    if ($null -eq $parsed) {
        $events = @()
    }
    elseif ($parsed -is [System.Array]) {
        $events = @($parsed)
    }
    else {
        $events = @($parsed)
    }

    $normalizedEvents = @()
    for ($index = 0; $index -lt $events.Count; $index++) {
        $normalizedEvents += ConvertTo-NormalizedEvent `
            -InputEvent $events[$index] `
            -Context "$($File.FullName) event[$index]"
    }
    return $normalizedEvents
}

function Get-FileSnapshot {
    param([Parameter(Mandatory = $true)][System.IO.FileInfo]$File)

    return [pscustomobject]@{
        Name = $File.Name
        FullName = $File.FullName
        Length = [Int64]$File.Length
        LastWriteTimeUtc = $File.LastWriteTimeUtc.ToString('o')
        Sha256 = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash
    }
}

function Assert-DestinationUnchanged {
    param(
        [Parameter(Mandatory = $true)][string]$Destination,
        [Parameter(Mandatory = $true)][hashtable]$Snapshots
    )

    $currentFiles = @(Get-SessionFiles -Directory $Destination -Role 'DestinationDirectory')
    if ($currentFiles.Count -ne $Snapshots.Count) {
        throw 'Destination session files changed after the merge scan; rerun the command.'
    }
    foreach ($file in $currentFiles) {
        if (-not $Snapshots.ContainsKey($file.Name)) {
            throw "Destination session file appeared after the merge scan: $($file.Name)"
        }
        $snapshot = $Snapshots[$file.Name]
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        if ($file.Length -ne $snapshot.Length -or $hash -ne $snapshot.Sha256) {
            throw "Destination session file changed after the merge scan: $($file.Name)"
        }
    }
}

function ConvertTo-SessionJson {
    param([Parameter(Mandatory = $true)][object[]]$Events)

    if ($Events.Count -eq 0) {
        return "[]`n"
    }
    $json = ConvertTo-Json -InputObject $Events -Depth 4
    return $json + "`n"
}

function Write-AtomicSessionFile {
    param(
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [Parameter(Mandatory = $true)][string]$Contents,
        [Parameter(Mandatory = $true)][System.Text.Encoding]$Encoding
    )

    $directory = [System.IO.Path]::GetDirectoryName($TargetPath)
    $operationId = [Guid]::NewGuid().ToString('N')
    $tempName = '.echo-session-merge-' + $operationId + '.tmp'
    $tempPath = Join-Path $directory $tempName
    $replaceBackupPath = Join-Path $directory ('.echo-session-replace-' + $operationId + '.bak')
    try {
        [System.IO.File]::WriteAllText($tempPath, $Contents, $Encoding)
        if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
            [System.IO.File]::Replace($tempPath, $TargetPath, $replaceBackupPath, $true)
        }
        else {
            [System.IO.File]::Move($tempPath, $TargetPath)
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force
        }
        if (Test-Path -LiteralPath $replaceBackupPath -PathType Leaf) {
            Remove-Item -LiteralPath $replaceBackupPath -Force
        }
    }
}

$destination = Resolve-SafeExistingDirectory -Path $DestinationDirectory -Role 'DestinationDirectory'
$sources = @()
$sourceSet = @{}
foreach ($sourcePath in $SourceDirectory) {
    $source = Resolve-SafeExistingDirectory -Path $sourcePath -Role 'SourceDirectory'
    if (Test-PathEqual -Left $source -Right $destination) {
        throw "SourceDirectory must not equal DestinationDirectory: $source"
    }
    if ($sourceSet.ContainsKey($source.ToLowerInvariant())) {
        throw "SourceDirectory was supplied more than once: $source"
    }
    $sourceSet[$source.ToLowerInvariant()] = $true
    $sources += $source
}

$plannedBackup = if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
    Join-Path `
        ([System.IO.Path]::GetDirectoryName($destination)) `
        ('session-history-backup-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
}
else {
    $BackupDirectory
}
$plannedBackup = Resolve-SafeNewDirectoryPath -Path $plannedBackup -Role 'BackupDirectory'
if (Test-PathEqual -Left $plannedBackup -Right $destination) {
    throw 'BackupDirectory must not equal DestinationDirectory.'
}
if (Test-PathWithin -Child $plannedBackup -Parent $destination) {
    throw 'BackupDirectory must not be inside DestinationDirectory.'
}
foreach ($source in $sources) {
    if ((Test-PathEqual -Left $plannedBackup -Right $source) -or
        (Test-PathWithin -Child $plannedBackup -Parent $source)) {
        throw 'BackupDirectory must not equal or be inside a SourceDirectory.'
    }
}
if ($Apply -and (Test-Path -LiteralPath $plannedBackup)) {
    throw "BackupDirectory already exists; choose a new path: $plannedBackup"
}

$eventsByDate = @{}
$allEventKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
$changedDates = @{}
$destinationSnapshots = @{}
$destinationEvents = 0
$destinationDuplicates = 0
$destinationDateMismatches = 0

$destinationFiles = @(Get-SessionFiles -Directory $destination -Role 'DestinationDirectory')
foreach ($file in $destinationFiles) {
    $null = $file.Name -cmatch $sessionFilePattern
    $fileDate = $Matches['date']
    $destinationSnapshots[$file.Name] = Get-FileSnapshot -File $file
    $normalizedEvents = @(Read-SessionFile -File $file)
    $destinationEvents += $normalizedEvents.Count

    foreach ($normalizedEvent in $normalizedEvents) {
        if ($normalizedEvent.UtcDate -ne $fileDate) {
            $destinationDateMismatches++
            $changedDates[$fileDate] = $true
            $changedDates[$normalizedEvent.UtcDate] = $true
        }
        if (-not $allEventKeys.Add([string]$normalizedEvent.Key)) {
            $destinationDuplicates++
            $changedDates[$fileDate] = $true
            continue
        }

        if (-not $eventsByDate.ContainsKey($normalizedEvent.UtcDate)) {
            $eventsByDate[$normalizedEvent.UtcDate] = New-Object `
                'System.Collections.Generic.Dictionary[string,object]' `
                ([System.StringComparer]::Ordinal)
        }
        $eventsByDate[$normalizedEvent.UtcDate][$normalizedEvent.Key] = $normalizedEvent.Event
    }
}

$sourceSummaries = @()
$sourceEvents = 0
$sourceDuplicates = 0
$sourceEventsAdded = 0
$sourceDateMismatches = 0
foreach ($source in $sources) {
    $files = @(Get-SessionFiles -Directory $source -Role "SourceDirectory '$source'")
    if ($files.Count -eq 0) {
        throw "SourceDirectory contains no session history files: $source"
    }

    $directoryEvents = 0
    $directoryDuplicates = 0
    $directoryAdded = 0
    $directoryDateMismatches = 0
    foreach ($file in $files) {
        $null = $file.Name -cmatch $sessionFilePattern
        $fileDate = $Matches['date']
        $normalizedEvents = @(Read-SessionFile -File $file)
        $directoryEvents += $normalizedEvents.Count

        foreach ($normalizedEvent in $normalizedEvents) {
            if ($normalizedEvent.UtcDate -ne $fileDate) {
                $directoryDateMismatches++
            }
            if (-not $allEventKeys.Add([string]$normalizedEvent.Key)) {
                $directoryDuplicates++
                continue
            }

            if (-not $eventsByDate.ContainsKey($normalizedEvent.UtcDate)) {
                $eventsByDate[$normalizedEvent.UtcDate] = New-Object `
                    'System.Collections.Generic.Dictionary[string,object]' `
                    ([System.StringComparer]::Ordinal)
            }
            $eventsByDate[$normalizedEvent.UtcDate][$normalizedEvent.Key] = $normalizedEvent.Event
            $changedDates[$normalizedEvent.UtcDate] = $true
            $directoryAdded++
        }
    }

    $sourceEvents += $directoryEvents
    $sourceDuplicates += $directoryDuplicates
    $sourceEventsAdded += $directoryAdded
    $sourceDateMismatches += $directoryDateMismatches
    $sourceSummaries += [pscustomobject][ordered]@{
        path = $source
        files = $files.Count
        events = $directoryEvents
        exact_duplicates = $directoryDuplicates
        unique_events_added = $directoryAdded
        filename_date_mismatches = $directoryDateMismatches
    }
}

$fileActions = @()
foreach ($date in @($changedDates.Keys | Sort-Object)) {
    $targetName = "sessions-$date.json"
    $targetPath = Join-Path $destination $targetName
    $events = @(
        if ($eventsByDate.ContainsKey($date)) {
            $eventsByDate[$date].GetEnumerator() |
                Sort-Object { [UInt64]$_.Value.timestamp }, Key -CaseSensitive |
                ForEach-Object { $_.Value }
        }
    )
    $fileActions += [pscustomobject][ordered]@{
        utc_date = $date
        action = if (Test-Path -LiteralPath $targetPath -PathType Leaf) { 'replace' } else { 'create' }
        events = $events.Count
        target = $targetPath
        contents = ConvertTo-SessionJson -Events $events
    }
}

$backupFiles = 0
if ($Apply -and $fileActions.Count -gt 0) {
    Assert-DestinationUnchanged -Destination $destination -Snapshots $destinationSnapshots

    $null = New-Item -ItemType Directory -Path $plannedBackup
    foreach ($snapshot in $destinationSnapshots.Values) {
        $backupPath = Join-Path $plannedBackup $snapshot.Name
        [System.IO.File]::Copy($snapshot.FullName, $backupPath, $false)
        $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
        if ($backupHash -ne $snapshot.Sha256) {
            throw "Destination backup verification failed for $($snapshot.Name)"
        }
        $backupFiles++
    }

    $manifest = [ordered]@{
        schema_version = 2
        created_at_utc = [DateTime]::UtcNow.ToString('o')
        destination = $destination
        created_paths = @(
            $fileActions |
                Where-Object { $_.action -eq 'create' } |
                ForEach-Object { [System.IO.Path]::GetFileName([string]$_.target) } |
                Sort-Object
        )
        destination_files = @(
            $destinationSnapshots.Values |
                Sort-Object Name |
                ForEach-Object {
                    [ordered]@{
                        name = $_.Name
                        length = $_.Length
                        last_write_time_utc = $_.LastWriteTimeUtc
                        sha256 = $_.Sha256
                    }
                }
        )
    }
    $manifestJson = (ConvertTo-Json -InputObject $manifest -Depth 6) + "`n"
    [System.IO.File]::WriteAllText(
        (Join-Path $plannedBackup 'manifest.json'),
        $manifestJson,
        $utf8WithoutBom
    )

    Assert-DestinationUnchanged -Destination $destination -Snapshots $destinationSnapshots
    foreach ($fileAction in $fileActions) {
        Write-AtomicSessionFile `
            -TargetPath $fileAction.target `
            -Contents $fileAction.contents `
            -Encoding $utf8WithoutBom
    }
}

$summaryActions = @(
    $fileActions | ForEach-Object {
        [ordered]@{
            utc_date = $_.utc_date
            action = $_.action
            events = $_.events
            target = $_.target
        }
    }
)
$summary = [ordered]@{
    ok = $true
    mode = if ($Apply) { 'apply' } else { 'preview' }
    applied = [bool]($Apply -and $fileActions.Count -gt 0)
    destination = $destination
    sources = $sourceSummaries
    destination_files_before = $destinationFiles.Count
    destination_events_before = $destinationEvents
    source_events_read = $sourceEvents
    exact_duplicates = $destinationDuplicates + $sourceDuplicates
    destination_exact_duplicates = $destinationDuplicates
    source_exact_duplicates = $sourceDuplicates
    unique_source_events_added = $sourceEventsAdded
    unique_events_after = $allEventKeys.Count
    filename_date_mismatches = $destinationDateMismatches + $sourceDateMismatches
    changed_files = $fileActions.Count
    changes = $summaryActions
    backup_directory = if ($Apply -and $fileActions.Count -eq 0) { $null } else { $plannedBackup }
    backup_files = $backupFiles
}

$summary | ConvertTo-Json -Depth 8
