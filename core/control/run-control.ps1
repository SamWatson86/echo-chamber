param(
  [string]$EnvFile = "$PSScriptRoot\.env"
)

function Load-Env([string]$path) {
  if (!(Test-Path $path)) { return }
  Get-Content $path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -lt 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ($name) { [Environment]::SetEnvironmentVariable($name, $expanded, "Process") }
  }
}

Load-Env $EnvFile

Write-Host "Starting Echo Core control plane" -ForegroundColor Cyan
cargo run -p echo-core-control
