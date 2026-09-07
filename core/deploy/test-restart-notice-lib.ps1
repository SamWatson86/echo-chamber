$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-network-lib.ps1')
. (Join-Path $PSScriptRoot 'restart-notice-lib.ps1')
function Assert-Notice([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw "Restart notice test failed: $Message" }
}
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('echo-restart-notice-test-' + [Guid]::NewGuid().ToString('N'))))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
try {
    $noticeFile = Join-Path $fixtureRoot 'restart-notice.json'
    $envFile = Join-Path $fixtureRoot 'fixture.env'
    [IO.File]::WriteAllText($envFile, "ECHO_CORE_VIEWER_DIR=$fixtureRoot")
    Assert-Notice ((Get-EchoRestartNoticeDirectory $envFile) -ceq $fixtureRoot) 'active viewer path'
    Set-EchoRestartNotice -ViewerDirectory $fixtureRoot -State Restarting -NowMilliseconds 1000000
    $notice = Get-Content -LiteralPath $noticeFile -Raw | ConvertFrom-Json
    Assert-Notice ($notice.state -ceq 'restarting' -and $notice.started_at -eq 1000000 -and $notice.expires_at -eq 1120000) 'bounded announcement'
    $firstId = $notice.id
    Set-EchoRestartNotice -ViewerDirectory $fixtureRoot -State Restarting -NowMilliseconds 1001000
    $replacement = Get-Content -LiteralPath $noticeFile -Raw | ConvertFrom-Json
    Assert-Notice ($replacement.id -ne $firstId) 'each controlled restart has a unique identity'
    Set-EchoRestartNotice -ViewerDirectory $fixtureRoot -State Ready
    Assert-Notice ((Get-FileHash -LiteralPath $noticeFile).Hash -ceq (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot '..\viewer\restart-notice.json')).Hash) 'ready bytes match the release snapshot'
    Assert-Notice (@(Get-ChildItem -LiteralPath $fixtureRoot -Filter '*.tmp' -Force).Count -eq 0) 'atomic write leaves no temporary files'
    foreach ($invalid in @('ECHO_CORE_VIEWER_DIR=relative', "ECHO_CORE_VIEWER_DIR=$fixtureRoot`nECHO_CORE_VIEWER_DIR=$fixtureRoot", 'CORE_BIND=0.0.0.0')) {
        [IO.File]::WriteAllText($envFile, $invalid)
        $rejected = $false
        try { Get-EchoRestartNoticeDirectory $envFile | Out-Null } catch { $rejected = $true }
        Assert-Notice $rejected 'missing, ambiguous, or relative viewer paths rejected'
    }
    Write-Host 'restart notice Windows verification passed'
}
finally {
    $cleanupRoot = [IO.Path]::GetFullPath($fixtureRoot)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\echo-restart-notice-test-'
    if (!$cleanupRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $cleanupRoot -Recurse -Force
}
