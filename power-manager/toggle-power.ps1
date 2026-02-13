# Echo Chamber Power Toggle
# Double-click to flip between Gaming (100%) and Server (low power) modes.

$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"
$config = Get-Content $configPath -Raw | ConvertFrom-Json

$serverGuid = $config.serverPlanGuid
$gamingGuid = $config.gamingPlanGuid
$nvidiaSmi  = $config.nvidiaSmi
$gpuMax     = $config.gpuMaxPower
$gpuServer  = $config.gpuServerPower

# Detect current mode
$active = powercfg /getactivescheme
$isServer = $active -match $serverGuid
$isGaming = $active -match $gamingGuid

if ($isGaming -or (-not $isServer)) {
    # Switch TO server mode
    powercfg /setactive $serverGuid

    # Enforce display off after 2 minutes, never sleep/hibernate
    $DISPLAY   = "7516b95f-f776-4464-8c53-06167f40cc99"
    $DISP_OFF  = "3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e"
    $SLEEP     = "238c9fa8-0aad-41ed-83f4-97be242c8f20"
    $SLEEP_TO  = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"
    $HIBER_TO  = "9d7815a6-7ee4-497e-8888-515a05f02364"
    powercfg /setacvalueindex $serverGuid $DISPLAY $DISP_OFF 120
    powercfg /setdcvalueindex $serverGuid $DISPLAY $DISP_OFF 120
    powercfg /setacvalueindex $serverGuid $SLEEP $SLEEP_TO 0
    powercfg /setdcvalueindex $serverGuid $SLEEP $SLEEP_TO 0
    powercfg /setacvalueindex $serverGuid $SLEEP $HIBER_TO 0
    powercfg /setdcvalueindex $serverGuid $SLEEP $HIBER_TO 0

    if ($nvidiaSmi -and $gpuServer -gt 0) {
        try { & $nvidiaSmi -pl $gpuServer 2>&1 | Out-Null } catch {}
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Switched to SERVER mode.`n`nCPU: low power  |  GPU: ${gpuServer}W`nScreens off after 2 min. Never sleeps.`nEcho Chamber keeps running.`n`nDouble-click the shortcut again to go back to Gaming.",
        "Echo Chamber - Server Mode",
        "OK",
        "Information"
    ) | Out-Null
}
else {
    # Switch TO gaming mode
    powercfg /setactive $gamingGuid
    if ($nvidiaSmi -and $gpuMax -gt 0) {
        try { & $nvidiaSmi -pl $gpuMax 2>&1 | Out-Null } catch {}
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Switched to GAMING mode.`n`nCPU: 100%  |  GPU: ${gpuMax}W`nFull power!`n`nDouble-click the shortcut again to switch to Server when you leave.",
        "Echo Chamber - Gaming Mode",
        "OK",
        "Information"
    ) | Out-Null
}
