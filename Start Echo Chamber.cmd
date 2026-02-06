@echo off
setlocal
cd /d "%~dp0"
start "Echo Chamber Server" cmd /k "npm run start"
timeout /t 3 >nul
start "" "https://localhost:8443"
