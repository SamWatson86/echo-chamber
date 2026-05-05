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
