# Dev vs Prod Workflow

We maintain two long-lived branches:
- `main` = **production** (what you run on your server)
- `dev` = **integration** (incoming changes to test)

## How friends contribute
1) Create a branch from `dev`
2) Push to GitHub
3) Open a Pull Request **into `dev`**

## How you deploy
1) Test locally from `dev`
2) Merge `dev` -> `main`
3) Pull `main` on the server and restart

## Commands (server PC)
### Pull production (live server)
```
git checkout main
git pull origin main
```

### Pull dev (testing)
```
git checkout dev
git pull origin dev
```

## Running with dev/prod env files
You can keep separate config files and select them at startup.

Supported locations:
- repo root: `.env.dev`, `.env.prod`
- or `apps/server/.env.dev`, `apps/server/.env.prod`

```
ECHO_ENV=dev   # loads .env.dev if present
ECHO_ENV=prod  # loads .env.prod if present
```

You can also point to a specific file:
```
ECHO_ENV_FILE=F:\\path\\to\\.env.prod
```

Helper scripts:
```
tools\\run-dev.ps1
tools\\run-prod.ps1
```

## Full Stack (future)
When we build the full media stack, we will use a separate repo
and keep the same branch pattern (`main` = prod, `dev` = integration).
