# Publish this repository to GitHub

The repository is already public at
https://github.com/TNTD26/dsh-ide.

This document describes the release steps for the single-package layout. The
repository is already public and the current release is `v1.0.0`.

## 1. Push the commit

Open PowerShell in this folder:

```powershell
cd "C:\path\to\dsh-ide-release"
git status
git push -u origin main
```

If this is the first push from this computer, Git opens a browser login. Sign in
with the GitHub account that owns `TNTD26/dsh-ide`.

Do not use `--force`: the local commit is based on the repository's existing
`Initial release` commit, so a normal push is enough.

## 2. Push the tag

```powershell
git push origin v1.0.0
```

## 3. Create the GitHub Release

1. Open https://github.com/TNTD26/dsh-ide/releases
2. Click **Draft a new release**
3. Choose tag `v1.0.0`
4. Title: `v1.0.0`
5. Attach `dist/dsh-ide-1.0.0.zip`
6. Paste [RELEASE_NOTES.md](RELEASE_NOTES.md)
7. Publish

The ZIP is what normal users download and extract. They then run `install.cmd`
and install the extracted **root folder** as one local plugin.

## 4. About, topics, screenshots

In the repository **About** panel:

Description:

```text
A full IDE inside DeepSeek Harness — file tree, tabs, AI chat, Git, terminal, Python/TypeScript LSP and CodeMirror 6.
```

Topics:

```text
deepseek-harness
dsh-plugin
dsh
ide
code-editor
codemirror
lsp
ai-coding
typescript
python
```

Add screenshots under `docs/screenshots/` and create `screenshots.json`.
See [SCREENSHOTS.md](SCREENSHOTS.md) or [中文截图清单](截图清单.md).

## 5. Marketplaces

Before submitting:

- Make sure the GitHub Release exists.
- Add the `dsh-plugin` topic.
- Add screenshots.
- Wait until the repository is at least **1 day old** for awesome-dsh-plugin.
- Install the release into a clean DSH profile once, to prove the one-package
  install path works.

Then:

- [DSH-Store submission](https://github.com/AI-Scarlett/DSH-Store/issues/new?template=plugin-submission.yml)
- [awesome-dsh-plugin contributing](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

The plugin package is at the repository root, so a monorepo plugin path is not
needed.

## 6. Optional: npm

`package.json` is already named `dsh-ide` and points at this repository.

```powershell
npm publish --access public
```

Only do this after the GitHub install and release are verified. Never publish a
`.env` file or an API key.
