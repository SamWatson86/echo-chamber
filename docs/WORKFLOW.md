# Development Workflow

## Branch model

- `main` = release-ready branch
- feature/fix/docs branches = PR branches

## Rules

1. Never push directly to `main`/`master`.
2. Use pull requests for all changes.
3. Required verification checks must pass before merge.
4. Prefer small, focused PRs unless intentionally batching foundational work.

## Typical flow

1. Branch from `main`.
2. Implement change.
3. Run quick verification locally.
4. Push branch and open PR.
5. Ensure CI checks pass.
6. Merge.

## Codex Thread Flow

Use **Echo Chamber - Main** as the canonical Codex project.

For each real bug:

1. Start a new thread under **Echo Chamber - Main**.
2. Choose a new worktree from `main` if code may change.
3. Use a branch named `codex/bug-short-description`.
4. Classify runtime surface and release impact before editing.
5. Include an ELI5 summary in the PR or final bug-fix report.

Do not create new Codex projects for ordinary Echo bug work.

## PR description minimum

- linked issue(s)
- what changed and why
- release impact (`server-only` / `desktop-binary` / `both`)
- evidence of verification

## Foundation-first policy

For large fix waves:
- merge verification/testing foundation first
- then branch fix/enhancement waves on top
- avoid carrying large stacks that rebase badly
