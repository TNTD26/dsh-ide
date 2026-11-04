# Upload this repository to GitHub
#
# These commands are for the maintainer, not end users.
# Run them from the folder containing README.md, dsh-ide-plugin/, dsh-ide-lsp/
# and dsh-ide-editor/.

## 1. Install Git

Check:

```powershell
git --version
```

If it is missing, install Git for Windows:

https://git-scm.com/download/win

## 2. Create an empty GitHub repository

1. Sign in to https://github.com
2. Click **New repository**
3. Name it, for example `dsh-ide`
4. Choose **Public**
5. Do **not** initialize with README, .gitignore, or license
6. Click **Create repository**

## 3. Initialize and push

From this folder:

```powershell
git init
git add .
git status
```

If the folder already contains a `.git` directory (this packaged folder was
initialized for you), skip `git init` and continue with `git add .`.

Check that `node_modules/`, `.npm-cache/`, `.env`, `*.pem` are not listed.

Before the first commit, tell Git who you are (use your own name/email):

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Then:

```powershell
git commit -m "Initial release: DSH IDE"
git branch -M main
git remote add origin https://github.com/<your-name>/dsh-ide.git
git push -u origin main
```

Replace `<your-name>` with your GitHub username.

If `git remote add` says the remote already exists:

```powershell
git remote set-url origin https://github.com/<your-name>/dsh-ide.git
```

When Git asks for credentials:

- Prefer the browser login opened by Git Credential Manager.
- If you use a Personal Access Token, paste it as the password.
- Never commit a token or API key.

### Easier alternative: GitHub Desktop

If the terminal feels risky:

1. Install GitHub Desktop and sign in.
2. **File → Add local repository**.
3. Choose this folder.
4. Write a commit message and click **Commit to main**.
5. Click **Publish repository**.
6. Uncheck **Keep this code private** if you want a public repo.

The result is the same as the command-line steps.


## 4. Publish a release

```powershell
git tag v1.0.0
git push origin v1.0.0
```

On GitHub:

1. Open **Releases**
2. Click **Draft a new release**
3. Choose tag `v1.0.0`
4. Title: `v1.0.0`
5. Attach the generated `dist/dsh-ide-1.0.0.zip`
6. Publish release

The ZIP is what normal users download and extract; they then run
`install.cmd` (or `install.ps1` with ExecutionPolicy Bypass) and install the
two plugin folders through DSH.

## 5. Optional: npm packages

This repository uses local package names (`@local/...`) and is intended for
GitHub/local installation. Publishing to npm requires renaming the packages to
a scope you own and publishing `dsh-ide-plugin` and `dsh-ide-lsp` separately.
Do that only after you are comfortable with npm publishing.
