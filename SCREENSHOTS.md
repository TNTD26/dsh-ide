# Screenshot checklist

Screenshots are the single biggest factor in whether people try a plugin.
Add 4–6 images under `docs/screenshots/`, then list them in `screenshots.json`
for DSH marketplaces.

## Required shots

| File | What to show |
| --- | --- |
| `01-overview.png` | Whole IDE: file tree, editor, AI panel, terminal, status bar |
| `02-lsp.png` | Hover or go-to-definition plus Problems panel |
| `03-ai.png` | Model picker + API key dialog + diff preview |
| `04-terminal-git.png` | Terminal tabs with ANSI colors and Git panel |
| `05-codemirror.png` | `CM 6` enabled with folding gutter and multiple cursors |
| `06-mobile.png` | Optional: narrow layout, if it works well |

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

After the images exist, create this at the repository root:

```json
[
  "docs/screenshots/01-overview.png",
  "docs/screenshots/02-lsp.png",
  "docs/screenshots/03-ai.png",
  "docs/screenshots/04-terminal-git.png"
]
```

The marketplace requires 1–8 relative paths, no leading `/`, no `..`.
