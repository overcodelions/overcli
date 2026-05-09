# Changelog

All notable changes to Overcli are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/lionelfarr/overcli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lionelfarr/overcli/releases/tag/v0.1.0
