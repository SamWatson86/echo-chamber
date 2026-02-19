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
