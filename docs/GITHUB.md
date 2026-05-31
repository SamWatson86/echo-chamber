# GitHub Project Conventions

This project uses GitHub as the coordination surface for code, issues, and PR-driven releases.

## Repository features

Recommended:
- Issues: enabled
- Pull Requests: enabled
- Actions: enabled (cost-aware workflows)
- Discussions/Wiki: optional (not required if docs live in `/docs`)

## Branch protection (recommended)

Protect `main` with:
- required status checks
- PR required before merge
- no force-push
- optional required approvals (team preference)

## Labels

Use consistent triad labels on issues:
- one `type:*`
- one `area:*`
- one `sev:*`

Optional release impact labels for PRs/issues:
- `release-impact:server-only`
- `release-impact:desktop-binary`
- `release-impact:both`

## PR hygiene

- include linked issue(s)
- include release impact statement
- include verification evidence
- keep scope narrow unless batching foundational work intentionally

## Release verification gotchas

- Windows-only unless Sam explicitly asks otherwise. Do not add or wait on macOS release jobs for normal Echo Chamber releases.
- Normal desktop releases are published locally from Sam's PC with `core/deploy/publish-local-release.ps1`; the GitHub release workflow is manual fallback only and no longer runs on tag push.
- Do not claim a desktop release is done from a local build alone. Verify the GitHub Release/tag/assets and the updater manifest.
- Keep version sources in sync for desktop releases:
  - `core/client/tauri.conf.json`
  - `core/client/Cargo.toml`
  - `core/control/Cargo.toml` when the server/control version is part of the release
  - `core/deploy/latest.json` after the published release manifest is available
- Verify both live endpoints after shipping:
  - `https://echo.fellowshipoftheboatrace.party:9443/api/version`
  - `https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json`
- An update banner in the app means the server-served updater metadata and the installed desktop version disagree. Check the manifest before assuming the client install failed.
- If doing a manual viewer-only deploy, make sure the deploy watcher state is not left pointing at an older SHA that will trigger an unnecessary rebuild/restart later.

## Fast local Windows desktop release

Use this path for live testing with friends when a new desktop binary is needed and `main` already contains the merged release commit.

Prerequisites:
- Run from a clean, up-to-date `main` branch.
- `gh` is installed and authenticated.
- `core/client/.tauri-keys` is present on the release machine.
- Version files and `CHANGELOG.md` are already bumped for the release.

Command:

```powershell
powershell -ExecutionPolicy Bypass -File core\deploy\publish-local-release.ps1
```

What the script enforces:
- Fails if the worktree is dirty, not on `main`, or not equal to `origin/main`.
- Fails if the local/remote tag or GitHub Release already exists.
- Fails if `core/client/tauri.conf.json`, `core/client/Cargo.toml`, `core/control/Cargo.toml`, and `CHANGELOG.md` disagree.
- Runs local release helper tests, `cargo check -p echo-core-control`, and `node --check core/viewer/changelog.js`.
- Builds the signed Windows NSIS installer with `core/deploy/build-release.ps1`.
- Uploads the installer, `.sig`, and `latest.json` to GitHub Releases.
- Verifies the release assets exist.
- Copies the generated manifest to `core/deploy/latest.json` so `/api/update/latest.json` can serve the new version immediately.
- Leaves `core/deploy/latest.json` as a local metadata change; commit that manifest update through the normal PR path after release verification.

After publishing, verify:

```powershell
gh release view vX.Y.Z --json tagName,assets,url
curl.exe -sk https://echo.fellowshipoftheboatrace.party:9443/api/update/latest.json
curl.exe -sk https://echo.fellowshipoftheboatrace.party:9443/api/version
```

If GitHub-hosted fallback is needed, use the manual `Release` workflow with `dry_run=false` and an explicit `release_tag` matching the checked-out version. Do not push tags expecting Actions to build automatically.
