[System.Net.ServicePointManager]::ServerCertificateValidationCallback = { param() return $true }
$wc = New-Object System.Net.WebClient
$wc.Headers.Add("Content-Type", "application/json")

# Login
$loginResp = $wc.UploadString("https://127.0.0.1:9443/v1/auth/login", "POST", '{"password":"EchoCore-8a8e3854"}')
$token = ($loginResp | ConvertFrom-Json).token

# Dashboard (who's online, rooms, stats)
$wc2 = New-Object System.Net.WebClient
$wc2.Headers.Add("Authorization", "Bearer $token")
$dashboard = $wc2.DownloadString("https://127.0.0.1:9443/admin/api/dashboard")
Write-Output "=== DASHBOARD ==="
Write-Output $dashboard

# Metrics (quality stats)
$wc3 = New-Object System.Net.WebClient
$wc3.Headers.Add("Authorization", "Bearer $token")
$metrics = $wc3.DownloadString("https://127.0.0.1:9443/admin/api/metrics")
Write-Output "`n=== METRICS ==="
Write-Output $metrics
