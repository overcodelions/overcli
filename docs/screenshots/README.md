# Screenshots

The top-level `README.md` shows these images. They're generated, not hand-captured, so they can be refreshed whenever the UI changes.

| File | Shows |
|---|---|
| `chat.png` | Hero: a finished turn with its markdown report, steps summary and changes bar (dark) |
| `tools-light.png` | The same turn from the top: prompt, thinking, file writes and an inline edit diff (light) |
| `diff.png` | Working-tree diff sheet over the conversation (dark) |
| `rebound.png` | Rebound preset menu (dark) |
| `flow.png` | Flow builder on the *Solve a ticket* template, beside its YAML (dark) |
| `workers.png` | Workers view, with templates and teams (dark) |
| `usage.png` | Usage dashboard (dark) |
| `extensions.png` | Extensions browser, skill catalog (dark) |
| `backends.png` | Settings → Backends with health badges (dark) |

## Regenerating

```bash
npm run build
npm i --no-save playwright-core
pip3 install pillow   # once, for framing
node scripts/readme-screenshots/capture.mjs
```

[`scripts/readme-screenshots/`](../../scripts/readme-screenshots/) does the whole job:

- **`seed.mjs`** builds a throwaway HOME in your temp dir: fictional `acme-*` git repos with real history and uncommitted edits, plus Claude transcripts the app replays as conversation history.
- **`capture.mjs`** runs the built app against that HOME and a separate `readme-shots` profile, so none of your own projects, paths or conversations can appear in an image. Backends are faked as ready with `OVERCLI_FAKE_HEALTH`, and no CLI is ever called. It clicks through each scene at 1600×1000 and 2× scale, then deletes the profile.
- **`frame.py`** adds macOS window chrome (traffic lights, rounded corners, soft shadow) on a transparent background, so the images work in GitHub's light and dark themes.

## Adding a shot

Add a scene to `capture.mjs`, add any data it needs to `seed.mjs`, then add a row above and an image to the README. Keep names `kebab-case.png`, and keep everything fictional: acme names only, no real people, companies or paths.
