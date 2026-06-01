# Backups

Two backup types are useful. Keep them separate so repo snapshots stay compact
and secrets stay controlled.

## Clean Repo Backup

Use this when you want a compact codebase snapshot without dependencies, logs,
or generated release artifacts.

```powershell
tar -a -c -f Releases\backup-YYYYMMDD-HHMMSS-clean.zip --exclude="node_modules" --exclude="logs" --exclude="Releases" --exclude=".tmp-appasar" --exclude="core/target" --exclude="tools/turn/bin" -C . .
```

## Config And Secrets Backup

Store these securely. Suggested contents:

- `core/deploy/latest.json` if preserving the exact served updater manifest
- `C:\ProgramData\Echo Chamber\echo-core-host.json`
- `%APPDATA%\Echo Chamber\certs\`
- any local `.tauri-keys` material used for Windows desktop signing
- any environment files Sam explicitly uses for the current deployment

Do not assume old root `apps/*` paths still exist. The active product lives
under `core/`.

## Restore

1. Unzip the clean backup to a folder.
2. Restore config files, certificates, signing keys, and environment files to
   their expected paths.
3. Follow `docs/OPERATIONS.md` for service verification before claiming the
   machine is ready.
