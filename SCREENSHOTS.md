# Screenshot checklist

The repository currently ships **2 screenshots**:

- `docs/screenshots/01-overview.png`
- `docs/screenshots/02-ai.png`

That satisfies the marketplace requirement of 1–8 images. Add more if useful.

## Current shots

| File | What to show |
| --- | --- |
| `01-overview.png` | Whole IDE: file tree, editor, AI panel, terminal, status bar |
| `02-ai.png` | AI conversation, model picker, code blocks and diff |

## Optional additions

| File | What to show |
| --- | --- |
| `03-lsp.png` | Hover or go-to-definition plus Problems panel |
| `04-terminal-git.png` | Terminal tabs with ANSI colors and Git panel |
| `05-codemirror.png` | `CM 6` enabled with folding gutter and multiple cursors |

## Rules

- Use PNG, at least 1200px wide.
- Hide API keys, personal paths, private project names and email addresses.
- No fake UI or mocked features.
- Crop browser chrome unless the window frame helps.
- Keep the same theme and language across the set.

## Capture on Windows

1. Open the IDE at a useful size.
2. Press `Win + Shift + S`.
3. Capture the IDE area.
4. Paste into Paint or ShareX and save as PNG.
5. Put files in `docs/screenshots/`.

## screenshots.json

Already created at the repository root:

```json
[
  "docs/screenshots/01-overview.png",
  "docs/screenshots/02-ai.png"
]
```

Append optional paths when you add more images. The marketplace requires 1–8
relative paths, no leading `/`, no `..`.
