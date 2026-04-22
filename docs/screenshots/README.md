# Screenshots

The top-level `README.md` references three images in this directory. Drop PNG captures at these paths and they'll render:

| Path | Shows | Suggested size |
|---|---|---|
| `chat.png` | The main chat view — sidebar + one backend streaming a turn with tool cards and diffs | 1840 × 1200 (2× @ 920) |
| `colosseum.png` | Colosseum mode — the same prompt running against every backend in parallel | 1840 × 1200 |
| `local.png` | The Local pane — Ollama catalog, live server logs, GPU readout | 1840 × 1200 |

## Capture recipe

On macOS, the cleanest captures come from `Cmd+Shift+4` → `Space` → click the Overcli window. Hold `Option` while clicking to drop the drop-shadow.

```bash
# Quick save directly into this folder (macOS):
screencapture -o -W ~/git-services/overcli/docs/screenshots/chat.png
screencapture -o -W ~/git-services/overcli/docs/screenshots/colosseum.png
screencapture -o -W ~/git-services/overcli/docs/screenshots/local.png
```

`-W` lets you click the window to select it; `-o` omits the window shadow so the PNG is a clean rectangle.

## Before capturing

For consistent marketing images:

- **Theme**: dark mode (`⌘,` → Settings → Theme → Dark).
- **Window size**: ~1440 × 960 logical (Retina captures double to 2880 × 1920, which crops well to the suggested 1840 × 1200).
- **Sample data**: seed a workspace with a couple of projects and a short realistic conversation — avoid anything with real customer data, internal repo names, or PII in file paths.
- **Sidebar**: expand the active project so nested conversations show; collapse the rest.
- **Usage widget** (for `local.png` especially): let the backend run a real small prompt first so the GPU readout populates.

## Also welcome

If you capture more views (permission card, approval card, rebound review, worktree diff, extensions browser, etc.), drop them here and reference them in the README — the more the project looks real on GitHub, the better. Name them `kebab-case.png` and add a row to the main README's Screenshots section.
