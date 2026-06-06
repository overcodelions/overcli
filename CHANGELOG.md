# Changelog

All notable changes to Overcli are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-06

### Added
- GitHub Copilot CLI as a fifth backend. Streams the JSONL event protocol (`copilot -p PROMPT --output-format=json --stream=on`), renders tool calls (view / edit / create / bash / glob / grep) as overcli's canonical tool cards, and replays history from `~/.copilot/session-state/<id>/events.jsonl`. Session continuity via `--resume`.
- Copilot health probe (binary auto-discovery, `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` detection, `~/.config/github-copilot` fallback).
- Copilot in Settings → Backends (enable/disable, CLI path override) and Settings → Models (default model picker).
- Rebound review mode supported with Copilot as primary — `same`-backend presets auto-route to Claude / Codex / Gemini and surface a "Routed via X" chip in the popover so the redirect is visible.

### Fixed
- Flow watch "detect" ticks no longer run on Haiku — any Haiku-named model is filtered out of the detect ladder, so the cheapest rung is Sonnet for Claude (Codex `mini` / Gemini `flash` unaffected). Haiku proved unreliable at the mechanical detect job.

### Known limitations
- **Copilot as a reviewer backend is not supported.** Copilot's CLI takes prompts in argv, but the reviewer plumbing feeds prompts via stdin. Copilot is hidden from the reviewer picker.
- **Collab-mode rebound is disabled when Copilot is the primary.** Copilot exits after each turn, so the runner can't push reviewer pingbacks into it. Greyed out in the popover with an explanation. Tracked in [#19](https://github.com/overcodelions/overcli/issues/19).
- **Permission modes default / acceptEdits / bypassPermissions behave identically for Copilot.** Copilot exposes no MCP-style approval hook for overcli to broker, so non-Plan modes all map to `--allow-all-tools`. Plan mode narrows to read-only tools (`view`, `glob`, `grep`).

## [0.1.0] - 2026-05-09

Initial public release.

### Added
- Multi-backend chat for Claude, Codex, Gemini, and Ollama with a unified streaming UI.
- Workspaces (projects-of-projects) so a single conversation spans multiple repos.
- Silent background agents (doc-writer, PR-reviewer).
- Rebound reviews — fire a second agent, optionally on a different backend, after each turn; collaboration mode loops until the reviewer is quiet.
- Tool cards for file edits (inline diffs), bash, reads, writes, todos.
- Claude permission prompts and Codex approval cards rendered as proper UI.
- History loaded from `~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp`.
- Built-in file editor with syntax highlighting and HTML/Markdown previews.
- Extensions browser unifying slash commands, sub-agents, skills, plugins, and MCP servers across backends.
- Agent worktrees: create, update, rebase, merge, push, or remove from inside the conversation.
- Live changes bar above the composer with `+/−` rollup for the current turn.
- Local model dashboard for Ollama (catalog, pull/delete, server logs, GPU readout).
- Usage dashboard with rolling 5h / 24h / 7d stats.
- Smart downgrades near rate or cost caps (off by default).
- Per-backend health badges.
- Colosseum: same prompt against every backend in parallel git worktrees.
- Cross-platform packaging via electron-builder (macOS dmg/zip, Windows NSIS, Linux AppImage/deb).

[Unreleased]: https://github.com/overcodelions/overcli/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/overcodelions/overcli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overcli/releases/tag/v0.1.0
