$ErrorActionPreference = "SilentlyContinue"
trap {
  try {
    Write-Log ("Tray error: {0}" -f $_.Exception.Message)
  } catch {}
  continue
}

param(
  [switch]$AutoStart
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $env:APPDATA "@echo\\desktop\\echo-server.pid"
$turnPidFile = Join-Path $env:APPDATA "@echo\\desktop\\echo-turn.pid"
$envStateFile = Join-Path $env:APPDATA "@echo\\desktop\\echo-env.txt"
$iconPath = Join-Path $repoRoot "apps\\desktop\\build\\icon.ico"
$envPath = Join-Path $repoRoot ".env"
$serverEnvPath = Join-Path $repoRoot "apps\\server\\.env"
$turnDir = Join-Path $repoRoot "tools\\turn"
$turnEnvPath = Join-Path $turnDir ".env"
$turnExePath = Join-Path $turnDir "bin\\echo-turn.exe"

$trayLog = Join-Path $env:APPDATA "@echo\\desktop\\logs\\echo-tray.log"
$currentIconKey = ""

function Write-Log($message) {
  try {
    $dir = Split-Path -Parent $trayLog
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $ts = (Get-Date).ToString("s")
    Add-Content -Path $trayLog -Value ("{0} {1}" -f $ts, $message) -Encoding ascii
  } catch {}
}

function Normalize-Env($value) {
  if (!$value) { return "prod" }
  $raw = $value.ToString().Trim().ToLower()
  if ($raw.StartsWith("prod")) { return "prod" }
  if ($raw.StartsWith("dev")) { return "dev" }
  if ($raw -eq "production") { return "prod" }
  if ($raw -eq "development") { return "dev" }
  return $raw
}

function Get-EnvValueFor([string]$key, [string]$mode, $default = "") {
  $modeValue = Normalize-Env $mode
  $files = @()
  if ($modeValue) {
    $files += (Join-Path $repoRoot (".env." + $modeValue))
    $files += (Join-Path $repoRoot ("apps\\server\\.env." + $modeValue))
  }
  $files += $envPath
  $files += $serverEnvPath
  foreach ($file in $files) {
    if (!(Test-Path $file)) { continue }
    $lines = Get-Content -Path $file -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
      $trim = $line.Trim()
      if (!$trim -or $trim.StartsWith("#")) { continue }
      $idx = $trim.IndexOf("=")
      if ($idx -le 0) { continue }
      $k = $trim.Substring(0, $idx).Trim()
      if ($k -ne $key) { continue }
      return $trim.Substring($idx + 1)
    }
  }
  return $default
}

function Get-ActiveEnv {
  try {
    if (Test-Path $envStateFile) {
      $stored = Get-Content -Path $envStateFile -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($stored) { return (Normalize-Env $stored) }
    }
  } catch {}
  return "prod"
}

$activeEnv = Get-ActiveEnv
Write-Log "Tray starting (env=$activeEnv)"

function Set-ActiveEnv([string]$value) {
  $script:activeEnv = Normalize-Env $value
  try {
    $dir = Split-Path -Parent $envStateFile
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Set-Content -Path $envStateFile -Value $script:activeEnv -Encoding ascii
  } catch {}
  Write-Log "Active environment set to $script:activeEnv"
  Update-Status
}

function Get-EnvFileCandidates {
  $files = @()
  if ($script:activeEnv) {
    $files += (Join-Path $repoRoot (".env." + $script:activeEnv))
    $files += (Join-Path $repoRoot ("apps\\server\\.env." + $script:activeEnv))
  }
  $files += $envPath
  $files += $serverEnvPath
  return $files
}

function Test-ServerListening {
  try {
    $port = Get-ServerPort
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $listener
  } catch {
    return $false
  }
}

function Stop-ServerByPort([int]$port) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
      Write-Log "Stopping process on port $port (pid=$($conn.OwningProcess))"
      try { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
      return $true
    }
  } catch {}
  return $false
}

function Wait-ForPortClosed([int]$port, [int]$timeoutMs = 3000) {
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.ElapsedMilliseconds -lt $timeoutMs) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $true }
    Start-Sleep -Milliseconds 150
  }
  return $false
}

function Get-EnvValue($key, $default = "") {
  $files = Get-EnvFileCandidates
  foreach ($file in $files) {
    if (!(Test-Path $file)) { continue }
    $lines = Get-Content -Path $file -ErrorAction SilentlyContinue
    foreach ($line in $lines) {
      $trim = $line.Trim()
      if (!$trim -or $trim.StartsWith("#")) { continue }
      $idx = $trim.IndexOf("=")
      if ($idx -le 0) { continue }
      $k = $trim.Substring(0, $idx).Trim()
      if ($k -ne $key) { continue }
      return $trim.Substring($idx + 1)
    }
  }
  return $default
}

function Get-ServerPort {
  $raw = Get-EnvValue "PORT" "5050"
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed)) { return $parsed }
  return 5050
}

function Get-ServerPortFor([string]$mode) {
  $raw = Get-EnvValueFor "PORT" $mode "5050"
  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed)) { return $parsed }
  return 5050
}

function Get-ServerProtocol {
  $cert = Get-EnvValue "TLS_CERT_PATH" ""
  $key = Get-EnvValue "TLS_KEY_PATH" ""
  if ($cert -and $key) { return "https" }
  return "http"
}

function Get-ServerProtocolFor([string]$mode) {
  $cert = Get-EnvValueFor "TLS_CERT_PATH" $mode ""
  $key = Get-EnvValueFor "TLS_KEY_PATH" $mode ""
  if ($cert -and $key) { return "https" }
  return "http"
}

function Get-ServerUrl {
  return "{0}://localhost:{1}" -f (Get-ServerProtocol), (Get-ServerPort)
}

function Get-ServerUrlFor([string]$mode) {
  return "{0}://localhost:{1}" -f (Get-ServerProtocolFor $mode), (Get-ServerPortFor $mode)
}

function Get-LogDir {
  $logFile = Get-EnvValue "LOG_FILE" ""
  if ($logFile) { return (Split-Path -Parent $logFile) }
  $logDir = Get-EnvValue "LOG_DIR" ""
  if ($logDir) { return $logDir }
  return (Join-Path $repoRoot "logs")
}

function Get-ServerProcess {
  if (!(Test-Path $pidFile)) { return $null }
  $serverPid = Get-Content -Path $pidFile -ErrorAction SilentlyContinue
  if (!$serverPid) { return $null }
  try {
    return Get-Process -Id $serverPid -ErrorAction Stop
  } catch {
    Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Write-Pid($serverPidValue) {
  $dir = Split-Path -Parent $pidFile
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $pidFile -Value $serverPidValue -Encoding ascii
}

function Get-TurnProcess {
  if (!(Test-Path $turnPidFile)) { return $null }
  $turnPid = Get-Content -Path $turnPidFile -ErrorAction SilentlyContinue
  if (!$turnPid) { return $null }
  try {
    return Get-Process -Id $turnPid -ErrorAction Stop
  } catch {
    Remove-Item -Path $turnPidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Write-TurnPid($turnPidValue) {
  $dir = Split-Path -Parent $turnPidFile
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $turnPidFile -Value $turnPidValue -Encoding ascii
}

function Load-TurnEnv {
  if (!(Test-Path $turnEnvPath)) { return }
  Get-Content $turnEnvPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Count -lt 2) { return }
    $name = $parts[0].Trim()
    $value = $parts[1].Trim()
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ($name) { [Environment]::SetEnvironmentVariable($name, $expanded, "Process") }
  }
}

function Start-Turn {
  $running = Get-TurnProcess
  if ($running) { return }
  if (!(Test-Path $turnExePath)) {
    Write-Log "TURN exe missing at $turnExePath"
    return
  }
  Load-TurnEnv
  try {
    $p = Start-Process -FilePath $turnExePath -WorkingDirectory $turnDir -WindowStyle Hidden -PassThru
    Write-TurnPid $p.Id
  } catch {
    Write-Log "Failed to start TURN: $($_.Exception.Message)"
  }
}

function Stop-Turn {
  $proc = Get-TurnProcess
  if ($proc) {
    try { Stop-Process -Id $proc.Id -Force } catch {}
  }
  Remove-Item -Path $turnPidFile -Force -ErrorAction SilentlyContinue
}

function Restart-Turn {
  Stop-Turn
  Start-Sleep -Milliseconds 300
  Start-Turn
}

function Start-Server {
  param(
    [string]$Mode = $script:activeEnv
  )
  $modeValue = Normalize-Env $Mode
  Set-ActiveEnv $modeValue
  Write-Log "Start requested (env=$script:activeEnv)"
  $running = Get-ServerProcess
  if ($running) { return }
  $cli = Join-Path $repoRoot "apps\\server\\dist\\cli.js"
  if (!(Test-Path $cli)) {
    Write-Log "Server build missing. Run npm.cmd run build -w @echo/server"
    return
  }
  $port = Get-ServerPort
  if (Test-ServerListening) {
    Write-Log "Port $port already in use; start aborted"
    return
  }
  $envFile = $null
  $candidate = Join-Path $repoRoot (".env." + $script:activeEnv)
  if (Test-Path $candidate) { $envFile = $candidate }
  if (!$envFile) {
    $candidate = Join-Path $repoRoot ("apps\\server\\.env." + $script:activeEnv)
    if (Test-Path $candidate) { $envFile = $candidate }
  }
  $env:ECHO_ENV = $script:activeEnv
  if ($envFile) {
    $env:ECHO_ENV_FILE = $envFile
    Write-Log "Using env file: $envFile"
  } else {
    Remove-Item Env:ECHO_ENV_FILE -ErrorAction SilentlyContinue
    Write-Log "No env file override found"
  }
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
  $node = if ($nodeCmd) { $nodeCmd.Path } else { $null }
  if (!$node) {
    Write-Log "node.exe not found on PATH"
    return
  }
  try {
    $p = Start-Process -FilePath $node -ArgumentList "`"$cli`"" -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
    Write-Pid $p.Id
    Write-Log "Server start requested (pid=$($p.Id), env=$script:activeEnv)"
  } catch {
    Write-Log "Failed to start server: $($_.Exception.Message)"
  }
}

function Stop-Server {
  Write-Log "Stop requested (env=$script:activeEnv)"
  $proc = Get-ServerProcess
  if ($proc) {
    try { Stop-Process -Id $proc.Id -Force } catch {}
  }
  if (Test-ServerListening) {
    $port = Get-ServerPort
    Stop-ServerByPort $port | Out-Null
  }
  Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
}

function Restart-Server {
  param(
    [string]$Mode = $script:activeEnv
  )
  Write-Log "Restart requested (env=$Mode)"
  $port = Get-ServerPort
  Stop-Server
  Wait-ForPortClosed $port 3000 | Out-Null
  Start-Sleep -Milliseconds 200
  Start-Server -Mode $Mode
}

function Open-Admin {
  Start-Process (Get-ServerUrl)
}

function Open-AdminFor([string]$mode) {
  $url = Get-ServerUrlFor $mode
  Start-Process $url
}

function Open-Logs {
  $dir = Get-LogDir
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Start-Process $dir
}

$tray = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) {
  $tray.Icon = New-Object System.Drawing.Icon($iconPath)
} else {
  $tray.Icon = [System.Drawing.SystemIcons]::Application
}
$tray.Visible = $true
try {
  $tray.ShowBalloonTip(3000, "Echo Chamber", "Tray started ($($activeEnv.ToUpper()))", [System.Windows.Forms.ToolTipIcon]::Info)
} catch {}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false
$envItem = New-Object System.Windows.Forms.ToolStripMenuItem
$envItem.Enabled = $false

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem.Text = "Start Server (Active Env)"
$startItem.add_Click({ Start-Server })

$startDevItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startDevItem.Text = "Start Server (Dev)"
$startDevItem.add_Click({ Start-Server -Mode "dev" })

$startProdItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startProdItem.Text = "Start Server (Prod)"
$startProdItem.add_Click({ Start-Server -Mode "prod" })

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = "Stop Server"
$stopItem.add_Click({ Stop-Server })

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "Restart Server (Active Env)"
$restartItem.add_Click({ Restart-Server })

$restartDevItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartDevItem.Text = "Restart Server (Dev)"
$restartDevItem.add_Click({ Restart-Server -Mode "dev" })

$restartProdItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartProdItem.Text = "Restart Server (Prod)"
$restartProdItem.add_Click({ Restart-Server -Mode "prod" })

$openUiItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openUiItem.Text = "Open Admin UI"
$openUiItem.add_Click({ Open-Admin })

$openUiDevItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openUiDevItem.Text = "Open UI (Dev)"
$openUiDevItem.add_Click({ Open-AdminFor "dev" })

$openUiProdItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openUiProdItem.Text = "Open UI (Prod)"
$openUiProdItem.add_Click({ Open-AdminFor "prod" })

$openLogsItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openLogsItem.Text = "Open Logs Folder"
$openLogsItem.add_Click({ Open-Logs })

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$quitItem.Text = "Quit Tray"
$quitItem.add_Click({
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$menu.Items.AddRange(@(
  $statusItem,
  $envItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $openUiItem,
  $openUiDevItem,
  $openUiProdItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $startItem,
  $startDevItem,
  $startProdItem,
  $stopItem,
  $restartItem,
  $restartDevItem,
  $restartProdItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $openLogsItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $quitItem
))

$tray.ContextMenuStrip = $menu
$tray.add_Click({ Open-Admin })

function Update-Status {
  if (-not $tray.Visible) { $tray.Visible = $true }
  $running = Get-ServerProcess
  $turnRunning = Get-TurnProcess
  $envLabel = $script:activeEnv.ToUpper()
  $portLabel = Get-ServerPort
  if ($running) {
    $statusItem.Text = "Echo Chamber Server (Running)"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
    $restartItem.Enabled = $true
    $startDevItem.Enabled = $false
    $startProdItem.Enabled = $false
    $restartDevItem.Enabled = $true
    $restartProdItem.Enabled = $true
  } else {
    $statusItem.Text = "Echo Chamber Server (Stopped)"
    $startItem.Enabled = $true
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
    $startDevItem.Enabled = $true
    $startProdItem.Enabled = $true
    $restartDevItem.Enabled = $false
    $restartProdItem.Enabled = $false
  }
  $envItem.Text = "Active Env: $envLabel"
  $turnLabel = if ($turnRunning) { "TURN: on" } else { "TURN: off" }
  $tray.Text = "Echo {0} {1} :{2} {3}" -f ($(if ($running) { "Running" } else { "Stopped" })), $envLabel, $portLabel, $turnLabel

  $iconKey = $script:activeEnv
  if ($currentIconKey -ne $iconKey) {
    if ($script:activeEnv -eq "dev") {
      $tray.Icon = [System.Drawing.SystemIcons]::Warning
    } else {
      if (Test-Path $iconPath) {
        $tray.Icon = New-Object System.Drawing.Icon($iconPath)
      } else {
        $tray.Icon = [System.Drawing.SystemIcons]::Application
      }
    }
    $script:currentIconKey = $iconKey
  }
}

function Ensure-ServerRunning([int]$maxAttempts = 5, [string]$Mode = $script:activeEnv) {
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if (Test-ServerListening) { return $true }
    $proc = Get-ServerProcess
    if ($proc) {
      Write-Log "Server process found but port not listening. Restarting (attempt $attempt)."
      Stop-Server
      Start-Sleep -Milliseconds 300
    }
    Start-Server -Mode $Mode
    Start-Sleep -Milliseconds 800
  }
  return (Test-ServerListening)
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ Update-Status })
$timer.Start()
Update-Status

if ($AutoStart) {
  Write-Log "AutoStart requested"
  Start-Sleep -Milliseconds 800
  Start-Turn
  $ok = Ensure-ServerRunning 5 $script:activeEnv
  if ($ok) {
    Write-Log "Server listening on startup"
  } else {
    Write-Log "Server failed to listen on startup after retries"
  }
  Update-Status
}

[System.Windows.Forms.Application]::Run()
