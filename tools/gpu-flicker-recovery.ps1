# Echo Chamber — GPU driver flicker recovery script
#
# WHAT IT'S FOR
# =============
# Sam's RTX 4090 / 4K HDR / 144Hz multi-monitor setup periodically wedges
# into a flickering state during certain capture pipeline transitions
# (Win+P display switches, WGC monitor capture activation, etc). The wedge
# survives `Win+Ctrl+Shift+B` (display driver soft reset), sign-out, and
# Echo Chamber process kills. The only confirmed recovery is a full reboot.
#
# This script tries every non-reboot recovery technique we know about, in
# order of escalating invasiveness. Run it as Administrator the next time
# the flicker happens. If it works, you avoided a reboot. If it doesn't,
# you've done your due diligence — reboot.
#
# Documented in:
#   ~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/bug_gpu_driver_flicker_recurring.md
#
# HOW TO RUN
# ==========
# Right-click the file → "Run with PowerShell" → click yes to UAC prompt.
# OR from an elevated PowerShell:
#   powershell -ExecutionPolicy Bypass -File "F:\Codex AI\The Echo Chamber\tools\gpu-flicker-recovery.ps1"
#
# WHAT IT DOES
# ============
# Step 1: Kill any running Echo Chamber capture processes (releases
#         lingering DXGI/D3D11 resources that may be holding the driver)
# Step 2: pnputil /restart-device on the NVIDIA display adapter
#         (restarts the device without a full driver reload)
# Step 3: If step 2 doesn't help, disable + re-enable the adapter via
#         PnP class (heavier reset)
# Step 4: Display 'still flickering? Reboot.' diagnostic if all else fails

#Requires -RunAsAdministrator

$ErrorActionPreference = "Continue"

function Write-Section($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Write-Ok($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Err($msg) { Write-Host "    [ERROR] $msg" -ForegroundColor Red }

Write-Section "Step 1: Kill Echo Chamber capture processes"
$capProcs = @("echo-core-client", "echo-core-control")
foreach ($pname in $capProcs) {
    $procs = Get-Process -Name $pname -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | ForEach-Object {
            try {
                Stop-Process -Id $_.Id -Force -ErrorAction Stop
                Write-Ok "Killed $pname (PID $($_.Id))"
            } catch {
                Write-Warn "Could not kill $pname PID $($_.Id): $_"
            }
        }
    } else {
        Write-Ok "$pname not running"
    }
}
Start-Sleep -Seconds 2

Write-Section "Step 2: Find NVIDIA display adapter"
$adapter = Get-PnpDevice -Class Display -Status OK -ErrorAction SilentlyContinue |
    Where-Object { $_.FriendlyName -like "*NVIDIA*" -or $_.FriendlyName -like "*GeForce*" -or $_.FriendlyName -like "*RTX*" } |
    Select-Object -First 1

if (-not $adapter) {
    Write-Err "No NVIDIA display adapter found in PnP. Cannot proceed."
    Write-Host "    Available display adapters:"
    Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Host "      $($_.FriendlyName) [$($_.InstanceId)] Status=$($_.Status)"
    }
    exit 1
}

Write-Ok "Found: $($adapter.FriendlyName)"
Write-Host "    Instance: $($adapter.InstanceId)"

Write-Section "Step 3: pnputil /restart-device"
$restartOutput = & pnputil /restart-device "$($adapter.InstanceId)" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Ok "pnputil restart succeeded"
    Write-Host "    Output: $restartOutput"
    Write-Host ""
    Write-Host "Wait 5 seconds. Did the flickering stop?" -ForegroundColor Cyan
    Write-Host "If YES: you're done. Relaunch Echo Chamber from the Start Menu." -ForegroundColor Cyan
    Write-Host "If NO: continue with Step 4 (heavier reset)." -ForegroundColor Cyan
    Start-Sleep -Seconds 5
} else {
    Write-Warn "pnputil restart failed (exit $LASTEXITCODE): $restartOutput"
    Write-Host "    Falling through to Step 4..."
}

Write-Section "Step 4: Disable + Enable adapter (heavier reset)"
Write-Host "    This will blank the screen briefly. Don't panic." -ForegroundColor Yellow
Start-Sleep -Seconds 2

try {
    Disable-PnpDevice -InstanceId $adapter.InstanceId -Confirm:$false -ErrorAction Stop
    Write-Ok "Adapter disabled"
    Start-Sleep -Seconds 3
    Enable-PnpDevice -InstanceId $adapter.InstanceId -Confirm:$false -ErrorAction Stop
    Write-Ok "Adapter re-enabled"
    Start-Sleep -Seconds 5
} catch {
    Write-Err "Disable/Enable failed: $_"
}

Write-Section "Done"
Write-Host ""
Write-Host "If the flickering is still happening:" -ForegroundColor Yellow
Write-Host "  1. Try Win+Ctrl+Shift+B once (display driver soft reset)" -ForegroundColor Yellow
Write-Host "  2. If that fails, reboot. The wedge is in the driver and we" -ForegroundColor Yellow
Write-Host "     don't have a non-reboot fix yet." -ForegroundColor Yellow
Write-Host ""
Write-Host "If recovery worked, please add a note to" -ForegroundColor Cyan
Write-Host "  ~/.claude/projects/F--Codex-AI-The-Echo-Chamber/memory/bug_gpu_driver_flicker_recurring.md" -ForegroundColor Cyan
Write-Host "with which step (3 pnputil OR 4 disable/enable) actually fixed it." -ForegroundColor Cyan
Write-Host "That data point helps us figure out the right ordering for next time." -ForegroundColor Cyan
