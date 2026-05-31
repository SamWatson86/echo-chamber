$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "local-release-lib.ps1")

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

function New-TestRepo {
    $root = Join-Path ([System.IO.Path]::GetTempPath()) ("echo-local-release-test-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $root | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root "core\client") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root "core\control") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $root "core\target\release\bundle\nsis") -Force | Out-Null

    Set-Content -Path (Join-Path $root "core\client\Cargo.toml") -Value @"
[package]
name = "echo-core-client"
version = "1.2.3"
"@
    Set-Content -Path (Join-Path $root "core\control\Cargo.toml") -Value @"
[package]
name = "echo-core-control"
version = "1.2.3"
"@
    Set-Content -Path (Join-Path $root "core\client\tauri.conf.json") -Value '{"version":"1.2.3"}'
    Set-Content -Path (Join-Path $root "CHANGELOG.md") -Value @"
# Changelog

## 1.2.3

- Fix: Local releases are fast.
- Safety: Release guardrails verify assets.

## 1.2.2

- Previous release.
"@

    $bundleDir = Join-Path $root "core\target\release\bundle\nsis"
    Set-Content -Path (Join-Path $bundleDir "Echo Chamber_1.2.3_x64-setup.exe") -Value "exe"
    Set-Content -Path (Join-Path $bundleDir "Echo Chamber_1.2.3_x64-setup.exe.sig") -Value "signature"
    Set-Content -Path (Join-Path $bundleDir "latest.json") -Value @"
{
  "version": "1.2.3",
  "platforms": {
    "windows-x86_64": {
      "signature": "signature",
      "url": "https://github.com/SamWatson86/echo-chamber/releases/download/v1.2.3/Echo.Chamber_1.2.3_x64-setup.exe"
    }
  }
}
"@

    return $root
}

$gitRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("echo-local-release-git-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $gitRepo | Out-Null
try {
    & git -C $gitRepo init | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "git init failed"
    }

    $isRepo = Get-GitOutput $gitRepo @("rev-parse", "--is-inside-work-tree")
    Assert-Equal "true" $isRepo "Get-GitOutput forwards git arguments"
}
finally {
    Remove-Item -LiteralPath $gitRepo -Recurse -Force
}

$repo = New-TestRepo
try {
    $versions = Get-ReleaseVersionInfo -Root $repo
    Assert-Equal "1.2.3" $versions.Version "version info returns the shared release version"
    Assert-Equal "1.2.3" $versions.ClientCargoVersion "client Cargo version is parsed"
    Assert-Equal "1.2.3" $versions.ControlCargoVersion "control Cargo version is parsed"
    Assert-Equal "1.2.3" $versions.TauriVersion "Tauri version is parsed"

    Assert-Equal "Echo.Chamber_1.2.3_x64-setup.exe" (ConvertTo-GitHubAssetName "Echo Chamber_1.2.3_x64-setup.exe") "GitHub asset name replaces spaces with dots"

    $bundle = Get-ReleaseBundle -Root $repo -Version "1.2.3"
    Assert-True (Test-Path $bundle.InstallerPath) "installer path exists"
    Assert-True (Test-Path $bundle.SignaturePath) "signature path exists"
    Assert-True (Test-Path $bundle.ManifestPath) "manifest path exists"
    Assert-Equal "Echo.Chamber_1.2.3_x64-setup.exe" $bundle.GitHubInstallerName "bundle returns upload-safe installer name"

    $notesPath = Join-Path $repo "release-notes.txt"
    New-ReleaseNotesFile -Root $repo -Version "1.2.3" -OutputPath $notesPath
    $notes = Get-Content $notesPath -Raw
    Assert-True ($notes.Contains("Local releases are fast")) "release notes include current version entry"
    Assert-True (-not $notes.Contains("Previous release")) "release notes stop at the next version"

    Set-Content -Path (Join-Path $repo "core\control\Cargo.toml") -Value @"
[package]
name = "echo-core-control"
version = "9.9.9"
"@
    $threw = $false
    try {
        Get-ReleaseVersionInfo -Root $repo | Out-Null
    } catch {
        $threw = $true
    }
    Assert-True $threw "mismatched version files fail closed"
}
finally {
    Remove-Item -LiteralPath $repo -Recurse -Force
}

Write-Host "local-release-lib tests passed"
