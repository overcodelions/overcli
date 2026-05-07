<p align="center">
  <img src="build/icon.png" alt="Overcli" width="128" />
</p>

<h1 align="center">Overcli</h1>

<p align="center">
  <sub><code>over·CLI</code> — a GUI that sits <em>over</em> your CLIs. Yes, that's the name.</sub>
</p>

<p align="center">
  <strong>Four coding agents. One honest window.</strong><br />
  A cross-platform desktop app that wraps <code>claude</code>, <code>codex</code>, <code>gemini</code>, and <code>ollama</code> in a single GUI —
  conversations, diffs, git worktrees, and usage stats in the same place.
</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-beta-orange" />
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-informational" />
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" />
  <img alt="electron" src="https://img.shields.io/badge/electron-41-47848F" />
  <img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-green" />
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#features">Features</a> ·
  <a href="#development">Dev</a> ·
  <a href="#contributing">Contributing</a> ·
  <a href="#a-fatherson-project">About</a>
</p>

---

> Overcli is a fan-built desktop client. It is **not** affiliated with Anthropic, OpenAI, or Google. It runs on top of the official `claude`, `codex`, and `gemini` CLIs and the open-source `ollama` runtime — whatever auth those already have is the auth Overcli uses. No API keys required.

## Screenshots

<p align="center">
  <em>Welcome — pick a project, an agent, or a workspace and you're in.</em><br />
  <img alt="Overcli welcome screen" src="docs/screenshots/welcome.png" width="920" />
</p>

<p align="center">
  <em>Chat (light) — thinking blocks stream live; the changes bar above the composer counts what the turn has touched.</em><br />
  <img alt="Overcli chat — thinking" src="docs/screenshots/chat-light.png" width="920" />
</p>

<p align="center">
  <em>Side-by-side diff — file edits open inline without leaving the conversation.</em><br />
  <img alt="Overcli chat with diff pane" src="docs/screenshots/chat-diff-light.png" width="920" />
</p>

<p align="center">
  <em>Same flow, dark theme — the agent's full report rendered with markdown, code, and lists.</em><br />
  <img alt="Overcli chat result — dark" src="docs/screenshots/chat-result-dark.png" width="920" />
</p>

<p align="center">
  <em>Colosseum — same prompt against every backend, in parallel git worktrees.</em><br />
  <img alt="Overcli colosseum dialog" src="docs/screenshots/colosseum.png" width="920" />
</p>

<p align="center">
  <em>Rebound — pick a reviewer, a mode (review or collab), and a round budget.</em><br />
  <img alt="Overcli rebound configuration" src="docs/screenshots/rebound-popover.png" width="920" />
</p>

<p align="center">
  <em>Collab mode — primary and reviewer ping-pong with their thinking on display.</em><br />
  <img alt="Overcli rebound collab transcript" src="docs/screenshots/rebound-collab-1.png" width="920" />
</p>

<p align="center">
  <em>...round after round, until the reviewer is satisfied or the budget runs out.</em><br />
  <img alt="Overcli rebound collab — later rounds" src="docs/screenshots/rebound-collab-2.png" width="920" />
</p>

<p align="center">
  <em>Settings — toggle backends, override CLI paths, see live health badges.</em><br />
  <img alt="Overcli settings — backends" src="docs/screenshots/settings-backends.png" width="920" />
</p>

## Features

| # | Feature | What it does |
|---|---|---|
| 01 | **Multi-backend chat** | Claude, Codex, Gemini, and Ollama — four stream parsers, one consistent UI. Markdown, syntax highlight, streaming tokens. Cloud or local, same window. |
| 02 | **No API keys required** | Sits on top of the CLIs you already use. Whatever auth `claude` / `codex` / `gemini` / `ollama` have is the auth you get. No new billing. No new secrets on disk. |
| 03 | **Workspaces** | Projects of projects. Group related repos and talk to them as one — the agent edits across repos, runs every test suite, shows one review. Polyrepo that feels like monorepo. |
| 04 | **Silent agents** | Long-running background agents: a *doc-writer* that keeps `/docs` in sync, a *PR-reviewer* that comments the moment a PR opens. No Slack pings, no dashboards. |
| 05 | **Rebound reviews** | After every turn, fire a second agent — on a different backend if you like — to review what just landed. Thinking blocks visible, round counter included. Collaboration mode loops until the reviewer is quiet. |
| 06 | **Tool cards** | File edits render as diffs. Bash lives in a terminal block. Reads, writes, todos each get their own card — so you can actually see what the agent did. |
| 07 | **Permission & approval** | Claude permission prompts and Codex approval cards (exec + apply_patch) are proper UI elements, not modal interruptions. |
| 08 | **History from disk** | Reads prior transcripts straight out of `~/.claude/projects`, `~/.codex/sessions`, and `~/.gemini/tmp`. Nothing re-invented. |
| 09 | **File editor** | Syntax highlighting, line-range highlighting, HTML & Markdown preview tabs. No context-switch to VS Code. |
| 10 | **Extensions browser** | Unified pane for slash commands, sub-agents, skills, plugins, MCP servers — across every backend. Copy an MCP server from one CLI to the others in a click. Rescan on demand. |
| 11 | **Keyboard first** | <kbd>⌘P</kbd> file finder, <kbd>⌘\</kbd> sidebar, <kbd>⌘,</kbd> settings, <kbd>⌘K</kbd> quick switcher. |
| 12 | **Agent worktrees** | Create, update, rebase, merge, push, or remove a git worktree from inside the conversation. Agents work in isolation; you merge when you like what you read. |
| 13 | **Changes bar** | Live `+/−` rollup above the composer counting everything touched this turn. Click to expand, click a file to jump to it, click commit. |
| 14 | **Local model dashboard** | A real UI for Ollama: catalog, filter by maker or country, pull & delete with one click, live server logs, GPU readout. |
| 15 | **Usage dashboard** | Rolling 5h / 24h / 7d stats, broken down by backend, model, and project. |
| 16 | **Smart downgrades** | Near a rate or cost cap, Overcli can step down automatically — `opus` → `sonnet`, cloud → local Ollama — so the next turn still ships. Off by default. |
| 17 | **Health badges** | Per-backend status pills: *ready*, *unauthenticated*, *missing*, *error*. Know what's broken before you try to use it. |
| 18 | **Colosseum** | Fire one prompt at every backend in parallel. Compare the diffs side by side. Keep the winner, discard the rest. |

## Download

Builds are produced by the release workflow and land on the [Releases page](https://github.com/lionelfarr/overcli/releases).

| Platform | Artifact |
|---|---|
| **macOS** · arm64 + x64 | `.dmg` · `.zip` |
| **Windows** · x64 + arm64 | NSIS installer |
| **Linux** · x64 + arm64 | `.AppImage` · `.deb` |

> ⚠️ Builds are **unsigned**. macOS shows *"unidentified developer"* on first open — right-click the app → **Open**. Do it once, it sticks. Prefer to build it yourself? See [Build & package](#build--package) below.

## Requirements

Overcli is a thin GUI over CLIs you install separately. Install whichever ones you want to use:

| Backend | CLI | Install |
|---|---|---|
| Claude | `claude` | `npm i -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm i -g @openai/codex` |
| Gemini | `gemini` | `npm i -g @google/gemini-cli` |
| Ollama | `ollama` | [ollama.com](https://ollama.com) |

You don't need all four — Overcli's health badges will show you which ones it can reach, and the app works fine with just one installed.

## Development

```bash
git clone https://github.com/lionelfarr/overcli
cd overcli
npm install
npm run dev
```

`dev` runs three watchers concurrently:

- **vite** — renderer dev server at http://localhost:5173
- **tsc** — main-process incremental compile into `dist/main/`
- **electron** — waits for both, then launches Electron pointed at the Vite dev URL

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Full development loop (vite + tsc + electron). |
| `npm run build` | Compile main process + build renderer bundle. |
| `npm start` | Build and launch the packaged output unpackaged. |
| `npm test` | Run the Vitest suite. |
| `npm run test:watch` | Vitest in watch mode. |
| `npm run test:coverage` | Vitest with v8 coverage. |

## Build & package

Unpackaged smoke test (just `electron .` against the compiled output):

```bash
npm run build
npm start
```

Distributable installers:

```bash
npm run dist        # every target the host supports
npm run dist:mac    # macOS .dmg + .zip (arm64 + x64)
npm run dist:win    # Windows NSIS (x64 + arm64)
npm run dist:linux  # AppImage + .deb (x64 + arm64)
```

Output lands in `release/`:

- `release/mac-arm64/Overcli.app` — double-clickable .app
- `release/Overcli-<version>.dmg` — drag-to-Applications installer
- `release/Overcli-<version>-mac.zip` — zipped .app for auto-updater flows

### Signing (optional)

Builds are unsigned by default. To produce a signed + notarized macOS build, set your Apple Developer ID credentials:

```bash
export CSC_LINK=/path/to/developer-id.p12
export CSC_KEY_PASSWORD=...
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
npm run dist:mac
```

See [electron-builder's code-signing docs](https://www.electron.build/code-signing) for details.

## Architecture

```
src/
  shared/        types shared by main + renderer (the IPC wire contract)
  main/          Electron main process
    index.ts             app lifecycle, IPC handlers, window
    runner.ts            subprocess manager per conversation
    codex-app-server.ts  Codex app-server transport (replaces stdio for codex)
    backends/            per-backend adapters (claude / codex / gemini / ollama)
    parsers/             stream-event parsers, one per backend
    history.ts           load prior transcripts from disk
    store.ts             on-disk persistence (single overcli.json)
    git.ts               worktree ops for agent conversations
    stats.ts             usage aggregation
    health.ts            backend ready / unauth / missing probes
    workspace.ts         workspace model (projects-of-projects)
    reviewer.ts          rebound-review orchestration
    ollama.ts            Ollama model catalog + server control
    mcpConfig.ts         cross-CLI MCP server config sync
  preload/       contextBridge exposing `window.overcli`
  renderer/      React app
    App.tsx, components/, store.ts (Zustand), theme.ts, hooks.ts
```

**Tech** — Electron 41, React 18, TypeScript, Vite, Tailwind, Zustand.

### How a turn flows

1. User types in the composer; the renderer IPCs the message to main.
2. The matching backend adapter in `backends/` opens (or reuses) a session — a CLI subprocess for claude/gemini/ollama, the app-server channel for codex.
3. Stream events hit `parsers/<backend>.ts`, which normalise them into a backend-agnostic `TurnEvent` stream.
4. Those events flow back to the renderer and become tool cards, message bubbles, approval cards, and diffs in `ChatView.tsx`.
5. On completion, `stats.ts` records the turn; `reviewer.ts` optionally kicks off a rebound review on a second backend.

## Contributing

Issues, bug reports, and PRs welcome — please open an issue first for anything non-trivial so we can talk about the shape of it. The app's built to be *explainable*, so expect review comments asking "why this, not that."

- [Open an issue](https://github.com/lionelfarr/overcli/issues/new)
- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup and PR expectations
- See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) before participating
- Found a security bug? Don't file a public issue — see [`SECURITY.md`](SECURITY.md)

## Not included (by choice)

- **Time Travel** — forking a conversation at a specific turn
- **Replay bundles** — exporting a conversation as a self-contained replay

Anything else missing that you'd expect? It's a bug — please file it.

## A father–son project

Overcli is a collaboration between **[Lionel Farr](https://github.com/lionelfarr)** and his son **[Owen Farr](https://github.com/owenlfarr)**. It started as a way to spend time building something real together — Owen learning how a production app actually comes together (IPC, state, streaming, diffs, packaging), Lionel getting to teach by doing instead of explaining in the abstract. Every feature above is an excuse for a conversation about *why* it's designed the way it is.

> If you're reading the code and wondering why some decisions look the way they do — it's because they were chosen to be *explainable*, not just clever.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See the [`NOTICE`](NOTICE) file for third-party attributions.

Copyright © 2026 Lionel Farr and Owen Farr.
