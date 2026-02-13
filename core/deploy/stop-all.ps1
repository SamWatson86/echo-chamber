Get-Process -Name "echo-core-control" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "echo-core-client" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "echo-core-admin" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "livekit-server" -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "All Echo Chamber processes stopped."
