# Contributing

## Branching
- `main` = production
- `dev` = integration/testing

## How to submit changes
1) Branch from `dev`
2) Make changes
3) Run verification checks
4) Push your branch
5) Open a Pull Request into `dev`

## Verification
- Quick (required): `bash tools/verify/quick.sh`
- Extended (for risky changes): `bash tools/verify/extended.sh`
- Attach repro + validation evidence in PR description

## Merge safety
- Never push directly to `main`/`master`
- Require human approval before merge

## Code style
- Keep changes small and testable
- Avoid committing secrets (.env is ignored)
- Update docs for any operational change

