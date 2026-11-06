# Contributing

Thanks for trying DSH IDE.

## Setup

Requirements:

- Node.js 20+
- DeepSeek Harness 0.2.1-rc.5 for host integration testing
- Windows is the primary tested platform

```powershell
npm install --ignore-scripts
npm --prefix dsh-ide-editor install --ignore-scripts
npm --prefix dsh-ide-editor test
```

## Pull requests

- Keep the plugin installable from the repository root
  (`package.json` must keep both `dsh.bundle.patch` and `dsh.client`).
- Do not edit generated build output by hand. Rebuild it with:

```powershell
npm --prefix dsh-ide-editor run build
```

- Keep changes focused. Do not reformat unrelated files.
- Add or update tests when changing the editor bridge.
- Do not commit API keys, `.env` files, credentials, or private screenshots.

## Security-sensitive changes

The plugin intentionally requests broad permissions: workspace writes, a PTY
terminal, LSP subprocesses, and DSH credentials for AI API keys. Changes in
those areas need a clear explanation in the PR and should be reviewed carefully.

## Reporting bugs

Open an issue with:

- DSH version
- Windows version
- reproduction steps
- expected and actual behavior
- relevant console or terminal output

Never paste real API keys, tokens, private repository paths, or customer code.
