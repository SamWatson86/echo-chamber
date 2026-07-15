param(
  [string]$Room = "main",
  [string]$Identity = "sam",
  [string]$Name = "Sam",
  [string]$ParticipantAuthKey
)

function Get-ParticipantAuthKey {
  param([string]$ExplicitKey)

  if ($ExplicitKey) {
    if ($ExplicitKey -notmatch '^[0-9a-fA-F]{64}$') {
      throw "ParticipantAuthKey must be exactly 64 hexadecimal characters."
    }
    return $ExplicitKey.ToLowerInvariant()
  }

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not $localAppData) {
    throw "Unable to locate the current user's LocalAppData directory."
  }

  $keyDirectory = Join-Path $localAppData "Echo Chamber"
  $keyPath = Join-Path $keyDirectory "get-token-participant-auth-key"
  if (Test-Path -LiteralPath $keyPath) {
    $storedKey = (Get-Content -LiteralPath $keyPath -Raw).Trim()
    if ($storedKey -notmatch '^[0-9a-fA-F]{64}$') {
      throw "The stored participant auth key is invalid: $keyPath"
    }
    return $storedKey.ToLowerInvariant()
  }

  New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  $generatedKey = ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  [System.IO.File]::WriteAllText($keyPath, $generatedKey)
  return $generatedKey
}

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
$base = "${scheme}://127.0.0.1:$port"
$participantKey = Get-ParticipantAuthKey -ExplicitKey $ParticipantAuthKey
$login = Invoke-RestMethod -Method Post -Uri "$base/v1/auth/login" -ContentType 'application/json' -Body (@{ password = $envMap['CORE_ADMIN_PASSWORD'] } | ConvertTo-Json)
$token = Invoke-RestMethod -Method Post -Uri "$base/v1/auth/token" -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($login.token)" } -Body (@{ room = $Room; identity = $Identity; name = $Name; participantAuthKey = $participantKey } | ConvertTo-Json)
$token.token
