$ErrorActionPreference = "SilentlyContinue"

param(
  [switch]$AutoStart
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$repoRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $env:APPDATA "@echo\\desktop\\echo-server.pid"
$turnPidFile = Join-Path $env:APPDATA "@echo\\desktop\\echo-turn.pid"
$iconPath = Join-Path $repoRoot "apps\\desktop\\build\\icon.ico"
$envPath = Join-Path $repoRoot ".env"
$turnDir = Join-Path $repoRoot "tools\\turn"
$turnEnvPath = Join-Path $turnDir ".env"
$turnExePath = Join-Path $turnDir "bin\\echo-turn.exe"

$trayLog = Join-Path $env:APPDATA "@echo\\desktop\\logs\\echo-tray.log"

function Write-Log($message) {
  try {
    $dir = Split-Path -Parent $trayLog
    if (!(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $ts = (Get-Date).ToString("s")
    Add-Content -Path $trayLog -Value ("{0} {1}" -f $ts, $message) -Encoding ascii
  } catch {}
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

function Get-EnvValue($key, $default = "") {
  if (!(Test-Path $envPath)) { return $default }
  $lines = Get-Content -Path $envPath
  foreach ($line in $lines) {
    $trim = $line.Trim()
    if (!$trim -or $trim.StartsWith("#")) { continue }
    $idx = $trim.IndexOf("=")
    if ($idx -le 0) { continue }
    $k = $trim.Substring(0, $idx).Trim()
    if ($k -ne $key) { continue }
    return $trim.Substring($idx + 1)
  }
  return $default
}

function Get-ServerPort {
  $raw = Get-EnvValue "PORT" "5050"
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

function Get-ServerUrl {
  return "{0}://localhost:{1}" -f (Get-ServerProtocol), (Get-ServerPort)
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
  $pid = Get-Content -Path $pidFile -ErrorAction SilentlyContinue
  if (!$pid) { return $null }
  try {
    return Get-Process -Id $pid -ErrorAction Stop
  } catch {
    Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Write-Pid($pid) {
  $dir = Split-Path -Parent $pidFile
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $pidFile -Value $pid -Encoding ascii
}

function Get-TurnProcess {
  if (!(Test-Path $turnPidFile)) { return $null }
  $pid = Get-Content -Path $turnPidFile -ErrorAction SilentlyContinue
  if (!$pid) { return $null }
  try {
    return Get-Process -Id $pid -ErrorAction Stop
  } catch {
    Remove-Item -Path $turnPidFile -Force -ErrorAction SilentlyContinue
    return $null
  }
}

function Write-TurnPid($pid) {
  $dir = Split-Path -Parent $turnPidFile
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $turnPidFile -Value $pid -Encoding ascii
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
  $running = Get-ServerProcess
  if ($running) { return }
  $cli = Join-Path $repoRoot "apps\\server\\dist\\cli.js"
  if (!(Test-Path $cli)) {
    Write-Log "Server build missing. Run npm.cmd run build -w @echo/server"
    return
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
    Write-Log "Server start requested (pid=$($p.Id))"
  } catch {
    Write-Log "Failed to start server: $($_.Exception.Message)"
  }
}

function Stop-Server {
  $proc = Get-ServerProcess
  if ($proc) {
    try { Stop-Process -Id $proc.Id -Force } catch {}
  }
  Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
}

function Restart-Server {
  Stop-Server
  Start-Sleep -Milliseconds 500
  Start-Server
}

function Open-Admin {
  Start-Process (Get-ServerUrl)
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

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Enabled = $false

$startItem = New-Object System.Windows.Forms.ToolStripMenuItem
$startItem.Text = "Start Server"
$startItem.add_Click({ Start-Server })

$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem
$stopItem.Text = "Stop Server"
$stopItem.add_Click({ Stop-Server })

$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem
$restartItem.Text = "Restart Server"
$restartItem.add_Click({ Restart-Server })

$openUiItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openUiItem.Text = "Open Admin UI"
$openUiItem.add_Click({ Open-Admin })

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
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $openUiItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $startItem,
  $stopItem,
  $restartItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $openLogsItem,
  (New-Object System.Windows.Forms.ToolStripSeparator),
  $quitItem
))

$tray.ContextMenuStrip = $menu
$tray.add_Click({ Open-Admin })

function Update-Status {
  $running = Get-ServerProcess
  $turnRunning = Get-TurnProcess
  if ($running) {
    $statusItem.Text = "Echo Chamber Server (Running)"
    $startItem.Enabled = $false
    $stopItem.Enabled = $true
    $restartItem.Enabled = $true
  } else {
    $statusItem.Text = "Echo Chamber Server (Stopped)"
    $startItem.Enabled = $true
    $stopItem.Enabled = $false
    $restartItem.Enabled = $false
  }
  $turnLabel = if ($turnRunning) { "TURN: on" } else { "TURN: off" }
  $tray.Text = "{0} - {1}" -f $statusItem.Text, $turnLabel
}

function Ensure-ServerRunning([int]$maxAttempts = 5) {
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if (Test-ServerListening) { return $true }
    $proc = Get-ServerProcess
    if ($proc) {
      Write-Log "Server process found but port not listening. Restarting (attempt $attempt)."
      Stop-Server
      Start-Sleep -Milliseconds 300
    }
    Start-Server
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
  $ok = Ensure-ServerRunning 5
  if ($ok) {
    Write-Log "Server listening on startup"
  } else {
    Write-Log "Server failed to listen on startup after retries"
  }
  Update-Status
}

[System.Windows.Forms.Application]::Run()
