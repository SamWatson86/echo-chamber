# Echo Chamber - Fast local Windows release publisher
#
# Builds/signs the Windows installer on this PC, publishes the GitHub Release,
# uploads the updater manifest, then copies latest.json into core/deploy/ so
# the live control plane can serve it immediately.
#
# Normal use from a clean, up-to-date main branch:
#   powershell -ExecutionPolicy Bypass -File core\deploy\publish-local-release.ps1

param(
    [string]$Repo = "SamWatson86/echo-chamber",
    [string]$Remote = "origin",
    [string]$Branch = "main",
    [switch]$SkipBuild,
    [switch]$SkipChecks,
    [switch]$Draft,
    [switch]$NoManifestSync
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path (Split-Path $scriptDir -Parent) -Parent
$coreDir = Join-Path $root "core"
$buildScript = Join-Path $scriptDir "build-release.ps1"
$testScript = Join-Path $scriptDir "test-local-release-lib.ps1"
. (Join-Path $scriptDir "local-release-lib.ps1")

function Test-GitHubReleaseExists([string]$RepoName, [string]$ReleaseTag) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & gh release view $ReleaseTag --repo $RepoName --json tagName 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -eq 0) {
        return $true
    }

    $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($text -match "release not found") {
        return $false
    }

    throw "Failed to check GitHub Release ${ReleaseTag}: $text"
}

Get-RequiredCommand "git" | Out-Null
Get-RequiredCommand "gh" | Out-Null
Get-RequiredCommand "powershell" | Out-Null

$versionInfo = Get-ReleaseVersionInfo -Root $root
$version = $versionInfo.Version
$tag = "v$version"

Write-ReleaseStatus "Preparing local Windows release $tag"

Invoke-CheckedCommand "git" @("fetch", $Remote, $Branch, "--tags") $root "Fetching $Remote/$Branch and tags"
Assert-LocalReleaseGitState -Root $root -Remote $Remote -Branch $Branch -Tag $tag

& gh auth status -h github.com
if ($LASTEXITCODE -ne 0) {
    throw "gh is not authenticated for github.com"
}

if (Test-GitHubReleaseExists -RepoName $Repo -ReleaseTag $tag) {
    throw "GitHub Release already exists: $tag"
}

if (!$SkipChecks) {
    Invoke-CheckedCommand "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $testScript) $root "Running local release helper tests"
    Invoke-CheckedCommand "cargo" @("check", "-p", "echo-core-control") $coreDir "Checking control package"
    Invoke-CheckedCommand "node" @("--check", "core\viewer\changelog.js") $root "Checking viewer changelog syntax"
}

$buildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $buildScript)
if ($SkipBuild) {
    $buildArgs += "-SkipBuild"
}
Invoke-CheckedCommand "powershell" $buildArgs $root "Building signed Windows installer"

$bundle = Get-ReleaseBundle -Root $root -Version $version
$uploadAssets = Copy-ReleaseUploadAssets -Bundle $bundle -Version $version

$notesPath = Join-Path $bundle.BundleDir "release-notes-$tag.txt"
New-ReleaseNotesFile -Root $root -Version $version -OutputPath $notesPath

$targetSha = Get-GitOutput $root @("rev-parse", "HEAD")
$releaseArgs = @(
    "release", "create", $tag,
    "--repo", $Repo,
    "--target", $targetSha,
    "--title", "Echo Chamber $tag",
    "--notes-file", $notesPath
)
if ($Draft) {
    $releaseArgs += "--draft"
}
$releaseArgs += @(
    $uploadAssets.InstallerPath,
    $uploadAssets.SignaturePath,
    $uploadAssets.ManifestPath
)

Invoke-CheckedCommand "gh" $releaseArgs $root "Creating GitHub Release $tag"

$releaseJson = & gh release view $tag --repo $Repo --json tagName,url,assets,isDraft | ConvertFrom-Json
if ($releaseJson.tagName -ne $tag) {
    throw "Release verification returned tag '$($releaseJson.tagName)', expected '$tag'"
}

$assetNames = @($releaseJson.assets | ForEach-Object { $_.name })
foreach ($requiredAsset in @($bundle.GitHubInstallerName, $bundle.GitHubSignatureName, "latest.json")) {
    if ($assetNames -notcontains $requiredAsset) {
        throw "Release $tag is missing asset '$requiredAsset'"
    }
}

if (!$NoManifestSync) {
    $deployManifest = Join-Path $scriptDir "latest.json"
    Copy-Item -LiteralPath $bundle.ManifestPath -Destination $deployManifest -Force
    $synced = Get-Content $deployManifest -Raw | ConvertFrom-Json
    if ($synced.version -ne $version) {
        throw "Synced core\deploy\latest.json version '$($synced.version)' does not match $version"
    }
    Write-ReleaseStatus "Synced core\deploy\latest.json to $version" Green
    Write-ReleaseStatus "core\deploy\latest.json is now a local metadata change; commit it through the normal PR path after verification." Yellow
}

Write-ReleaseStatus "Published ${tag}: $($releaseJson.url)" Green
Write-ReleaseStatus "Friends can download: https://github.com/$Repo/releases/tag/$tag" Green
