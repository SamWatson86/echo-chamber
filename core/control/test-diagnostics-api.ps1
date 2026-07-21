param(
    [int]$Port = 19091,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$coreDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$exe = Join-Path $coreDir 'target\debug\echo-core-control.exe'
if (-not $SkipBuild) {
    & cargo build -p echo-core-control --manifest-path (Join-Path $coreDir 'Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Control-plane build failed' }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "Missing test binary: $exe" }

$portProbe = $null
try {
    $portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $portProbe.Start()
}
catch {
    throw "Diagnostics smoke-test port $Port is already in use or unavailable"
}
finally {
    if ($null -ne $portProbe) { $portProbe.Stop() }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = [IO.Path]::GetFullPath((Join-Path $tempRoot ('echo-diag-smoke-' + [guid]::NewGuid().ToString('N'))))
if (-not $testRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or $testRoot -eq $tempRoot) {
    throw 'Unsafe diagnostics smoke-test path'
}

$viewerDir = Join-Path $testRoot 'viewer'
$adminDir = Join-Path $testRoot 'admin'
$logsDir = Join-Path $testRoot 'logs'
$diagDir = Join-Path $logsDir 'diagnostics'
$chatDir = Join-Path $logsDir 'chat'
$uploadsDir = Join-Path $logsDir 'uploads'
$soundDir = Join-Path $logsDir 'soundboard'
New-Item -ItemType Directory -Force -Path $viewerDir, $adminDir, $diagDir, $chatDir, $uploadsDir, $soundDir | Out-Null
$adminSource = Join-Path $coreDir 'admin'
if (-not (Test-Path -LiteralPath (Join-Path $adminSource 'diagnostics\index.html'))) {
    throw 'Missing owner diagnostics UI fixture'
}
Copy-Item -Path (Join-Path $adminSource '*') -Destination $adminDir -Recurse

$environmentNames = @(
    'CORE_BIND', 'CORE_PORT', 'ECHO_CORE_VIEWER_DIR', 'ECHO_CORE_ADMIN_DIR',
    'CORE_SESSION_LOG_DIR', 'CORE_DIAGNOSTICS_DIR', 'CORE_DIAGNOSTICS_RETENTION_DAYS',
    'CORE_DIAGNOSTICS_MAX_MB', 'CORE_CHAT_DIR', 'CORE_CHAT_UPLOADS_DIR',
    'CORE_SOUNDBOARD_DIR', 'CORE_ADMIN_PASSWORD', 'CORE_ADMIN_JWT_SECRET',
    'CORE_DIAGNOSTICS_OWNER_SECRET', 'LK_API_KEY', 'LK_API_SECRET', 'CORE_TLS_CERT',
    'CORE_TLS_KEY', 'CORE_TLS_SELF_SIGNED', 'GITHUB_PAT', 'JAM_SOURCE_TOKEN'
)
$priorEnvironment = @{}
foreach ($environmentName in $environmentNames) {
    $priorEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable($environmentName, 'Process')
}

$ownerSecret = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:CORE_BIND = '127.0.0.1'
$env:CORE_PORT = "$Port"
$env:ECHO_CORE_VIEWER_DIR = $viewerDir
$env:ECHO_CORE_ADMIN_DIR = $adminDir
$env:CORE_SESSION_LOG_DIR = Join-Path $logsDir 'sessions'
$env:CORE_DIAGNOSTICS_DIR = $diagDir
$env:CORE_DIAGNOSTICS_RETENTION_DAYS = '14'
$env:CORE_DIAGNOSTICS_MAX_MB = '5'
$env:CORE_CHAT_DIR = $chatDir
$env:CORE_CHAT_UPLOADS_DIR = $uploadsDir
$env:CORE_SOUNDBOARD_DIR = $soundDir
$env:CORE_ADMIN_PASSWORD = 'synthetic-room-password'
$env:CORE_ADMIN_JWT_SECRET = 'synthetic-admin-jwt-secret-not-owner'
$env:CORE_DIAGNOSTICS_OWNER_SECRET = $ownerSecret
$env:LK_API_KEY = 'synthetic-livekit-key'
$env:LK_API_SECRET = 'synthetic-livekit-secret-not-owner'
Remove-Item Env:CORE_TLS_CERT, Env:CORE_TLS_KEY, Env:CORE_TLS_SELF_SIGNED, Env:GITHUB_PAT, Env:JAM_SOURCE_TOKEN -ErrorAction SilentlyContinue

$baseUrl = "http://127.0.0.1:$Port"
$process = $null
$isolationProcess = $null
$isolationLink = Join-Path $viewerDir 'linked-diagnostics'

function Invoke-EchoRequest {
    param(
        [string]$Method,
        [string]$Path,
        $Body = $null,
        [string]$Token = ''
    )
    $headers = @{}
    if ($Token) { $headers.Authorization = 'Bearer ' + $Token }
    $parameters = @{
        Method = $Method
        Uri = $baseUrl + $Path
        Headers = $headers
        TimeoutSec = 10
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
    }
    try {
        $response = Invoke-WebRequest @parameters
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Content = [string]$response.Content
            CacheControl = [string]$response.Headers['Cache-Control']
            ContentTypeOptions = [string]$response.Headers['X-Content-Type-Options']
            ReferrerPolicy = [string]$response.Headers['Referrer-Policy']
            FrameOptions = [string]$response.Headers['X-Frame-Options']
        }
    }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if ($null -eq $response) { throw }
        $content = ''
        $stream = $response.GetResponseStream()
        if ($null -ne $stream) {
            $reader = New-Object IO.StreamReader($stream)
            try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        return [pscustomobject]@{
            StatusCode = [int]$response.StatusCode
            Content = $content
            CacheControl = [string]$response.Headers['Cache-Control']
            ContentTypeOptions = [string]$response.Headers['X-Content-Type-Options']
            ReferrerPolicy = [string]$response.Headers['Referrer-Policy']
            FrameOptions = [string]$response.Headers['X-Frame-Options']
        }
    }
}

function Assert-Status($Response, [int]$Expected, [string]$Label) {
    if ($Response.StatusCode -ne $Expected) {
        throw "$Label expected $Expected, got $($Response.StatusCode): $($Response.Content)"
    }
}

try {
    New-Item -ItemType Junction -Path $isolationLink -Target $diagDir | Out-Null
    $isolationStdout = Join-Path $testRoot 'isolation.out.log'
    $isolationStderr = Join-Path $testRoot 'isolation.err.log'
    $isolationProcess = Start-Process -FilePath $exe -WorkingDirectory $coreDir -WindowStyle Hidden -RedirectStandardOutput $isolationStdout -RedirectStandardError $isolationStderr -PassThru
    if (-not $isolationProcess.WaitForExit(5000)) {
        throw 'Control plane did not reject a static-root junction to diagnostics storage'
    }
    if ($isolationProcess.ExitCode -eq 0) {
        throw 'Control plane accepted a static-root junction to diagnostics storage'
    }
    $isolationFailure = [string](Get-Content -Raw $isolationStderr -ErrorAction SilentlyContinue)
    if (-not $isolationFailure.Contains('existing diagnostics storage is not isolated from web-readable roots')) {
        throw ('Unexpected static-root isolation failure: ' + $isolationFailure)
    }
    $isolationProcess.Dispose()
    $isolationProcess = $null
    [IO.Directory]::Delete($isolationLink)

    $stdout = Join-Path $testRoot 'server.out.log'
    $stderr = Join-Path $testRoot 'server.err.log'
    $process = Start-Process -FilePath $exe -WorkingDirectory $coreDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

    $health = $null
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $health = Invoke-EchoRequest GET '/health' } catch {}
        if ($null -ne $health -and $health.StatusCode -eq 200 -and -not $process.HasExited) { break }
        if ($process.HasExited) { break }
    }
    if ($process.HasExited -or $null -eq $health -or $health.StatusCode -ne 200) {
        throw ('Test server failed to start: ' + (Get-Content -Raw $stderr -ErrorAction SilentlyContinue))
    }

    $legacyAdmin = Invoke-EchoRequest GET '/admin/'
    Assert-Status $legacyAdmin 200 'legacy admin asset'
    if (-not $legacyAdmin.Content.Contains('Echo Chamber Admin')) {
        throw 'Diagnostics asset routing replaced the legacy admin surface'
    }
    $legacyAdminScript = Invoke-EchoRequest GET '/admin/admin.js'
    Assert-Status $legacyAdminScript 200 'legacy admin script'
    if (-not $legacyAdminScript.Content.Contains('Echo Chamber Admin Dashboard')) {
        throw 'Diagnostics asset routing replaced the legacy admin script'
    }

    foreach ($ownerAssetPath in @('/admin/diagnostics/', '/admin/diagnostics/diagnostics.js', '/admin/diagnostics/diagnostics.css')) {
        $ownerAsset = Invoke-EchoRequest GET $ownerAssetPath
        Assert-Status $ownerAsset 200 ('owner diagnostics asset ' + $ownerAssetPath)
        if ($ownerAsset.CacheControl -ne 'no-store') { throw "Owner diagnostics asset was cacheable: $ownerAssetPath" }
        if ($ownerAsset.ContentTypeOptions -ne 'nosniff') { throw "Owner diagnostics asset allowed MIME sniffing: $ownerAssetPath" }
        if ($ownerAsset.ReferrerPolicy -ne 'no-referrer') { throw "Owner diagnostics asset allowed referrers: $ownerAssetPath" }
        if ($ownerAsset.FrameOptions -ne 'DENY') { throw "Owner diagnostics asset allowed framing: $ownerAssetPath" }
    }

    $roomLogin = Invoke-EchoRequest POST '/v1/auth/login' @{ password = 'synthetic-room-password' }
    Assert-Status $roomLogin 200 'room login'
    $adminToken = ($roomLogin.Content | ConvertFrom-Json).token

    $badOwner = Invoke-EchoRequest POST '/v1/auth/diagnostics/login' @{ secret = 'synthetic-room-password' }
    Assert-Status $badOwner 401 'room credential at owner login'
    $oversizedOwner = Invoke-EchoRequest POST '/v1/auth/diagnostics/login' ('{"secret":"' + ('x' * 5000) + '"}')
    Assert-Status $oversizedOwner 413 'oversized owner login'
    if ($oversizedOwner.CacheControl -ne 'no-store') { throw 'Oversized owner login response was cacheable' }
    $ownerLogin = Invoke-EchoRequest POST '/v1/auth/diagnostics/login' @{ secret = $ownerSecret }
    Assert-Status $ownerLogin 200 'owner login'
    $ownerToken = ($ownerLogin.Content | ConvertFrom-Json).token

    Assert-Status (Invoke-EchoRequest GET '/admin/api/diagnostics' $null $adminToken) 401 'ordinary admin token at owner route'
    Assert-Status (Invoke-EchoRequest GET '/admin/api/dashboard' $null $ownerToken) 401 'owner token at ordinary admin route'

    $tokenResponse = Invoke-EchoRequest POST '/v1/auth/token' @{
        room = 'main'
        identity = 'sam-smoke-7475'
        name = 'Sam Smoke'
        participantAuthKey = 'a' * 64
    } $adminToken
    Assert-Status $tokenResponse 200 'participant token'
    $participantToken = ($tokenResponse.Content | ConvertFrom-Json).token

    $statsBody = @{ identity = 'spoof'; name = 'spoof'; room = 'wrong'; watch_debug = 'test' }
    Assert-Status (Invoke-EchoRequest POST '/api/client-stats-report' $statsBody $participantToken) 204 'legacy stats before heartbeat'
    Assert-Status (Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' '{}' '') 401 'unauthenticated ingest'
    Assert-Status (Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' '{}' $participantToken) 401 'diagnostics before heartbeat'
    Assert-Status (Invoke-EchoRequest POST '/v1/participants/heartbeat' @{
        room = 'main'; identity = 'sam-smoke-7475'; name = 'Sam Smoke'; viewer_version = 'smoke'
    } $participantToken) 200 'heartbeat'
    Assert-Status (Invoke-EchoRequest POST '/api/client-stats-report' $statsBody $participantToken) 204 'stats after heartbeat'

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $envelope = @{
        schema_version = 1
        envelope_id = '00000000-0000-4000-8000-000000000101'
        install_id = '00000000-0000-4000-8000-000000000102'
        session_id = '00000000-0000-4000-8000-000000000103'
        captured_at_ms = $now - 1000
        sent_at_ms = $now
        app = @{ version = '0.6.33'; git_sha = 'd6191a5f'; channel = 'web-smoke'; runtimes = @{ browser_name = 'Chromium'; browser_version = '152.0.8123.44' } }
        platform = @{ client_kind = 'browser'; operating_system = 'macos'; architecture = 'aarch64'; os_version = '15.5'; os_build = '24F74' }
        events = @(
            @{
                sequence = 1; timestamp_ms = $now - 700; event_type = 'permission'; severity = 'warning'; code = 'microphone.denied'
                message = 'Bearer forbidden-value person@example.invalid 192.0.2.77 F:\private\trace.log https://example.invalid/api?token=forbidden'
                details = @{ permission = 'microphone'; permission_state = 'denied'; actual = 'F:\Users\Example\secret.txt' }
            },
            @{
                sequence = 2; timestamp_ms = $now - 500; event_type = 'connection'; severity = 'error'; code = 'ice.failed'
                message = 'a=candidate:1 1 udp 1 192.0.2.88 50000 typ host ice-ufrag private'
                details = @{ connection_state = 'failed'; candidate_type = 'host' }
            }
        )
    }

    $accepted = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' $envelope $participantToken
    Assert-Status $accepted 202 'valid ingest'
    $incidentId = ($accepted.Content | ConvertFrom-Json).incident_id
    $duplicate = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' $envelope $participantToken
    Assert-Status $duplicate 200 'duplicate ingest'

    $staleAt = $now - (8 * 24 * 60 * 60 * 1000)
    $stale = @{
        schema_version = 1; envelope_id = '00000000-0000-4000-8000-000000000201'; install_id = '00000000-0000-4000-8000-000000000202'; session_id = '00000000-0000-4000-8000-000000000203'
        captured_at_ms = $staleAt; sent_at_ms = $now
        app = @{ version = '0.6.33'; git_sha = 'd6191a5f'; channel = 'web-smoke'; runtimes = @{} }
        platform = @{ client_kind = 'browser'; operating_system = 'macos'; architecture = 'aarch64' }
        events = @(@{ sequence = 1; timestamp_ms = $staleAt; event_type = 'session_start'; severity = 'info'; code = 'session.start'; details = @{ stage = 'start' } })
    }
    $staleResponse = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' $stale $participantToken
    Assert-Status $staleResponse 422 'stale ingest'
    $malformed = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' '{' $participantToken
    Assert-Status $malformed 400 'malformed ingest'
    $uppercaseUuid = $envelope | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $uppercaseUuid.install_id = '00000000-0000-4000-8000-00000000010A'
    Assert-Status (Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' $uppercaseUuid $participantToken) 422 'non-canonical UUID ingest'
    $oversized = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' ('{"padding":"' + ('x' * (256 * 1024)) + '"}') $participantToken
    Assert-Status $oversized 413 'oversized ingest'
    if ($oversized.CacheControl -ne 'no-store') { throw 'Oversized ingest response was cacheable' }

    $list = Invoke-EchoRequest GET '/admin/api/diagnostics?limit=10' $null $ownerToken
    Assert-Status $list 200 'owner list'
    $badQuery = Invoke-EchoRequest GET '/admin/api/diagnostics?limit=not-a-number' $null $ownerToken
    Assert-Status $badQuery 400 'owner malformed query'
    if ($badQuery.CacheControl -ne 'no-store') { throw 'Owner query rejection was cacheable' }
    $listCount = @(($list.Content | ConvertFrom-Json).incidents).Count
    if ($listCount -ne 1) { throw "Owner list expected one incident, got $listCount" }
    $detail = Invoke-EchoRequest GET ('/admin/api/diagnostics/' + $incidentId) $null $ownerToken
    Assert-Status $detail 200 'owner detail'
    $detailPayload = $detail.Content | ConvertFrom-Json
    if ($detailPayload.envelope.app.runtimes.browser_version -ne '152.0.8123.44') {
        throw 'Owner detail did not preserve the Chrome full version'
    }
    $download = Invoke-EchoRequest GET ('/admin/api/diagnostics/' + $incidentId + '/download') $null $ownerToken
    Assert-Status $download 200 'owner download'
    foreach ($forbidden in @('forbidden-value', 'person@example.invalid', '192.0.2.77', 'F:\private', 'candidate:', 'ice-ufrag private')) {
        if ($download.Content.Contains($forbidden)) { throw "Download retained forbidden value: $forbidden" }
    }
    if ($download.Content.Contains('"message"')) { throw 'Download retained a free-form event message' }

    $rateLimitedAt = 0
    for ($retry = 1; $retry -le 25; $retry++) {
        $response = Invoke-EchoRequest POST '/api/diagnostics/v1/envelopes' $envelope $participantToken
        if ($response.StatusCode -eq 429) { $rateLimitedAt = $retry; break }
        Assert-Status $response 200 "duplicate retry $retry"
    }
    if ($rateLimitedAt -eq 0) { throw 'Diagnostics rate limit was not enforced' }

    Assert-Status (Invoke-EchoRequest DELETE ('/admin/api/diagnostics/' + $incidentId) $null $ownerToken) 204 'owner delete'
    Assert-Status (Invoke-EchoRequest GET ('/admin/api/diagnostics/' + $incidentId) $null $ownerToken) 404 'get after delete'

    [pscustomobject]@{
        Health = 200
        StaticLinkIsolation = 'startup rejected junction'
        OwnerBoundary = '401/401 isolated'
        OwnerBodyLimit = $oversizedOwner.StatusCode
        HeartbeatGate = 'diagnostics rejected before heartbeat'
        Ingest = $accepted.StatusCode
        Duplicate = $duplicate.StatusCode
        Stale = $staleResponse.StatusCode
        Malformed = $malformed.StatusCode
        CanonicalUuid = 'uppercase rejected'
        Oversized = $oversized.StatusCode
        Redaction = 'verified in owner download'
        BrowserVersion = $detailPayload.envelope.app.runtimes.browser_version
        RateLimitedAtRetry = $rateLimitedAt
        Delete = 204
    }
}
finally {
    if ($null -ne $isolationProcess -and -not $isolationProcess.HasExited) {
        $runningIsolation = Get-Process -Id $isolationProcess.Id -ErrorAction SilentlyContinue
        if ($null -ne $runningIsolation -and [IO.Path]::GetFullPath($runningIsolation.Path) -eq [IO.Path]::GetFullPath($exe)) {
            Stop-Process -Id $isolationProcess.Id -Force
        }
    }
    if ($null -ne $isolationProcess) {
        try { $null = $isolationProcess.WaitForExit(5000) } catch {}
        $isolationProcess.Dispose()
    }
    if ($null -ne $process -and -not $process.HasExited) {
        $running = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        if ($null -ne $running -and [IO.Path]::GetFullPath($running.Path) -eq [IO.Path]::GetFullPath($exe)) {
            Stop-Process -Id $process.Id -Force
        }
    }
    if ($null -ne $process) {
        try { $null = $process.WaitForExit(5000) } catch {}
        $process.Dispose()
    }
    if (Test-Path -LiteralPath $isolationLink) {
        [IO.Directory]::Delete($isolationLink)
    }
    if (Test-Path -LiteralPath $testRoot) {
        $resolved = [IO.Path]::GetFullPath($testRoot)
        if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and $resolved -ne $tempRoot) {
            for ($cleanupAttempt = 0; $cleanupAttempt -lt 20 -and (Test-Path -LiteralPath $resolved); $cleanupAttempt++) {
                try { Remove-Item -LiteralPath $resolved -Recurse -Force } catch { Start-Sleep -Milliseconds 100 }
            }
            if (Test-Path -LiteralPath $resolved) { Write-Warning "Smoke-test cleanup left $resolved" }
        }
    }
    foreach ($environmentName in $environmentNames) {
        $priorValue = $priorEnvironment[$environmentName]
        if ($null -eq $priorValue) {
            Remove-Item -LiteralPath ("Env:" + $environmentName) -ErrorAction SilentlyContinue
        }
        else {
            Set-Item -LiteralPath ("Env:" + $environmentName) -Value $priorValue
        }
    }
}
