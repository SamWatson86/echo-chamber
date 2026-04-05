# NVFBC Enabler for GeForce GPUs
# Downloads and installs the NvFBC wrapper DLL from keylase/nvidia-patch
# Requires admin elevation and a reboot after applying.
#
# What this does:
# 1. Sets NVFBCEnable=1 registry keys
# 2. Renames original NvFBC64.dll -> NvFBC64_.dll (the wrapper looks for this)
# 3. Downloads wrapper DLL as NvFBC64.dll
# 4. Requires reboot to take effect

$ErrorActionPreference = "Stop"

# Must run as admin
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Must run as Administrator. Right-click and 'Run as Administrator'." -ForegroundColor Red
    exit 1
}

Write-Host "=== NVFBC Enabler for GeForce ===" -ForegroundColor Cyan

# Step 1: Registry keys
Write-Host "`n[1/4] Setting registry keys..." -ForegroundColor Yellow
reg add "HKLM\SYSTEM\CurrentControlSet\Services\nvlddmkm" /v NVFBCEnable /d 1 /t REG_DWORD /f | Out-Null
reg add "HKLM\SYSTEM\CurrentControlSet\Services\nvlddmkm\FTS" /v NvFBCEnable /d 1 /t REG_DWORD /f | Out-Null
Write-Host "  Registry keys set." -ForegroundColor Green

# Step 2: Check DLL existence
$sys32 = "$env:WINDIR\System32"
$sysWow = "$env:WINDIR\SysWOW64"
$dll64 = Join-Path $sys32 "NvFBC64.dll"
$dll32 = Join-Path $sysWow "NvFBC.dll"

if (-not (Test-Path $dll64)) {
    Write-Host "ERROR: $dll64 not found. NVIDIA driver may not be installed." -ForegroundColor Red
    exit 1
}
Write-Host "  Found: $dll64" -ForegroundColor Green

# Step 3: Backup and rename originals
Write-Host "`n[2/4] Backing up original DLLs..." -ForegroundColor Yellow
$backup64 = Join-Path $sys32 "NvFBC64_.dll"
$backup32 = Join-Path $sysWow "NvFBC_.dll"

if (Test-Path $backup64) {
    Write-Host "  NvFBC64_.dll already exists (wrapper may already be installed)." -ForegroundColor Yellow
} else {
    # Take ownership and set permissions
    takeown /f $dll64 | Out-Null
    icacls $dll64 /grant Administrators:F | Out-Null
    Copy-Item $dll64 $backup64
    Write-Host "  Backed up NvFBC64.dll -> NvFBC64_.dll" -ForegroundColor Green
}

if ((Test-Path $dll32) -and -not (Test-Path $backup32)) {
    takeown /f $dll32 | Out-Null
    icacls $dll32 /grant Administrators:F | Out-Null
    Copy-Item $dll32 $backup32
    Write-Host "  Backed up NvFBC.dll -> NvFBC_.dll" -ForegroundColor Green
}

# Step 4: Download wrapper DLLs
Write-Host "`n[3/4] Downloading wrapper DLLs..." -ForegroundColor Yellow
$wrapperUrl64 = "https://gist.github.com/Snawoot/17b14e7ce0f7412b91587c2723719eff/raw/e8e9658fd20751ad875477f37b49ea158ece896d/nvfbcwrp64.dll"
$wrapperUrl32 = "https://gist.github.com/Snawoot/17b14e7ce0f7412b91587c2723719eff/raw/e8e9658fd20751ad875477f37b49ea158ece896d/nvfbcwrp32.dll"

$tempDir = Join-Path $env:TEMP "nvfbc-patch"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$temp64 = Join-Path $tempDir "nvfbcwrp64.dll"
$temp32 = Join-Path $tempDir "nvfbcwrp32.dll"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $wrapperUrl64 -OutFile $temp64 -UseBasicParsing
    Write-Host "  Downloaded 64-bit wrapper ($((Get-Item $temp64).Length) bytes)" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Failed to download 64-bit wrapper: $_" -ForegroundColor Red
    exit 1
}

try {
    Invoke-WebRequest -Uri $wrapperUrl32 -OutFile $temp32 -UseBasicParsing
    Write-Host "  Downloaded 32-bit wrapper ($((Get-Item $temp32).Length) bytes)" -ForegroundColor Green
} catch {
    Write-Host "  Warning: Failed to download 32-bit wrapper (not critical): $_" -ForegroundColor Yellow
}

# Step 5: Install wrapper DLLs
Write-Host "`n[4/4] Installing wrapper DLLs..." -ForegroundColor Yellow
Copy-Item $temp64 $dll64 -Force
Write-Host "  Installed NvFBC64.dll (wrapper)" -ForegroundColor Green

if (Test-Path $temp32) {
    Copy-Item $temp32 $dll32 -Force
    Write-Host "  Installed NvFBC.dll (32-bit wrapper)" -ForegroundColor Green
}

Write-Host "`n=== NVFBC patch applied successfully ===" -ForegroundColor Green
Write-Host "A REBOOT is required for the patch to take effect." -ForegroundColor Yellow
Write-Host "After reboot, NVFBC capture will be available in Echo Chamber." -ForegroundColor Cyan

$restart = Read-Host "`nReboot now? (y/n)"
if ($restart -eq "y") {
    Restart-Computer -Force
}
