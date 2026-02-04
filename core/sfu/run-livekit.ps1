param(
  [string]$Config = "$PSScriptRoot\livekit.yaml"
)

if (!(Get-Command livekit-server -ErrorAction SilentlyContinue)) {
  Write-Host "livekit-server not found on PATH. Install LiveKit server first." -ForegroundColor Yellow
  exit 1
}

if (!(Test-Path $Config)) {
  $example = "$PSScriptRoot\livekit.yaml.example"
  if (Test-Path $example) {
    Copy-Item -Path $example -Destination $Config -Force
    Write-Host "Created $Config from example. Please update keys before running." -ForegroundColor Yellow
    exit 1
  }
  Write-Host "Config not found: $Config" -ForegroundColor Red
  exit 1
}

Write-Host "Starting LiveKit with config: $Config" -ForegroundColor Cyan
livekit-server --config $Config
