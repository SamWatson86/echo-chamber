# macOS v0.4.0 Release — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a working v0.4.0 release with macOS DMG (Apple Silicon), working auto-updater on both platforms, and a unified release pipeline.

**Architecture:** The release workflow becomes a 3-job pipeline: Windows build, macOS build (parallel after Windows creates the release), then a manifest job that collects both signatures and generates a unified `latest.json`. The control plane syncs its local `latest.json` from the release.

**Tech Stack:** GitHub Actions, Tauri v2, Rust, PowerShell 5.1

---

### Task 1: Bump version to 0.4.0

**Files:**
- Modify: `core/client/tauri.conf.json`

**Step 1: Update version and bundle targets**

In `core/client/tauri.conf.json`, change:
```json
"version": "0.3.1",
```
to:
```json
"version": "0.4.0",
```

And change:
```json
"targets": ["nsis"],
```
to:
```json
"targets": ["nsis", "dmg"],
```

**Step 2: Commit**

```bash
git add core/client/tauri.conf.json
git commit -m "chore: bump version to 0.4.0 and add dmg to bundle targets"
```

---

### Task 2: Fix release workflow — macOS updater artifacts

**Files:**
- Modify: `.github/workflows/release.yml` (macOS job, lines 116-168)

The macOS job currently only uploads the DMG. It needs to also upload the `.app.tar.gz` and `.app.tar.gz.sig` updater artifacts, and output the signature for the manifest job.

**Step 1: Update the macOS job in release.yml**

Replace the entire `build-macos` job (lines 116-168) with:

```yaml
  build-macos:
    name: Build macOS DMG
    runs-on: macos-latest
    permissions:
      contents: write
    needs: build-windows
    outputs:
      sig: ${{ steps.sig.outputs.content }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Install Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo registry & build
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            core/target
          key: macos-cargo-${{ hashFiles('core/Cargo.lock') }}
          restore-keys: macos-cargo-

      - name: Install Tauri CLI
        run: cargo install tauri-cli --locked

      - name: Configure updater artifacts
        shell: bash
        run: |
          if [ -z "$SIGNING_KEY" ]; then
            echo "No signing key — disabling updater artifacts for this build"
            jq '.bundle.createUpdaterArtifacts = false' core/client/tauri.conf.json > tmp.json
            mv tmp.json core/client/tauri.conf.json
          fi
        env:
          SIGNING_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}

      - name: Build DMG
        working-directory: core/client
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
          CI: 'true'
        run: cargo tauri build --bundles dmg

      - name: List build output
        run: |
          echo "=== DMG ==="
          ls -la core/target/release/bundle/dmg/ || echo "No DMG found"
          echo "=== macOS updater ==="
          ls -la core/target/release/bundle/macos/ || echo "No macos updater artifacts"

      - name: Read updater signature
        id: sig
        shell: bash
        run: |
          SIG_FILE=$(ls core/target/release/bundle/macos/*.sig 2>/dev/null | head -1)
          if [ -n "$SIG_FILE" ]; then
            echo "content=$(cat "$SIG_FILE")" >> "$GITHUB_OUTPUT"
          else
            echo "content=" >> "$GITHUB_OUTPUT"
            echo "WARNING: No macOS updater signature found"
          fi

      - name: Upload DMG and updater artifacts to release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          files: |
            core/target/release/bundle/dmg/*.dmg
            core/target/release/bundle/macos/*.tar.gz
            core/target/release/bundle/macos/*.tar.gz.sig
```

**Step 2: Verify the macOS build output paths are correct**

Tauri v2 places macOS updater artifacts in `target/release/bundle/macos/`. The DMG goes in `target/release/bundle/dmg/`. The "List build output" step will confirm this at runtime. If the paths differ, the workflow will show what's actually there.

---

### Task 3: Fix release workflow — Windows job outputs signature

**Files:**
- Modify: `.github/workflows/release.yml` (Windows job, lines 13-114)

The Windows job needs to output its signature so the manifest job can use it.

**Step 1: Add outputs to the Windows job**

After line 17 (`contents: write`), add:
```yaml
    outputs:
      version: ${{ steps.version.outputs.version }}
      win_sig: ${{ steps.bundle.outputs.sig_content }}
```

**Step 2: Add sig_content output to the bundle step**

In the "Identify bundle files" step (lines 51-59), add a line to read the signature content:
```yaml
      - name: Identify bundle files
        id: bundle
        shell: bash
        run: |
          NSIS_DIR="core/target/release/bundle/nsis"
          EXE=$(ls "$NSIS_DIR"/*.exe 2>/dev/null | head -1)
          SIG=$(ls "$NSIS_DIR"/*.sig 2>/dev/null | head -1)
          echo "exe=$EXE" >> "$GITHUB_OUTPUT"
          echo "sig=$SIG" >> "$GITHUB_OUTPUT"
          if [ -n "$SIG" ]; then
            echo "sig_content=$(cat "$SIG")" >> "$GITHUB_OUTPUT"
          fi
```

**Step 3: Remove latest.json generation from Windows job**

Delete the "Generate latest.json" step (lines 79-102). The `latest.json` will be generated by the new `publish-manifest` job instead.

Also remove `latest.json` from the "Create GitHub Release" files list (line 114). The release creation step becomes:
```yaml
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          name: Echo Chamber ${{ github.ref_name }}
          body_path: release-notes.txt
          draft: false
          prerelease: false
          files: |
            core/target/release/bundle/nsis/*
```

---

### Task 4: Add publish-manifest job to release workflow

**Files:**
- Modify: `.github/workflows/release.yml` (append new job)

**Step 1: Add the publish-manifest job at the end of the file**

```yaml
  publish-manifest:
    name: Publish Update Manifest
    runs-on: ubuntu-latest
    permissions:
      contents: write
    needs: [build-windows, build-macos]

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Read version
        id: version
        shell: bash
        run: |
          VERSION=$(jq -r '.version' core/client/tauri.conf.json)
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"

      - name: Generate unified latest.json
        shell: bash
        run: |
          VERSION="${{ steps.version.outputs.version }}"
          TAG="${{ github.ref_name }}"
          DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
          WIN_SIG="${{ needs.build-windows.outputs.win_sig }}"
          MAC_SIG="${{ needs.build-macos.outputs.sig }}"

          # Windows URL (GitHub converts spaces to dots)
          WIN_URL="https://github.com/SamWatson86/echo-chamber/releases/download/${TAG}/Echo.Chamber_${VERSION}_x64-setup.exe"

          # macOS updater URL (.app.tar.gz, not .dmg)
          MAC_URL="https://github.com/SamWatson86/echo-chamber/releases/download/${TAG}/Echo.Chamber.app.tar.gz"

          # Build the manifest
          MANIFEST="{\"version\":\"${VERSION}\",\"notes\":\"Echo Chamber v${VERSION}\",\"pub_date\":\"${DATE}\",\"platforms\":{\"windows-x86_64\":{\"signature\":\"${WIN_SIG}\",\"url\":\"${WIN_URL}\"}"

          # Only add macOS if we have a signature
          if [ -n "$MAC_SIG" ]; then
            MANIFEST="${MANIFEST},\"darwin-aarch64\":{\"signature\":\"${MAC_SIG}\",\"url\":\"${MAC_URL}\"}"
          fi

          MANIFEST="${MANIFEST}}}"

          # Pretty-print
          echo "$MANIFEST" | python3 -m json.tool > latest.json
          echo "Generated latest.json:"
          cat latest.json

      - name: Upload latest.json to release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          files: latest.json
```

**Step 2: Commit the release.yml changes**

```bash
git add .github/workflows/release.yml
git commit -m "feat: unified release pipeline with macOS updater support"
```

---

### Task 5: Update standalone macOS build workflow

**Files:**
- Modify: `.github/workflows/build-macos.yml`

The standalone workflow also needs to upload updater artifacts (not just DMG) so manual builds are complete.

**Step 1: Update the build and upload steps**

After the "Build DMG" step, replace the remaining steps with:

```yaml
      - name: List build output
        run: |
          echo "=== DMG ==="
          ls -la core/target/release/bundle/dmg/ || echo "No DMG found"
          echo "=== macOS updater ==="
          ls -la core/target/release/bundle/macos/ || echo "No macos updater artifacts"

      - name: Upload DMG artifact
        uses: actions/upload-artifact@v4
        with:
          name: echo-chamber-macos-dmg
          path: |
            core/target/release/bundle/dmg/*.dmg
            core/target/release/bundle/macos/*.tar.gz
            core/target/release/bundle/macos/*.tar.gz.sig
          if-no-files-found: error

      - name: Get latest release tag
        id: latest
        shell: bash
        run: |
          TAG=$(gh release view --json tagName -q '.tagName' 2>/dev/null || echo "")
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Latest release: $TAG"
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload artifacts to latest release
        if: steps.latest.outputs.tag != ''
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.latest.outputs.tag }}
          files: |
            core/target/release/bundle/dmg/*.dmg
            core/target/release/bundle/macos/*.tar.gz
            core/target/release/bundle/macos/*.tar.gz.sig
```

**Step 2: Commit**

```bash
git add .github/workflows/build-macos.yml
git commit -m "feat: upload macOS updater artifacts in standalone build"
```

---

### Task 6: Update build-release.ps1 to include macOS in latest.json

**Files:**
- Modify: `core/deploy/build-release.ps1`

The local build script generates `latest.json` for the control plane. Add a `darwin-aarch64` entry pointing to the GitHub Release URL. We don't have the macOS signature locally (it's built in CI), so we include the URL with an empty sig — the control plane will serve whatever we give it, and the Tauri updater will fall back to showing a download link if the sig is missing.

**Step 1: Update the manifest generation block (lines 82-92)**

Replace the `$manifest = @{...}` block with:

```powershell
    # GitHub converts spaces to dots in asset filenames
    $ghFileName = $setupExe.Name -replace ' ', '.'

    # macOS updater artifact name (built by CI, not locally)
    $macTarGz = "Echo.Chamber.app.tar.gz"

    $manifest = @{
        version = $version
        notes = "Echo Chamber v$version"
        pub_date = $now
        platforms = @{
            "windows-x86_64" = @{
                signature = $sig.Trim()
                url = "https://github.com/SamWatson86/echo-chamber/releases/download/v$version/$ghFileName"
            }
            "darwin-aarch64" = @{
                signature = ""
                url = "https://github.com/SamWatson86/echo-chamber/releases/download/v$version/$macTarGz"
            }
        }
    } | ConvertTo-Json -Depth 4
```

Note: The macOS signature will be empty in the locally-generated manifest. After CI completes, download the CI-generated `latest.json` from the GitHub Release to get the full manifest with both sigs. A helper step is added in Task 7.

**Step 2: Add post-release instructions to the script output**

After the existing "RELEASE READY" output block, add:

```powershell
Write-Status "After CI completes the macOS build:" Yellow
Write-Status "  Download latest.json from the GitHub Release and copy to core\deploy\" Yellow
Write-Status "  Or run: gh release download v$version -p latest.json -D core\deploy\ --clobber" Yellow
```

**Step 3: Commit**

```bash
git add core/deploy/build-release.ps1
git commit -m "feat: include darwin-aarch64 in local latest.json manifest"
```

---

### Task 7: Add sync-manifest helper script

**Files:**
- Create: `core/deploy/sync-manifest.ps1`

A simple script to download the CI-generated `latest.json` (with both platform signatures) from the latest GitHub Release and copy it to `core/deploy/` where the control plane serves it.

**Step 1: Create the script**

```powershell
# Echo Chamber - Sync Update Manifest
# Downloads the latest.json from GitHub Releases to core/deploy/ so the
# control plane serves the correct update manifest for all platforms.
#
# Usage: powershell -ExecutionPolicy Bypass -File sync-manifest.ps1

$deployDir = $PSScriptRoot

function Write-Status([string]$msg, [string]$color = "Cyan") {
    Write-Host "[sync] " -NoNewline -ForegroundColor DarkGray
    Write-Host $msg -ForegroundColor $color
}

# Get the latest release tag
$tag = gh release view --json tagName -q '.tagName' 2>$null
if (!$tag) {
    Write-Status "No GitHub release found. Push a tag first." Red
    return
}

Write-Status "Latest release: $tag"

$manifestPath = Join-Path $deployDir "latest.json"

# Download latest.json from the release
gh release download $tag -p "latest.json" -D $deployDir --clobber 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Status "Failed to download latest.json from release $tag" Red
    return
}

if (Test-Path $manifestPath) {
    $content = Get-Content $manifestPath -Raw | ConvertFrom-Json
    Write-Status "Synced latest.json (v$($content.version))" Green
    $platforms = ($content.platforms | Get-Member -MemberType NoteProperty).Name
    foreach ($p in $platforms) {
        $hasSig = if ($content.platforms.$p.signature) { "signed" } else { "unsigned" }
        Write-Status "  $p - $hasSig" Green
    }
} else {
    Write-Status "Download succeeded but file not found at $manifestPath" Red
}
```

**Step 2: Commit**

```bash
git add core/deploy/sync-manifest.ps1
git commit -m "feat: add sync-manifest script to pull latest.json from GitHub Releases"
```

---

### Task 8: Add CHANGELOG entry for v0.4.0

**Files:**
- Modify: `CHANGELOG.md` (if it exists, create if not)

**Step 1: Add v0.4.0 entry**

```markdown
## 0.4.0

- macOS Apple Silicon (aarch64) DMG now included in releases
- macOS auto-updater support via unified latest.json manifest
- Viewer refactored into modular JS files (auth, chat, media, etc.)
- Fix camera desync under rapid toggling
- Fix camera state tracking to use SDK isCameraEnabled
- Improved connection lifecycle and state management
```

**Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add v0.4.0 changelog"
```

---

### Task 9: Tag and push the release

**Step 1: Create the version tag**

```bash
git tag v0.4.0
```

**Step 2: Push the tag (triggers release workflow)**

```bash
git push origin main
git push origin v0.4.0
```

This triggers `release.yml` which will:
1. Build Windows NSIS installer
2. Create GitHub Release
3. Build macOS DMG + updater artifacts
4. Generate unified `latest.json` with both platforms
5. Upload everything to the release

**Step 3: Monitor CI**

```bash
gh run watch
```

---

### Task 10: Sync manifest to control plane after CI completes

**Step 1: Run the sync script**

```powershell
powershell -ExecutionPolicy Bypass -File core\deploy\sync-manifest.ps1
```

**Step 2: Verify the manifest has both platforms**

```bash
cat core/deploy/latest.json
```

Expected: JSON with both `windows-x86_64` and `darwin-aarch64` entries, both with signatures.

**Step 3: Restart the control plane so it picks up the new manifest**

The control plane reads `latest.json` on each request (no caching), so no restart is actually needed. Verify:

```bash
curl -sk https://127.0.0.1:9443/api/update/latest.json | python3 -m json.tool
```

---

### Task 11: Verify macOS DMG on GitHub Release

**Step 1: Check the release assets**

```bash
gh release view v0.4.0 --json assets --jq '.assets[].name'
```

Expected output should include:
- `Echo.Chamber_0.4.0_x64-setup.exe`
- `Echo.Chamber_0.4.0_x64-setup.exe.sig`
- `Echo.Chamber_0.4.0_aarch64.dmg`
- `Echo.Chamber.app.tar.gz` (or similar)
- `Echo.Chamber.app.tar.gz.sig`
- `latest.json`

**Step 2: Get the download URL for friends**

```bash
gh release view v0.4.0 --json assets --jq '.assets[] | select(.name | endswith(".dmg")) | .url'
```

Or direct link: `https://github.com/SamWatson86/echo-chamber/releases/download/v0.4.0/Echo.Chamber_0.4.0_aarch64.dmg`

---

### Task 12: Write install instructions for Mac friends

Create a short message Sam can send to friends:

```
Hey! Download Echo Chamber for Mac:

1. Go to: https://github.com/SamWatson86/echo-chamber/releases/latest
2. Download "Echo.Chamber_0.4.0_aarch64.dmg"
3. Open the DMG and drag Echo Chamber to Applications
4. First time opening: Right-click the app > Open > click "Open"
   (macOS security thing — only needed once)
5. When it asks for camera + mic access, click Allow
6. You're in!
```
