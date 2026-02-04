$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot
$env:ECHO_ENV = "prod"
$env:NODE_ENV = "production"
Write-Host "Starting Echo Chamber (prod) using $env:ECHO_ENV" -ForegroundColor Cyan
npm run start -w @echo/server
