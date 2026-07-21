[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 19091,

    [switch]$SkipControlBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$coreManifest = Join-Path $repoRoot 'core\Cargo.toml'
$controlMain = Join-Path $repoRoot 'core\control\src\main.rs'
$diagnosticsSmoke = Join-Path $repoRoot 'core\control\test-diagnostics-api.ps1'
$viewerTests = Join-Path $repoRoot 'core\viewer-tests'
$viewerDeployTests = Join-Path $repoRoot 'core\deploy\test-viewer-runtime-lib.ps1'

function Write-Step {
    param(
        [int]$Number,
        [int]$Total,
        [string]$Label
    )

    Write-Host "`n[readiness $Number/$Total] $Label" -ForegroundColor Cyan
}

function Invoke-NativeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

foreach ($requiredPath in @($coreManifest, $controlMain, $diagnosticsSmoke, $viewerTests, $viewerDeployTests)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Readiness prerequisite is missing: $requiredPath"
    }
}

$gitHead = (& git -C $repoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $gitHead) { throw 'Could not resolve the repository Git HEAD' }
$gitBranch = (& git -C $repoRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the repository Git branch' }
$gitChanges = @(& git -C $repoRoot status --short)
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the repository working tree' }

$totalSteps = 7
Write-Host "Web diagnostics readiness gate" -ForegroundColor Green
Write-Host "Repository: $repoRoot"
Write-Host "Git branch: $gitBranch"
Write-Host "Git HEAD: $gitHead"
Write-Host "Working tree changes: $($gitChanges.Count)"
Write-Host "Isolated API smoke port: $Port"
Write-Host 'This gate does not inspect, stop, restart, or modify live Echo services or clients.'

Write-Step 1 $totalSteps 'Repository quick verification'
Invoke-NativeStep -Command 'npm' -Arguments @('run', 'verify:quick') -WorkingDirectory $repoRoot

Write-Step 2 $totalSteps 'Full browser regression verification'
Invoke-NativeStep -Command 'npm' -Arguments @(
    '--prefix', $viewerTests,
    'test'
) -WorkingDirectory $repoRoot

Write-Step 3 $totalSteps 'Locked control-plane tests'
Invoke-NativeStep -Command 'cargo' -Arguments @(
    'test',
    '--locked',
    '--manifest-path', $coreManifest,
    '-p', 'echo-core-control'
) -WorkingDirectory $repoRoot

Write-Step 4 $totalSteps 'Control entry-point format check (children skipped)'
Invoke-NativeStep -Command 'rustfmt' -Arguments @(
    '--edition', '2021',
    '--check',
    '--config', 'skip_children=true',
    $controlMain
) -WorkingDirectory $repoRoot

Write-Step 5 $totalSteps 'Atomic viewer runtime deployment tests'
Invoke-NativeStep -Command 'powershell' -Arguments @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $viewerDeployTests
) -WorkingDirectory $repoRoot

Write-Step 6 $totalSteps 'Locked control-plane build for isolated smoke'
if ($SkipControlBuild) {
    Write-Host 'Using the existing debug control binary by explicit request.' -ForegroundColor Yellow
} else {
    Invoke-NativeStep -Command 'cargo' -Arguments @(
        'build',
        '--locked',
        '--manifest-path', $coreManifest,
        '-p', 'echo-core-control'
    ) -WorkingDirectory $repoRoot
}

Write-Step 7 $totalSteps 'Isolated diagnostics API and static-asset smoke test'
$smokeParameters = @{ Port = $Port; SkipBuild = $true }
& $diagnosticsSmoke @smokeParameters

Write-Host "`n[readiness] PASS - web diagnostics are ready for manual testing." -ForegroundColor Green
