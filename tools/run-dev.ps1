$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$env:ECHO_ENV = "dev"
$env:NODE_ENV = "development"
Write-Host "Starting Echo Chamber (dev) using $env:ECHO_ENV" -ForegroundColor Cyan
npm run dev -w @echo/server
