param(
  [string]$Room = "main",
  [string]$Identity = "sam",
  [string]$Name = "Sam"
)

$envPath = Join-Path $PSScriptRoot ".env"
if (!(Test-Path $envPath)) {
  Write-Host "Missing .env in core/control" -ForegroundColor Yellow
  exit 1
}

$envMap = @{}
Get-Content $envPath | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line.Split('=',2)
  if ($parts.Count -lt 2) { return }
  $envMap[$parts[0].Trim()] = $parts[1].Trim()
}

$port = $envMap['CORE_PORT']
if (-not $port) { $port = "9090" }
$scheme = "http"
if ($envMap['CORE_TLS_CERT']) { $scheme = "https" }
$base = "$scheme://127.0.0.1:$port"
$login = Invoke-RestMethod -Method Post -Uri "$base/v1/auth/login" -ContentType 'application/json' -Body (@{ password = $envMap['CORE_ADMIN_PASSWORD'] } | ConvertTo-Json)
$token = Invoke-RestMethod -Method Post -Uri "$base/v1/auth/token" -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($login.token)" } -Body (@{ room = $Room; identity = $Identity; name = $Name } | ConvertTo-Json)
$token.token
