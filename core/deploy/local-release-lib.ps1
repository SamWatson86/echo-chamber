$ErrorActionPreference = "Stop"

function Write-ReleaseStatus([string]$Message, [string]$Color = "Cyan") {
    Write-Host "[local-release] " -NoNewline -ForegroundColor DarkGray
    Write-Host $Message -ForegroundColor $Color
}

function ConvertTo-GitHubAssetName([string]$FileName) {
    return $FileName -replace ' ', '.'
}

function Get-TomlPackageVersion([string]$Path) {
    if (!(Test-Path $Path)) {
        throw "Missing version file: $Path"
    }

    $match = Select-String -Path $Path -Pattern '^\s*version\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (!$match) {
        throw "Could not find package version in $Path"
    }

    return $match.Matches[0].Groups[1].Value
}

function Test-ChangelogHasVersion([string]$Root, [string]$Version) {
    $path = Join-Path $Root "CHANGELOG.md"
    if (!(Test-Path $path)) {
        return $false
    }

    $content = Get-Content $path -Raw
    $escaped = [regex]::Escape($Version)
    return [bool]($content -match "(?m)^##\s+$escaped\s*$")
}

function Get-ReleaseVersionInfo([string]$Root) {
    $clientCargoPath = Join-Path $Root "core\client\Cargo.toml"
    $controlCargoPath = Join-Path $Root "core\control\Cargo.toml"
    $tauriConfigPath = Join-Path $Root "core\client\tauri.conf.json"

    if (!(Test-Path $tauriConfigPath)) {
        throw "Missing Tauri config: $tauriConfigPath"
    }

    $clientCargoVersion = Get-TomlPackageVersion $clientCargoPath
    $controlCargoVersion = Get-TomlPackageVersion $controlCargoPath
    $tauriVersion = (Get-Content $tauriConfigPath -Raw | ConvertFrom-Json).version

    $versions = @($clientCargoVersion, $controlCargoVersion, $tauriVersion) | Select-Object -Unique
    if ($versions.Count -ne 1) {
        throw "Version files disagree: client Cargo=$clientCargoVersion, control Cargo=$controlCargoVersion, tauri=$tauriVersion"
    }

    if (!(Test-ChangelogHasVersion -Root $Root -Version $tauriVersion)) {
        throw "CHANGELOG.md is missing a '## $tauriVersion' release entry"
    }

    return [pscustomobject]@{
        Version = $tauriVersion
        ClientCargoVersion = $clientCargoVersion
        ControlCargoVersion = $controlCargoVersion
        TauriVersion = $tauriVersion
    }
}

function Get-ReleaseBundle([string]$Root, [string]$Version) {
    $bundleDir = Join-Path $Root "core\target\release\bundle\nsis"
    if (!(Test-Path $bundleDir)) {
        throw "NSIS bundle directory does not exist: $bundleDir"
    }

    $installer = Get-ChildItem $bundleDir -Filter "*_${Version}_*-setup.exe" |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $signature = Get-ChildItem $bundleDir -Filter "*_${Version}_*-setup.exe.sig" |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    $manifestPath = Join-Path $bundleDir "latest.json"

    if (!$installer) {
        throw "Missing installer for version $Version in $bundleDir"
    }
    if (!$signature) {
        throw "Missing installer signature for version $Version in $bundleDir"
    }
    if (!(Test-Path $manifestPath)) {
        throw "Missing latest.json in $bundleDir"
    }

    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.version -ne $Version) {
        throw "latest.json version '$($manifest.version)' does not match $Version"
    }

    $platform = $manifest.platforms.'windows-x86_64'
    if (!$platform) {
        throw "latest.json is missing platforms.windows-x86_64"
    }
    if ([string]::IsNullOrWhiteSpace($platform.signature)) {
        throw "latest.json windows-x86_64 signature is empty"
    }

    $githubInstallerName = ConvertTo-GitHubAssetName $installer.Name
    $expectedUrlFragment = "/releases/download/v$Version/$githubInstallerName"
    if ($platform.url -notlike "*$expectedUrlFragment") {
        throw "latest.json URL '$($platform.url)' does not point at $expectedUrlFragment"
    }

    return [pscustomobject]@{
        BundleDir = $bundleDir
        InstallerPath = $installer.FullName
        SignaturePath = $signature.FullName
        ManifestPath = $manifestPath
        GitHubInstallerName = $githubInstallerName
        GitHubSignatureName = ConvertTo-GitHubAssetName $signature.Name
    }
}

function New-ReleaseNotesFile([string]$Root, [string]$Version, [string]$OutputPath) {
    $path = Join-Path $Root "CHANGELOG.md"
    if (!(Test-Path $path)) {
        throw "Missing CHANGELOG.md"
    }

    $lines = Get-Content $path
    $notes = New-Object System.Collections.Generic.List[string]
    $inSection = $false
    $versionPattern = '^\s*##\s+' + [regex]::Escape($Version) + '\s*$'

    foreach ($line in $lines) {
        if ($line -match '^\s*##\s+') {
            if ($inSection) {
                break
            }
            if ($line -match $versionPattern) {
                $inSection = $true
                continue
            }
        }

        if ($inSection) {
            $notes.Add($line)
        }
    }

    $text = ($notes -join [Environment]::NewLine).Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        $text = "Update to v$Version"
    }

    [System.IO.File]::WriteAllText($OutputPath, $text)
}

function Invoke-CheckedCommand([string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [string]$Label) {
    Write-ReleaseStatus $Label
    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        $exitCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode"
    }
}

function Get-RequiredCommand([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (!$command) {
        throw "Required command not found on PATH: $Name"
    }
    return $command.Source
}

function Get-GitOutput([string]$Root, [string[]]$GitArgs) {
    $output = & git -C $Root @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Assert-LocalReleaseGitState([string]$Root, [string]$Remote, [string]$Branch, [string]$Tag) {
    $status = Get-GitOutput $Root @("status", "--porcelain")
    if (![string]::IsNullOrWhiteSpace($status)) {
        throw "Working tree must be clean before publishing a local release"
    }

    $currentBranch = Get-GitOutput $Root @("branch", "--show-current")
    if ($currentBranch -ne $Branch) {
        throw "Local release must run from branch '$Branch'; current branch is '$currentBranch'"
    }

    $head = Get-GitOutput $Root @("rev-parse", "HEAD")
    $remoteHead = Get-GitOutput $Root @("rev-parse", "$Remote/$Branch")
    if ($head -ne $remoteHead) {
        throw "HEAD ($head) does not match $Remote/$Branch ($remoteHead). Pull/merge first."
    }

    $localTag = Get-GitOutput $Root @("tag", "--list", $Tag)
    if (![string]::IsNullOrWhiteSpace($localTag)) {
        throw "Local tag already exists: $Tag"
    }

    $remoteTag = Get-GitOutput $Root @("ls-remote", "--tags", $Remote, "refs/tags/$Tag")
    if (![string]::IsNullOrWhiteSpace($remoteTag)) {
        throw "Remote tag already exists: $Tag"
    }
}

function Copy-ReleaseUploadAssets([object]$Bundle, [string]$Version) {
    $uploadDir = Join-Path $Bundle.BundleDir "upload-v$Version"
    New-Item -ItemType Directory -Path $uploadDir -Force | Out-Null

    $installerUpload = Join-Path $uploadDir $Bundle.GitHubInstallerName
    $signatureUpload = Join-Path $uploadDir $Bundle.GitHubSignatureName
    $manifestUpload = Join-Path $uploadDir "latest.json"

    Copy-Item -LiteralPath $Bundle.InstallerPath -Destination $installerUpload -Force
    Copy-Item -LiteralPath $Bundle.SignaturePath -Destination $signatureUpload -Force
    Copy-Item -LiteralPath $Bundle.ManifestPath -Destination $manifestUpload -Force

    return [pscustomobject]@{
        InstallerPath = $installerUpload
        SignaturePath = $signatureUpload
        ManifestPath = $manifestUpload
    }
}
