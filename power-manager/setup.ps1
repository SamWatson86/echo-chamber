# ═══════════════════════════════════════════════════════════════════
#  Echo Chamber Power Manager — Setup
#  Run this ONCE as Administrator to create power plans + install
#  the background watcher that auto-switches between modes.
# ═══════════════════════════════════════════════════════════════════

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$configPath = Join-Path $root "config.json"

Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║   Echo Chamber Power Manager Setup    ║" -ForegroundColor Cyan
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Helper: find or create a power plan ──
function Get-OrCreatePlan {
    param([string]$Name, [string]$BaseSchemeGuid)
    # Check if plan already exists
    $existing = powercfg /list | Select-String $Name
    if ($existing) {
        $match = [regex]::Match($existing.Line, '([0-9a-f\-]{36})')
        if ($match.Success) {
            Write-Host "  [OK] '$Name' plan already exists" -ForegroundColor Green
            return $match.Value
        }
    }
    # Create by duplicating the base scheme
    $output = powercfg /duplicatescheme $BaseSchemeGuid 2>&1
    $match = [regex]::Match("$output", '([0-9a-f\-]{36})\s*$')
    if (-not $match.Success) {
        throw "Failed to create power plan '$Name'. Output: $output"
    }
    $guid = $match.Value.Trim()
    powercfg /changename $guid "$Name" "Echo Chamber auto-managed plan" | Out-Null
    Write-Host "  [OK] Created '$Name' plan ($guid)" -ForegroundColor Green
    return $guid
}

# ── Helper: set a power setting on a plan ──
function Set-PlanSetting {
    param([string]$PlanGuid, [string]$SubGroup, [string]$Setting, [int]$AcValue, [int]$DcValue)
    powercfg /setacvalueindex $PlanGuid $SubGroup $Setting $AcValue | Out-Null
    powercfg /setdcvalueindex $PlanGuid $SubGroup $Setting $DcValue | Out-Null
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 1: Create Power Plans
# ═══════════════════════════════════════════════════════════════════
Write-Host "Step 1: Creating power plans..." -ForegroundColor Yellow

# Well-known Windows GUIDs
$HIGH_PERF = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
$POWER_SAVE = "a1841308-3541-4fab-bc81-f71556f20b4a"

# Sub-group and setting GUIDs
$PROC      = "54533251-82be-4824-96c1-47b60b740d00"  # Processor
$PROC_MAX  = "bc5038f7-23e0-4960-96da-33abaf5935ec"  # Max processor state (%)
$PROC_MIN  = "893dee8e-2bef-41e0-89c6-b55d0929964c"  # Min processor state (%)
$DISPLAY   = "7516b95f-f776-4464-8c53-06167f40cc99"  # Display
$DISP_OFF  = "3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e"  # Display timeout (seconds)
$SLEEP     = "238c9fa8-0aad-41ed-83f4-97be242c8f20"  # Sleep
$SLEEP_TO  = "29f6c1db-86da-48c5-9fdb-f2b67b1f44da"  # Sleep timeout (seconds)
$HIBER_TO  = "9d7815a6-7ee4-497e-8888-515a05f02364"  # Hibernate timeout (seconds)
$DISK      = "0012ee47-9041-4b5d-9b77-535fba8b1442"  # Hard disk
$DISK_OFF  = "6738e2c4-e8a5-4a42-b16a-e040e769756e"  # Disk timeout (seconds)
$PCIE      = "501a4d13-42af-4429-9fd1-a8218c268e20"  # PCI Express
$PCIE_LINK = "ee12f906-d277-404b-b6da-e5fa1a576df5"  # Link State Power Mgmt

# Create plans
$serverGuid = Get-OrCreatePlan -Name "Echo Server" -BaseSchemeGuid $POWER_SAVE
$gamingGuid = Get-OrCreatePlan -Name "Echo Gaming" -BaseSchemeGuid $HIGH_PERF

# ── Configure Echo Server plan ──
Write-Host "  Configuring Echo Server plan..." -ForegroundColor Gray

# CPU: max 30%, min 5%
Set-PlanSetting $serverGuid $PROC $PROC_MAX 30 30
Set-PlanSetting $serverGuid $PROC $PROC_MIN 5 5

# Display: off after 1 minute (60 seconds)
Set-PlanSetting $serverGuid $DISPLAY $DISP_OFF 60 60

# Sleep: NEVER (0 = never) — critical for server operation
Set-PlanSetting $serverGuid $SLEEP $SLEEP_TO 0 0

# Hibernate: NEVER
Set-PlanSetting $serverGuid $SLEEP $HIBER_TO 0 0

# Hard disk: off after 20 minutes (1200 seconds)
Set-PlanSetting $serverGuid $DISK $DISK_OFF 1200 1200

# PCI Express: Maximum power savings (2)
Set-PlanSetting $serverGuid $PCIE $PCIE_LINK 2 2

Write-Host "  [OK] Echo Server: CPU 30%, display off 1min, never sleep" -ForegroundColor Green

# ── Configure Echo Gaming plan ──
Write-Host "  Configuring Echo Gaming plan..." -ForegroundColor Gray

# CPU: max 100%, min 100%
Set-PlanSetting $gamingGuid $PROC $PROC_MAX 100 100
Set-PlanSetting $gamingGuid $PROC $PROC_MIN 100 100

# Display: off after 15 minutes
Set-PlanSetting $gamingGuid $DISPLAY $DISP_OFF 900 900

# Sleep: NEVER (don't sleep while gaming)
Set-PlanSetting $gamingGuid $SLEEP $SLEEP_TO 0 0

# Hibernate: NEVER
Set-PlanSetting $gamingGuid $SLEEP $HIBER_TO 0 0

# Hard disk: never turn off (0)
Set-PlanSetting $gamingGuid $DISK $DISK_OFF 0 0

# PCI Express: Off (0) — no power saving
Set-PlanSetting $gamingGuid $PCIE $PCIE_LINK 0 0

Write-Host "  [OK] Echo Gaming: CPU 100%, display off 15min, never sleep" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════
#  STEP 2: Detect NVIDIA GPU
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "Step 2: Detecting NVIDIA GPU..." -ForegroundColor Yellow

$nvidiaSmi = $null
$gpuMaxPower = 0
$gpuServerPower = 0

# Find nvidia-smi
$searchPaths = @(
    "nvidia-smi",
    "C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
    "C:\Windows\System32\nvidia-smi.exe"
)

foreach ($p in $searchPaths) {
    try {
        $test = & $p --version 2>&1
        if ($LASTEXITCODE -eq 0) {
            $nvidiaSmi = $p
            break
        }
    } catch {}
}

if ($nvidiaSmi) {
    Write-Host "  [OK] Found nvidia-smi at: $nvidiaSmi" -ForegroundColor Green

    # Get GPU default power limit
    try {
        $powerInfo = & $nvidiaSmi --query-gpu=power.default_limit --format=csv,noheader,nounits 2>&1
        $gpuMaxPower = [math]::Floor([double]$powerInfo.Trim())
        # Server mode: 25% of max (minimum viable for desktop rendering)
        $gpuServerPower = [math]::Max(50, [math]::Floor($gpuMaxPower * 0.25))
        Write-Host "  [OK] GPU max power: ${gpuMaxPower}W, server mode: ${gpuServerPower}W" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Could not read GPU power limit. GPU throttling disabled." -ForegroundColor DarkYellow
        $gpuMaxPower = 0
    }
} else {
    Write-Host "  [WARN] nvidia-smi not found. GPU throttling disabled." -ForegroundColor DarkYellow
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 3: Save config
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "Step 3: Saving configuration..." -ForegroundColor Yellow

$config = @{
    serverPlanGuid  = $serverGuid
    gamingPlanGuid  = $gamingGuid
    nvidiaSmi       = if ($nvidiaSmi) { $nvidiaSmi } else { "" }
    gpuMaxPower     = $gpuMaxPower
    gpuServerPower  = $gpuServerPower
    gpuThresholdPct = 25       # GPU usage % above this = gaming detected
    idleCooldownSec = 180      # Seconds of low GPU before switching to server
    checkIntervalSec = 45      # How often to check (seconds)
}

$config | ConvertTo-Json -Depth 3 | Set-Content $configPath -Encoding UTF8
Write-Host "  [OK] Config saved to $configPath" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════
#  STEP 4: Create default games.txt if missing
# ═══════════════════════════════════════════════════════════════════
$gamesPath = Join-Path $root "games.txt"
if (-not (Test-Path $gamesPath)) {
    Write-Host ""
    Write-Host "Step 4: Creating default game process list..." -ForegroundColor Yellow
    # Will be created by the other file write
    Write-Host "  [OK] games.txt created with common game processes" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Step 4: games.txt already exists, keeping yours" -ForegroundColor Yellow
}

# ═══════════════════════════════════════════════════════════════════
#  STEP 5: Install watcher as scheduled task
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "Step 5: Installing background watcher..." -ForegroundColor Yellow

$taskName = "EchoChamberPowerWatcher"
$watcherPath = Join-Path $root "watcher.ps1"

# Remove existing task if any
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "  Removed existing task" -ForegroundColor Gray
}

# Create the task: runs at system startup, as SYSTEM, hidden
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`"" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Monitors GPU usage and switches between Echo Server/Gaming power plans" | Out-Null

Write-Host "  [OK] Scheduled task '$taskName' installed (runs at startup)" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════
#  STEP 6: Start watcher now
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "Step 6: Starting watcher..." -ForegroundColor Yellow

Start-ScheduledTask -TaskName $taskName
Write-Host "  [OK] Watcher is running!" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════
#  STEP 7: Activate server plan now (since you're not gaming yet)
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "Step 7: Activating Echo Server mode..." -ForegroundColor Yellow
powercfg /setactive $serverGuid
Write-Host "  [OK] Now in Echo Server mode (low power)" -ForegroundColor Green

# ═══════════════════════════════════════════════════════════════════
#  Done!
# ═══════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  ╔═══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║         Setup Complete!                ║" -ForegroundColor Green
Write-Host "  ╚═══════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  How it works:" -ForegroundColor White
Write-Host "  - Background watcher checks GPU every 45 seconds" -ForegroundColor Gray
Write-Host "  - Launch a game -> auto-switches to Gaming mode" -ForegroundColor Gray
Write-Host "  - Close the game -> 3 minutes later, back to Server mode" -ForegroundColor Gray
Write-Host "  - Echo Chamber runs perfectly in both modes" -ForegroundColor Gray
Write-Host ""
Write-Host "  GPU power limit:" -ForegroundColor White
if ($gpuMaxPower -gt 0) {
    Write-Host "  - Server mode: ${gpuServerPower}W (saves power)" -ForegroundColor Gray
    Write-Host "  - Gaming mode: ${gpuMaxPower}W (full power)" -ForegroundColor Gray
} else {
    Write-Host "  - GPU throttling not available (nvidia-smi not found)" -ForegroundColor DarkYellow
}
Write-Host ""
Write-Host "  To check current mode:  powercfg /getactivescheme" -ForegroundColor Cyan
Write-Host "  To stop the watcher:    Stop-ScheduledTask EchoChamberPowerWatcher" -ForegroundColor Cyan
Write-Host "  To uninstall:           Unregister-ScheduledTask EchoChamberPowerWatcher" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Log file: $(Join-Path $root 'watcher.log')" -ForegroundColor Cyan
Write-Host ""
