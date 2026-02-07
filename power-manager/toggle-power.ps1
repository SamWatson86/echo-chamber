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
    if ($nvidiaSmi -and $gpuServer -gt 0) {
        try { & $nvidiaSmi -pl $gpuServer 2>&1 | Out-Null } catch {}
    }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
        "Switched to SERVER mode.`n`nCPU: 80%  |  GPU: ${gpuServer}W`nScreens stay on. No sleep.`n`nDouble-click the shortcut again to go back to Gaming.",
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
