$root = "F:\Codex AI\The Echo Chamber\core"
$lkExe = Join-Path $root "sfu\livekit-server.exe"
$lkConfig = Join-Path $root "sfu\livekit.yaml"
$lkOut = Join-Path $root "logs\livekit.out.log"
$lkErr = Join-Path $root "logs\livekit.err.log"
Stop-Process -Name 'livekit-server' -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$p = Start-Process -FilePath $lkExe -ArgumentList "--config `"$lkConfig`"" -WorkingDirectory (Join-Path $root "sfu") -PassThru -WindowStyle Hidden -RedirectStandardOutput $lkOut -RedirectStandardError $lkErr
Start-Sleep -Seconds 2
Write-Host "SFU PID: $($p.Id)"
$running = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($running) { Write-Host "SFU is running" } else { Write-Host "SFU FAILED to start" }
