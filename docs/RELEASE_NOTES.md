# v1.0.0 — First public release

A full IDE built into DeepSeek Harness.

## Highlights

- File tree, quick open, search/replace, multi-tab editor
- AI assistant with model picker and API-key setup
- Single-file diff preview and multi-file `dsh-patch`
- Git panel: init, status, stage, unstage, commit, diff
- Real PTY terminal with tabs and ANSI colors
- LSP for Python, TypeScript and JavaScript: definition, references, hover, completion, diagnostics
- Outline, Problems panel, checkpoint history
- Optional CodeMirror 6 Beta: multiple cursors, folding, semantic completion

## Install

1. Download `dsh-ide-1.0.0.zip`.
2. Extract it.
3. Run `install.cmd` to install dependencies (Pyright and typescript-language-server).
4. In DSH Desktop, install the extracted root folder as a local plugin.
5. Restart DSH.

## Known limitations

- Python diagnostics use the on-disk file; unsaved edits may lag.
- CodeMirror is Beta and not the default editor.
- Full-screen TUI apps are not supported; the terminal is ANSI line mode.
- Multi-file AI patches replace whole files, not individual hunks.

## Requirements

- DeepSeek Harness 0.2.1-rc.5
- Node.js 20+
- Windows (primary tested platform)
