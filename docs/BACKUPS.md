# Backups

Two types of backups are recommended:

## 1) Clean repo backup (no dependencies)
Use when you want a compact snapshot of the codebase.
Excludes node_modules and logs.

```
tar -a -c -f Releases\\backup-YYYYMMDD-HHMMSS-clean.zip --exclude="node_modules" --exclude="logs" --exclude="Releases" --exclude=".tmp-appasar" --exclude="apps/server/logs" --exclude="tools/turn/bin" -C . .
```

## 2) Config + secrets backup
Includes .env files and TLS certs. Store securely.

Suggested contents:
- repo root `.env`
- `apps/server/.env`
- `%APPDATA%\\@echo\\desktop\\echo-chamber.env`
- `%APPDATA%\\Echo Chamber\\certs\\`

We generate a zip in `Releases/` containing those paths.

## Restore
1) Unzip the clean backup to a folder.
2) Restore config files and TLS certs to the same paths.
3) Run:
   - `npm install`
   - `npm run build`
4) Start the server or use the tray launcher.

