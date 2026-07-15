param(
    [string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$RuntimeDirectory,
    [switch]$VerifyOnly,
    [switch]$AllowRunningControl
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path (Split-Path $scriptDir -Parent) -Parent
. (Join-Path $scriptDir "viewer-runtime-lib.ps1")

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    $SourceDirectory = Join-Path $root "core\viewer"
}

if ($VerifyOnly) {
    $verified = Assert-ViewerSnapshot -SourceDirectory $SourceDirectory -CandidateDirectory $RuntimeDirectory
    Write-Host "Viewer runtime verified: $($verified.FileCount) files match $SourceDirectory"
    return
}

$result = Publish-ViewerRuntimeSnapshot `
    -SourceDirectory $SourceDirectory `
    -RuntimeDirectory $RuntimeDirectory `
    -AllowRunningControl:$AllowRunningControl

Write-Host "Viewer runtime published: $($result.FileCount) files -> $($result.RuntimeDirectory)"
if ($result.BackupDirectory) {
    Write-Host "Previous viewer retained at: $($result.BackupDirectory)"
}
