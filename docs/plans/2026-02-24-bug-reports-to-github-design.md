# Bug Reports to GitHub Issues

**Date**: 2026-02-24
**Issue**: #23
**Scope**: Rust control plane only, no viewer changes

## Problem
Bug reports from friends are saved to local JSON files and only visible in the admin dashboard. Sam has to manually check them. Friends can't track whether their reported bugs are being worked on.

## Design

### Behavior
When a bug report is submitted via `/api/bug-report`, the server:
1. Saves to disk (existing behavior, unchanged)
2. Stores in memory (existing behavior, unchanged)
3. Spawns an async task to create a GitHub Issue (new, fire-and-forget)

If the GitHub call fails, the report is still saved locally. No user-facing error.

### GitHub Issue Format
- **Title**: `Bug: <first 80 chars of description>`
- **Body**: Reporter name, room, description, WebRTC stats table, screenshot link
- **Label**: `bug-report`

### Configuration
- `GITHUB_PAT` env var — Personal Access Token with "Issues: write" scope
- `GITHUB_REPO` env var — e.g., `SamWatson86/echo-chamber`
- If either is missing, GitHub integration is silently disabled

### What It Does NOT Do
- No screenshot upload to GitHub (linked by server URL)
- No duplicate detection
- No viewer UI changes
- No blocking — async fire-and-forget

## Files Modified
- `core/control/src/main.rs` — GitHub config fields, async issue creation after bug report save
- `core/control/.env` — Add GITHUB_PAT and GITHUB_REPO
- `core/control/.env.example` — Document the new vars
