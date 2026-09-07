# A short-lived public maintenance notice, served by the existing viewer route.
# Only the deployment host writes it. It contains no credentials or free-form text.
function Get-EchoRestartNoticeDirectory([string]$EnvironmentFilePath) {
    $paths = @(Get-ProductionEnvironmentAssignments -Lines ([IO.File]::ReadAllLines($EnvironmentFilePath)) -Name 'ECHO_CORE_VIEWER_DIR')
    if ($paths.Count -ne 1 -or $paths[0] -notmatch '^[A-Za-z]:[\\/]') {
        throw 'Restart notices require one absolute ECHO_CORE_VIEWER_DIR in the active environment.'
    }
    return [IO.Path]::GetFullPath($paths[0]).TrimEnd('\', '/')
}

function Set-EchoRestartNotice {
    param(
        [Parameter(Mandatory = $true)][string]$ViewerDirectory,
        [Parameter(Mandatory = $true)][ValidateSet('Restarting', 'Ready')][string]$State,
        [long]$NowMilliseconds = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    )
    if ($ViewerDirectory -notmatch '^[A-Za-z]:[\\/]') { throw 'Viewer directory must be an absolute Windows path.' }
    $root = [IO.Path]::GetFullPath($ViewerDirectory).TrimEnd('\', '/')
    if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Viewer runtime directory is missing.' }
    # Refuse redirected directories/files before writing the exact runtime target.
    $ancestor = Get-Item -LiteralPath $root -Force
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Restart notice path contains a reparse point.' }
        $ancestor = $ancestor.Parent
    }
    $target = [IO.Path]::GetFullPath((Join-Path $root 'restart-notice.json'))
    if (!$target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Restart notice escaped its runtime directory.' }
    if ((Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Restart notice file is a reparse point.'
    }
    if ($State -eq 'Restarting') {
        $notice = [ordered]@{ state='restarting'; id=[Guid]::NewGuid().ToString(); started_at=$NowMilliseconds; expires_at=($NowMilliseconds + 120000) }
        $bytes = [Text.Encoding]::UTF8.GetBytes(($notice | ConvertTo-Json -Compress))
    }
    else {
        # Preserve the exact committed bytes so viewer snapshot verification stays exact.
        $bytes = [IO.File]::ReadAllBytes((Join-Path $PSScriptRoot '..\viewer\restart-notice.json'))
    }
    $temporary = Join-Path $root ('.restart-notice-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary, $target, [System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temporary, $target) }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}
