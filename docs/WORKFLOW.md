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
