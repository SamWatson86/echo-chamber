# GitHub Setup (Personal Repo)

This guide assumes Git is installed on Windows.

## 1) Initialize the repo locally
From the project root:
```
git init
git add .
git commit -m "Initial commit"
```

## 2) Create a GitHub repository
Create a new private repo on GitHub (recommended).
Example name: `echo-chamber`

## 3) Add remote and push
```
git remote add origin https://github.com/<YOUR_USER>/<YOUR_REPO>.git
git branch -M main
git push -u origin main
```

## 4) Collaboration
Invite collaborators in GitHub:
- Repo -> Settings -> Collaborators

## Notes
- `.env` files are ignored by `.gitignore`
- Keep backups of secrets and certs locally

