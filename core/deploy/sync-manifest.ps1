# Echo Chamber - Sync Update Manifest
# Downloads the latest.json from GitHub Releases to core/deploy/ so the
# control plane serves the correct update manifest for all platforms.
#
# Usage: powershell -ExecutionPolicy Bypass -File sync-manifest.ps1

$deployDir = $PSScriptRoot

function Write-Status([string]$msg, [string]$color = "Cyan") {
    Write-Host "[sync] " -NoNewline -ForegroundColor DarkGray
    Write-Host $msg -ForegroundColor $color
}

# Get the latest release tag
$tag = gh release view --json tagName -q '.tagName' 2>$null
if (!$tag) {
    Write-Status "No GitHub release found. Push a tag first." Red
    return
}

Write-Status "Latest release: $tag"

$manifestPath = Join-Path $deployDir "latest.json"

# Download latest.json from the release
gh release download $tag -p "latest.json" -D $deployDir --clobber 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Status "Failed to download latest.json from release $tag" Red
    return
}

if (Test-Path $manifestPath) {
    $content = Get-Content $manifestPath -Raw | ConvertFrom-Json
    Write-Status "Synced latest.json (v$($content.version))" Green
    $platforms = ($content.platforms | Get-Member -MemberType NoteProperty).Name
    foreach ($p in $platforms) {
        $hasSig = if ($content.platforms.$p.signature) { "signed" } else { "unsigned" }
        Write-Status "  $p - $hasSig" Green
    }
} else {
    Write-Status "Download succeeded but file not found at $manifestPath" Red
}
