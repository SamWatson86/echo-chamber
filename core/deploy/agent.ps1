# Echo Chamber Deploy Agent
# Runs on SAM-PC (test machine) as an HTTP listener.
# Accepts build pushes from dev PC, manages the native client process.
#
# Endpoints:
#   GET  /health          - Returns agent status
#   POST /deploy          - Receives new .exe build (binary body)
#   GET  /logs            - Returns recent stdout/stderr logs
#   POST /restart         - Kills and restarts the client
#   POST /stop            - Stops the client
#
# Usage: powershell -ExecutionPolicy Bypass -File agent.ps1

param(
    [int]$Port = 8080,
    [string]$InstallDir = "C:\EchoChamber"
)

$ErrorActionPreference = "Continue"

# Ensure install directory exists
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$exePath = Join-Path $InstallDir "echo-core-client.exe"
$stdoutLog = Join-Path $InstallDir "client-stdout.log"
$stderrLog = Join-Path $InstallDir "client-stderr.log"
$agentLog = Join-Path $InstallDir "agent.log"
$pidFile = Join-Path $InstallDir "client.pid"

function Write-Log([string]$msg) {
    $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $line = "$ts  $msg"
    Write-Host $line
    Add-Content -Path $agentLog -Value $line -ErrorAction SilentlyContinue
}

function Get-ClientProcess {
    if (Test-Path $pidFile) {
        $cpid = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($cpid) {
            $proc = Get-Process -Id $cpid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq "echo-core-client") {
                return $proc
            }
        }
    }
    return $null
}

function Stop-Client {
    $proc = Get-ClientProcess
    if ($proc) {
        Write-Log "Stopping client (PID $($proc.Id))..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        Write-Log "Client stopped."
    }
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}

function Start-Client {
    if (!(Test-Path $exePath)) {
        Write-Log "No client exe found at $exePath"
        return $false
    }
    Stop-Client

    # Clear old logs
    if (Test-Path $stdoutLog) { "" | Set-Content $stdoutLog }
    if (Test-Path $stderrLog) { "" | Set-Content $stderrLog }

    $proc = Start-Process -FilePath $exePath -WorkingDirectory $InstallDir -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
    Set-Content -Path $pidFile -Value $proc.Id
    Write-Log "Client started (PID $($proc.Id))."
    return $true
}

function Send-Response($context, [int]$code, [string]$body, [string]$contentType = "application/json") {
    $response = $context.Response
    $response.StatusCode = $code
    $response.ContentType = $contentType
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($body)
    $response.ContentLength64 = $buffer.Length
    $response.OutputStream.Write($buffer, 0, $buffer.Length)
    $response.Close()
}

function Get-TailContent([string]$path, [int]$lines = 200) {
    if (!(Test-Path $path)) { return "" }
    $content = Get-Content $path -Tail $lines -ErrorAction SilentlyContinue
    if ($content) { return ($content -join "`n") }
    return ""
}

# Start HTTP listener
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")

try {
    $listener.Start()
} catch {
    Write-Log "Failed to start on port $Port (try running as Admin): $_"
    Write-Log "Trying localhost-only binding..."
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://localhost:$Port/")
    $listener.Start()
}

Write-Log "Deploy agent listening on port $Port"
Write-Log "Install dir: $InstallDir"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        break
    }

    $method = $context.Request.HttpMethod
    $path = $context.Request.Url.AbsolutePath
    Write-Log "$method $path"

    try {
        switch -Exact ($path) {
            "/health" {
                $proc = Get-ClientProcess
                $running = $proc -ne $null
                $hasExe = Test-Path $exePath
                $body = @{
                    agent = "ok"
                    client_running = $running
                    client_pid = if ($running) { $proc.Id } else { $null }
                    has_exe = $hasExe
                } | ConvertTo-Json
                Send-Response $context 200 $body
            }

            "/deploy" {
                if ($method -ne "POST") {
                    Send-Response $context 405 '{"error":"POST required"}'
                    continue
                }

                Write-Log "Receiving new build..."
                Stop-Client

                # Read binary body
                $stream = $context.Request.InputStream
                $ms = New-Object System.IO.MemoryStream
                $stream.CopyTo($ms)
                $bytes = $ms.ToArray()
                $ms.Dispose()

                if ($bytes.Length -lt 1024) {
                    Send-Response $context 400 '{"error":"payload too small"}'
                    continue
                }

                # Backup old exe
                if (Test-Path $exePath) {
                    $backup = "$exePath.bak"
                    Copy-Item $exePath $backup -Force -ErrorAction SilentlyContinue
                }

                # Write new exe
                [System.IO.File]::WriteAllBytes($exePath, $bytes)
                Write-Log "New build written ($($bytes.Length) bytes)."

                # Start the new build
                $ok = Start-Client
                if ($ok) {
                    Send-Response $context 200 '{"status":"deployed","size":' + $bytes.Length + '}'
                } else {
                    Send-Response $context 500 '{"error":"failed to start client"}'
                }
            }

            "/logs" {
                $stdout = Get-TailContent $stdoutLog 200
                $stderr = Get-TailContent $stderrLog 200
                $agentTail = Get-TailContent $agentLog 50
                $body = @{
                    stdout = $stdout
                    stderr = $stderr
                    agent = $agentTail
                } | ConvertTo-Json -Depth 3
                Send-Response $context 200 $body
            }

            "/restart" {
                if ($method -ne "POST") {
                    Send-Response $context 405 '{"error":"POST required"}'
                    continue
                }
                $ok = Start-Client
                if ($ok) {
                    Send-Response $context 200 '{"status":"restarted"}'
                } else {
                    Send-Response $context 500 '{"error":"no exe found"}'
                }
            }

            "/stop" {
                if ($method -ne "POST") {
                    Send-Response $context 405 '{"error":"POST required"}'
                    continue
                }
                Stop-Client
                Send-Response $context 200 '{"status":"stopped"}'
            }

            "/config" {
                if ($method -ne "POST") {
                    Send-Response $context 405 '{"error":"POST required"}'
                    continue
                }
                $reader = New-Object System.IO.StreamReader($context.Request.InputStream)
                $body = $reader.ReadToEnd()
                $reader.Dispose()
                $configPath = Join-Path $InstallDir "config.json"
                Set-Content -Path $configPath -Value $body -Encoding UTF8
                Write-Log "Config written to $configPath"
                Send-Response $context 200 '{"status":"config updated"}'
            }

            default {
                Send-Response $context 404 '{"error":"not found"}'
            }
        }
    } catch {
        Write-Log "Error handling request: $_"
        try { Send-Response $context 500 "{`"error`":`"$_`"}" } catch {}
    }
}

$listener.Stop()
Write-Log "Deploy agent stopped."
