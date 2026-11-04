# Publish this repository to GitHub

This is the maintainer guide. The repository already exists at
https://github.com/TNTD26/dsh-ide.

## 1. What changed

This is now a **single-package plugin**:

```text
package.json          # dsh.bundle + dsh.client + LSP dependencies
index.js              # Host: IDE + LSP composition
client.js             # Web client
assets/codemirror.js  # bundled editor
cordis.patch.yml      # one bundle patch
dsh-ide-editor/       # CodeMirror build source (optional for users)
```

The old `dsh-ide-plugin/` and `dsh-ide-lsp/` folders are no longer needed.
Users install one folder only.

## 2. Clone the existing repository

```powershell
cd C:\Users\王博彦\Documents\deepseek-harness\default-workspace
git clone https://github.com/TNTD26/dsh-ide.git dsh-ide-github
```

## 3. Replace its contents with this folder

Copy everything from this folder into `dsh-ide-github`, **except** `.git`,
`node_modules`, `.npm-cache`, `dist`.

Then delete the old folders from the clone:

```powershell
cd dsh-ide-github
Remove-Item -Recurse -Force dsh-ide-plugin, dsh-ide-lsp
```

## 4. Commit and push

```powershell
git status
```

Check that no `node_modules/`, `.npm-cache/`, `.env`, or `*.pem` files are
listed. Then:

```powershell
git config user.name "TNTD26"
git config user.email "wby070427@gmail.com"
git add -A
git commit -m "feat: ship DSH IDE as a single installable package"
git push origin main
```

If Git asks for credentials, use Git Credential Manager's browser login or a
Personal Access Token. Never commit a token.

## 5. Publish the release

```powershell
git tag v1.0.0
git push origin v1.0.0
```

On GitHub:

1. Open **Releases → Draft a new release**
2. Tag: `v1.0.0`
3. Title: `v1.0.0`
4. Attach `dist/dsh-ide-1.0.0.zip`
5. Paste [RELEASE_NOTES.md](RELEASE_NOTES.md)
6. Publish

## 6. Marketplaces

Before submitting:

- Add the `dsh-plugin` topic in **About**.
- Add a short repository description.
- Upload 1–4 screenshots and create `screenshots.json` (see
  [SCREENSHOTS.md](SCREENSHOTS.md)).
- Wait until the repository is at least **1 day old** for awesome-dsh-plugin.
- Make sure the GitHub Release exists; marketplaces prefer a pinned artifact.

Then:

- [DSH-Store submission](https://github.com/AI-Scarlett/DSH-Store/issues/new?template=plugin-submission.yml)
- [awesome-dsh-plugin contributing](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

For a monorepo the marketplace may ask for a plugin path; this package is at
the repository root, so no path is needed.

## 7. Optional: npm

The package name is `dsh-ide`. Publishing to npm is optional. If you do:

```powershell
npm publish --access public
```

The `repository` field already points to this GitHub repo. Never publish an
API key or a `.env` file.
