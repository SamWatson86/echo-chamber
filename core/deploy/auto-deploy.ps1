# Echo Chamber - Auto Deploy
# Polls GitHub for new releases and deploys when a new one is found.
# Run as a scheduled task or in a loop.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File auto-deploy.ps1
#   powershell -ExecutionPolicy Bypass -File auto-deploy.ps1 -Once   (single check, no loop)
#
# Setup as Windows Scheduled Task (runs every 5 minutes):
#   schtasks /create /tn "EchoChamber-AutoDeploy" /tr "powershell -ExecutionPolicy Bypass -File F:\path\to\auto-deploy.ps1 -Once" /sc minute /mo 5 /ru SYSTEM

param(
    [switch]$Once
)

# --- Config ---
$repo = "SamWatson86/echo-chamber"
$pollInterval = 300  # seconds between checks (5 min)
$rootDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$coreDir = Join-Path $rootDir "core"
$stateFile = Join-Path $PSScriptRoot ".last-deployed-tag"
$logFile = Join-Path $PSScriptRoot "auto-deploy.log"

function Write-Log([string]$msg, [string]$level = "INFO") {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] [$level] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

function Get-LatestRelease {
    try {
        $headers = @{ "Accept" = "application/vnd.github.v3+json" }
        # Use GitHub token if available (avoids rate limits)
        $token = $env:GITHUB_TOKEN
        if ($token) {
            $headers["Authorization"] = "token $token"
        }
        $resp = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 15
        return $resp
    } catch {
        Write-Log "Failed to fetch latest release: $_" "WARN"
        return $null
    }
}

function Get-LastDeployedTag {
    if (Test-Path $stateFile) {
        return (Get-Content $stateFile -Raw).Trim()
    }
    return ""
}

function Set-LastDeployedTag([string]$tag) {
    Set-Content -Path $stateFile -Value $tag
}

function Deploy-Release([string]$tag) {
    Write-Log "Deploying $tag ..."

    # Pull latest from main
    Push-Location $rootDir
    try {
        Write-Log "Pulling latest from origin/main ..."
        git pull origin main 2>&1 | ForEach-Object { Write-Log "  git: $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Log "git pull failed (exit code $LASTEXITCODE)" "ERROR"
            Pop-Location
            return $false
        }
    } catch {
        Write-Log "git pull exception: $_" "ERROR"
        Pop-Location
        return $false
    }
    Pop-Location

    # Build the Rust workspace
    Push-Location $coreDir
    try {
        Write-Log "Building workspace (cargo build --workspace) ..."
        cargo build --workspace 2>&1 | ForEach-Object { Write-Log "  cargo: $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Log "cargo build failed (exit code $LASTEXITCODE)" "ERROR"
            Pop-Location
            return $false
        }
        Write-Log "Build succeeded."
    } catch {
        Write-Log "cargo build exception: $_" "ERROR"
        Pop-Location
        return $false
    }
    Pop-Location

    # Restart the control plane
    $restartScript = Join-Path $coreDir ".tmp-restart-control.ps1"
    if (Test-Path $restartScript) {
        Write-Log "Restarting control plane ..."
        try {
            & powershell -ExecutionPolicy Bypass -File $restartScript 2>&1 | ForEach-Object { Write-Log "  restart: $_" }
            Write-Log "Control plane restarted."
        } catch {
            Write-Log "Restart failed: $_" "WARN"
        }
    } else {
        Write-Log "No restart script found at $restartScript - skipping restart" "WARN"
    }

    Set-LastDeployedTag $tag
    Write-Log "Deploy complete: $tag"
    return $true
}

# --- Main ---
Write-Log "Echo Chamber Auto-Deploy starting (repo: $repo)"
Write-Log "Root dir: $rootDir"
Write-Log "Poll interval: ${pollInterval}s"

do {
    $release = Get-LatestRelease
    if ($release) {
        $latestTag = $release.tag_name
        $lastDeployed = Get-LastDeployedTag

        if ($latestTag -and ($latestTag -ne $lastDeployed)) {
            Write-Log "New release found: $latestTag (last deployed: $lastDeployed)"
            $success = Deploy-Release $latestTag
            if ($success) {
                Write-Log "Successfully deployed $latestTag"
            } else {
                Write-Log "Deploy failed for $latestTag - will retry next poll" "ERROR"
            }
        } else {
            Write-Log "Up to date ($latestTag)" "DEBUG"
        }
    }

    if (!$Once) {
        Start-Sleep -Seconds $pollInterval
    }
} while (!$Once)
