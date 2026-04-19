# Overcli

Overcli is a cross-platform desktop app that puts a real GUI in front of the
command-line coding agents you already use — `claude`, `codex`, and `gemini`.
Instead of juggling three terminals with three different output formats, you
get one window with conversations, projects, diffs, tool cards, file editing,
git worktrees, and usage stats all in the same place.

Under the hood it's an Electron + React + TypeScript app. The main process
spawns and manages each CLI as a subprocess, parses its stream events, and
the renderer turns them into rich UI: markdown answers, syntax-highlighted
code, side-by-side diff views, permission prompts, and approval cards.

## A father–son project

This is a collaboration between **Lionel Farr** and his son **Owen Farr**.
It started as a way to spend time building something real together — Owen
learning how a production app is actually put together (IPC, state, streaming,
diffs, packaging) and Lionel getting to teach by doing instead of explaining
in the abstract. Every feature below is an excuse for a conversation about
why it's designed the way it is.

If you're reading this and wondering why some decisions look the way they do:
it's because they were chosen to be *explainable*, not just clever.

## What it does

- **Multi-backend chat** — claude, codex (proto), and gemini, each with their
  own stream parser, all rendered through the same UI
- **Tool cards** — file edits show as diffs, bash shows as a terminal block,
  reads/writes/todos each get their own card
- **Permission + approval flow** — claude permission prompts and codex
  approval cards (exec + apply_patch) are first-class UI, not modal
  interruptions
- **History** — loads prior transcripts from `~/.claude/projects`,
  `~/.codex/sessions`, and `~/.gemini/tmp`
- **Projects + conversations sidebar** with search and quick switcher
- **File editor pane** with syntax highlighting, line-range highlighting,
  and HTML / Markdown preview tabs for previewable files
- **Cmd+P file finder**, Cmd+\ to toggle the sidebar, Cmd+, for settings
- **Agent worktrees** — create / update / rebase / merge / push / remove git
  worktrees from inside a conversation
- **Colosseum** — run the same prompt against multiple backends in parallel
  and compare the diffs
- **Usage dashboard** — rolling 5h / 24h / 7d stats, broken down by backend,
  model, and project
- **Health badges** — per-backend ready / unauthenticated / missing / error
- **Settings sheet** for CLI paths, default models, auto-downgrade, etc.
- **Slash commands, MCP servers, and agents sheets**

## Dev

```bash
npm install
npm run dev
```

`dev` runs three watchers concurrently:
- `vite` — renderer dev server at http://localhost:5173
- `tsc` — main-process incremental compile to `dist/main/`
- `electron` — waits for both, then launches Electron pointed at the Vite
  dev URL via `VITE_DEV_SERVER_URL`

## Build + run packaged

Unpackaged smoke test (just `electron .` against the compiled output):

```bash
npm run build
npm start
```

## Distributable (standalone app)

```bash
npm run dist           # all platforms the current host supports
npm run dist:mac       # macOS .dmg + .zip (arm64 + x64)
npm run dist:win       # Windows NSIS installer
npm run dist:linux     # AppImage + .deb
```

Output lands in `release/`:

- `release/mac-arm64/Overcli.app` — double-clickable .app
- `release/Overcli-<version>.dmg` — drag-to-Applications installer
- `release/Overcli-<version>-mac.zip` — zipped .app for auto-updater flows

The app is built **unsigned** by default. macOS Gatekeeper will show the
"unidentified developer" dialog on first open — right-click → Open bypasses
it. For signed + notarized builds, add your Apple Developer ID to `build/`
and set the `CSC_LINK` + `CSC_KEY_PASSWORD` env vars. See electron-builder's
code-signing docs.

### Icon

`build/icon.icns` and `build/icon.png` are shared with the earlier Swift
build of Overcli so the two apps have the same identity.

## Layout

```
src/
  shared/        — types shared by main + renderer (IPC wire contract)
  main/          — Electron main process
    index.ts       — app lifecycle, IPC handlers, window
    runner.ts      — subprocess manager per conversation
    parsers/       — claude / codex / gemini stream-event parsers
    history.ts     — load prior transcripts from disk
    store.ts       — on-disk persistence (single overcli.json)
    git.ts         — worktree ops for agent conversations
    stats.ts       — usage aggregation
    health.ts      — backend ready/unauth/missing probes
  preload/       — contextBridge exposing `window.overcli`
  renderer/      — React app
    App.tsx, components/, store.ts (Zustand), theme.ts, hooks.ts
```

## Not included (by choice)

- Time Travel (conversation forking at a specific turn)
- Replay bundles

Anything else that's missing and you'd expect to be here is a bug — please
flag it.
