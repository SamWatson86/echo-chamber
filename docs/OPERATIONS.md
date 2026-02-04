# Operations (Runbook)

## Start / Stop (Tray)
Echo Chamber installs a Windows tray launcher at login.

Tray script:
- `tools/echo-tray.ps1`
- Startup entry: `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Echo Chamber Tray.vbs`

If the tray icon is visible:
- Right-click tray icon -> Start/Stop/Restart Server
- "Open Admin UI" opens the local web UI
- "Open Logs Folder" opens the log directory

## Startup behavior
The tray launcher auto-starts the server on login.
If the server process is missing or the port isn't listening, the launcher retries.

## Verify server is running
PowerShell:
```
Get-NetTCPConnection -LocalPort 8443 -State Listen
```

Open UI:
- `https://localhost:8443`

## Logs
Server log (desktop):
- `%APPDATA%\\@echo\\desktop\\logs\\echo-chamber-server.log`

Tray log:
- `%APPDATA%\\@echo\\desktop\\logs\\echo-tray.log`

TURN log (if enabled):
- `%APPDATA%\\@echo\\desktop\\logs\\echo-turn.log`

## Common problems
1) Tray launched but server not running
- Check `echo-tray.log`
- Check for a stale PID in `%APPDATA%\\@echo\\desktop\\echo-server.pid`

2) Screen share shows blank tile
- Browser autoplay restrictions can block video play.
- Re-click/tap the page or re-join; the client also attempts recovery.

3) No mic audio
- Check output device selection in Settings.
- Verify "Mute All" is not active.
- Confirm the peer is not muted in Active Users.

