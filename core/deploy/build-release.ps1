# Echo Chamber - Build Release Installer
# Builds the NSIS installer and generates the update manifest for GitHub Releases.
#
# Usage: powershell -ExecutionPolicy Bypass -File build-release.ps1
#
# Output goes to: core/target/release/bundle/nsis/
#   - Echo Chamber_<version>_x64-setup.exe       (installer for friends)
#   - Echo Chamber_<version>_x64-setup.exe.sig   (signature for auto-updates)
#   - latest.json                                 (update manifest for GitHub Releases)

param(
    [switch]$SkipBuild
)

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$coreDir = Join-Path $root "core"
$clientDir = Join-Path $coreDir "client"
$privateKey = Join-Path $clientDir ".tauri-keys"

function Write-Status([string]$msg, [string]$color = "Cyan") {
    Write-Host "[release] " -NoNewline -ForegroundColor DarkGray
    Write-Host $msg -ForegroundColor $color
}

# Check for signing key
if (!(Test-Path $privateKey)) {
    Write-Status "ERROR: No signing key found at $privateKey" Red
    Write-Status "Generate one with:" Yellow
    Write-Status "  cd core\client" Yellow
    Write-Status "  `$env:CI='true'; cargo tauri signer generate --ci -p 'echo' -w .tauri-keys -f" Yellow
    return
}

# Read version from tauri.conf.json
$confPath = Join-Path $clientDir "tauri.conf.json"
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$version = $conf.version
Write-Status "Building Echo Chamber v$version"

if (!$SkipBuild) {
    Write-Status "Building NSIS installer (this takes a few minutes)..."
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $privateKey -Raw).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "echo"
    $env:CI = "true"

    Push-Location $clientDir
    cargo tauri build 2>&1
    $buildResult = $LASTEXITCODE
    Pop-Location

    if ($buildResult -ne 0) {
        Write-Status "Build failed!" Red
        return
    }
}

# Find the output files
$bundleDir = Join-Path $coreDir "target\release\bundle\nsis"
if (!(Test-Path $bundleDir)) {
    Write-Status "No NSIS bundle directory found at $bundleDir" Red
    return
}

Write-Status "Build output:"
Get-ChildItem $bundleDir | ForEach-Object {
    $sizeMB = [math]::Round($_.Length / 1MB, 1)
    Write-Status "  $($_.Name) ($sizeMB MB)" Green
}

# Generate latest.json for the Tauri updater (v2 format: .exe + .exe.sig)
$setupExe = Get-ChildItem $bundleDir -Filter "*-setup.exe" | Select-Object -First 1
$setupSig = Get-ChildItem $bundleDir -Filter "*-setup.exe.sig" | Select-Object -First 1

if ($setupExe -and $setupSig) {
    $sig = Get-Content $setupSig.FullName -Raw
    $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

    $manifest = @{
        version = $version
        notes = "Echo Chamber v$version"
        pub_date = $now
        platforms = @{
            "windows-x86_64" = @{
                signature = $sig.Trim()
                url = "https://github.com/SamWatson86/echo-chamber/releases/download/v$version/$($setupExe.Name)"
            }
        }
    } | ConvertTo-Json -Depth 4

    $manifestPath = Join-Path $bundleDir "latest.json"
    Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
    Write-Status "Update manifest written to latest.json" Green
} else {
    Write-Status "Warning: Could not find .exe or .sig file for update manifest" Yellow
}

Write-Status ""
Write-Status "=== RELEASE READY ===" Green
Write-Status ""
Write-Status "To publish this release:"
Write-Status "  1. Go to https://github.com/SamWatson86/echo-chamber/releases/new"
Write-Status "  2. Tag: v$version"
Write-Status "  3. Upload these files from $bundleDir :"
Write-Status "     - The .exe installer (for friends to download)"
Write-Status "     - The .exe.sig (signature for auto-updates)"
Write-Status "     - latest.json (update manifest)"
Write-Status ""
Write-Status "Or use gh CLI:"
Write-Status "  gh release create v$version --title 'Echo Chamber v$version' $bundleDir\*"
