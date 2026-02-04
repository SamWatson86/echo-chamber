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

$vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if (Test-Path $vcvars) {
  $cmd = @"
call \"$vcvars\"
cd /d \"$PSScriptRoot\"
\"%USERPROFILE%\.cargo\bin\cargo.exe\" run -p echo-core-control
"@
  $tmp = Join-Path $PSScriptRoot ".tmp-run-control.cmd"
  Set-Content -Path $tmp -Value $cmd -Encoding ascii
  cmd /c $tmp
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  exit $LASTEXITCODE
}

Write-Host "vcvars64.bat not found. Ensure Visual Studio Build Tools are installed." -ForegroundColor Yellow
cargo run -p echo-core-control
