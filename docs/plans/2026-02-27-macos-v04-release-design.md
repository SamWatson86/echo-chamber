# macOS v0.4.0 Release Design

## Goal
Ship a working macOS DMG with full feature parity (minus WASAPI audio capture), working auto-updater, and proper camera/mic permissions. Two friends on Apple Silicon Macs (M1+) need to install and use Echo Chamber.

## What Ships

**Version 0.4.0** — both Windows and macOS.

### Release Artifacts
| Platform | Install artifact | Updater artifact |
|----------|-----------------|------------------|
| Windows x86_64 | `Echo.Chamber_0.4.0_x64-setup.exe` | `.exe` + `.exe.sig` |
| macOS aarch64 | `Echo.Chamber_0.4.0_aarch64.dmg` | `.app.tar.gz` + `.app.tar.gz.sig` |

### Unified `latest.json`
```json
{
  "version": "0.4.0",
  "notes": "...",
  "pub_date": "...",
  "platforms": {
    "windows-x86_64": {
      "signature": "...",
      "url": "https://github.com/.../Echo.Chamber_0.4.0_x64-setup.exe"
    },
    "darwin-aarch64": {
      "signature": "...",
      "url": "https://github.com/.../Echo.Chamber_0.4.0_aarch64.dmg.tar.gz"
    }
  }
}
```

## Changes Required

### 1. `tauri.conf.json`
- Bump version `0.3.1` -> `0.4.0`
- Add `"dmg"` to bundle targets: `["nsis", "dmg"]`

### 2. `release.yml` — Tag-triggered release workflow
- Add a third job `publish-manifest` that runs after both `build-windows` and `build-macos`
- Windows job: upload artifacts + signature as build outputs
- macOS job: produce `.app.tar.gz` + `.app.tar.gz.sig` (Tauri generates these when `createUpdaterArtifacts: true` and signing key is present)
- `publish-manifest` job: collect both signatures, generate unified `latest.json`, upload to release

### 3. `build-macos.yml` — Standalone macOS builder
- Keep as `workflow_dispatch` only (manual)
- Ensure it produces updater artifacts when signing key is available
- Upload both DMG and `.app.tar.gz` to latest release

### 4. `build-release.ps1` — Local build script
- Add `darwin-aarch64` entry to the generated `latest.json`
- macOS URL points to GitHub Releases (since macOS is only built in CI)

### 5. Notarization readiness (future)
- CI structured so adding Apple Developer secrets enables notarization
- `signingIdentity` stays `"-"` (ad-hoc) until Apple account is available
- Entitlements.plist already has camera + mic permissions

## First-Launch Experience (macOS)
1. Download DMG from GitHub Releases
2. Open DMG, drag to Applications
3. First launch: right-click > Open > click "Open" (Gatekeeper bypass, one-time)
4. macOS prompts for camera + mic access
5. App connects to server, works normally
6. Future updates: auto-updater checks `latest.json`, downloads + installs

## What's NOT Included
- Apple notarization (requires $99/year developer account — can add later)
- Intel Mac (x86_64) build (no friends need it)
- Per-process audio capture on macOS (WASAPI is Windows-only; stub returns helpful error)
