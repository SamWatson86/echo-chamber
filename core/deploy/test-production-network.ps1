[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
if (!(Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) {
    throw "Windows PowerShell 5.1 is required for the production network verification gate."
}

$testScripts = @(
    (Join-Path $PSScriptRoot "test-production-network-lib.ps1"),
    (Join-Path $PSScriptRoot "test-echo-core-host-network-guard.ps1"),
    (Join-Path $PSScriptRoot "test-viewer-runtime-lib.ps1")
)

foreach ($testScript in $testScripts) {
    if (!(Test-Path -LiteralPath $testScript -PathType Leaf)) {
        throw "Production network verification prerequisite is missing: $testScript"
    }

    Write-Host "[production-network] Running $(Split-Path -Leaf $testScript)"
    & $windowsPowerShell `
        -NoProfile `
        -ExecutionPolicy Bypass `
        -File $testScript
    if ($LASTEXITCODE -ne 0) {
        throw "Production network verification failed with exit code $LASTEXITCODE`: $testScript"
    }
}

Write-Host "production network Windows verification passed"
