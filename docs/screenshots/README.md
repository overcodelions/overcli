# Screenshots

The top-level `README.md` references these images. Drop PNG captures at these paths and they'll render on GitHub.

| Path | Shows |
|---|---|
| `welcome.png` | Welcome screen — Projects / Agents / Workspaces cards (dark) |
| `chat-light.png` | Chat with thinking block streaming + changes bar (light) |
| `chat-diff-light.png` | Chat + side-by-side file diff pane (light) |
| `chat-result-dark.png` | Chat with full markdown result rendered (dark) |
| `colosseum.png` | New Colosseum modal with two contenders (dark) |
| `rebound-popover.png` | Rebound config popover — reviewer + mode + rounds (light) |
| `rebound-collab-1.png` | Codex ↔ Claude collab transcript, mid-rounds (dark) |
| `rebound-collab-2.png` | Codex ↔ Claude collab transcript, later rounds (dark) |
| `settings-backends.png` | Settings → Backends pane with health badges (dark) |

All images are sized at 920px in the README. Source captures are typically 2× that on Retina displays.

## Capture recipe

On macOS, the cleanest captures come from `Cmd+Shift+4` → `Space` → click the Overcli window. Hold `Option` while clicking to drop the drop-shadow.

```bash
# Quick save directly into this folder (macOS):
screencapture -o -W ~/git-services/overcli/docs/screenshots/<name>.png
```

`-W` lets you click the window to select it; `-o` omits the window shadow so the PNG is a clean rectangle.

## Before capturing

- Pick a theme intentionally (the README mixes light and dark on purpose).
- Use `~1440 × 960` logical (Retina captures double to `2880 × 1920`).
- Seed a workspace with realistic-looking projects and a short conversation — no real customer data, internal repo names, or PII in file paths.
- Expand the active project in the sidebar; collapse the rest.
- For rebound/collab shots, run a real prompt long enough for a few rounds to land.

## Adding more

Drop new PNGs here and add a row to the table above + a `<p align="center">…</p>` block in the top-level README. Use `kebab-case.png`.
