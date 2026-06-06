# Changelog

All notable changes to Overcli are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-06-06

The biggest release since the project went public: a full multi-agent **Flows** system, a fifth backend (**GitHub Copilot**), in-app **auto-updates**, a curated **MCP catalog**, and a lot of polish.

### Added

**Flows — multi-agent pipelines**
- Visual flow builder + YAML flow library + run UI: chain steps across models, hand off artifacts (`plan.md` → `diff` → `review.md`), add retry edges, and tune each step's role, tools, and checkpoints ([#28](https://github.com/overcodelions/overcli/pull/28)).
- Per-step diffs, launch attachments, and richer step cards ([#31](https://github.com/overcodelions/overcli/pull/31)); live Workflow progress with gated reviewer steps ([#58](https://github.com/overcodelions/overcli/pull/58)).
- Post-completion **watch** mode — keeps an agent on a finished run to answer follow-ups, with readable per-tick summaries ([#68](https://github.com/overcodelions/overcli/pull/68), [#71](https://github.com/overcodelions/overcli/pull/71)).
- Flow starring and a smoother Continue flow; finished runs stay in the sidebar's Active set ([#42](https://github.com/overcodelions/overcli/pull/42), [#53](https://github.com/overcodelions/overcli/pull/53)).
- Workspace worktrees for flows and human-readable flow branch names ([#41](https://github.com/overcodelions/overcli/pull/41), [#73](https://github.com/overcodelions/overcli/pull/73)).

**Backends & models**
- GitHub Copilot CLI as a **fifth backend** — streams the JSONL event protocol, renders tool calls (view / edit / create / bash / glob / grep) as canonical tool cards, replays history from `~/.copilot/session-state/<id>/events.jsonl`, and resumes via `--resume`. Includes a health probe (binary auto-discovery, `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` detection) and Settings → Backends/Models entries ([#20](https://github.com/overcodelions/overcli/pull/20)).
- Copilot as a rebound-review primary — `same`-backend presets auto-route to Claude / Codex / Gemini with a "Routed via X" chip in the popover.
- Claude **Opus 4.8** support ([#44](https://github.com/overcodelions/overcli/pull/44)) and an experimental Claude Agent SDK transport ([#10](https://github.com/overcodelions/overcli/pull/10)).
- More reliable Ollama tool calling (incl. Gemma 12B+) and rebound reviewers that can `read_file` / `list_dir` / `grep` ([#18](https://github.com/overcodelions/overcli/pull/18), [#22](https://github.com/overcodelions/overcli/pull/22), [#27](https://github.com/overcodelions/overcli/pull/27)).

**Updates & extensions**
- In-app **auto-update** with stable + nightly channels ([#64](https://github.com/overcodelions/overcli/pull/64)); update the Codex CLI via a hidden npm install with a terminal fallback ([#60](https://github.com/overcodelions/overcli/pull/60)).
- Curated **MCP catalog** with one-click install per CLI, plus bulk-add and copy-to-all in the Extensions browser ([#57](https://github.com/overcodelions/overcli/pull/57), [#59](https://github.com/overcodelions/overcli/pull/59)).

**Workflow & UI**
- Sub-agents (Task/Agent) surfaced with an inline card + drawer ([#25](https://github.com/overcodelions/overcli/pull/25)).
- Side-by-side explorer for folders and Explore ([#15](https://github.com/overcodelions/overcli/pull/15)).
- All-time usage stats alongside the rolling 5h / 24h / 7d view ([#73](https://github.com/overcodelions/overcli/pull/73)).
- Structured diagnostics session logger with file output ([#37](https://github.com/overcodelions/overcli/pull/37)).
- Plan mode: `ExitPlanMode` gated through the permission broker so approval works ([#62](https://github.com/overcodelions/overcli/pull/62)); broker resilience + MCP debug logging ([#61](https://github.com/overcodelions/overcli/pull/61)).
- Running indicator pinned above the composer ([#63](https://github.com/overcodelions/overcli/pull/63)).

### Fixed
- Flow watch "detect" ticks no longer run on Haiku — any Haiku-named model is filtered out of the detect ladder, so the cheapest rung is Sonnet for Claude (Codex `mini` / Gemini `flash` unaffected). Haiku proved unreliable at the mechanical detect job ([#75](https://github.com/overcodelions/overcli/pull/75)).
- Flows reliability: watcher answers questions dependably and loads deferred MCP tools, no duplicate step execution after Continue, finalize conversation drains before advancing, light-mode card colors, and Ollama-only preflight allowlist ([#43](https://github.com/overcodelions/overcli/pull/43), [#45](https://github.com/overcodelions/overcli/pull/45), [#56](https://github.com/overcodelions/overcli/pull/56), [#69](https://github.com/overcodelions/overcli/pull/69), [#70](https://github.com/overcodelions/overcli/pull/70), [#72](https://github.com/overcodelions/overcli/pull/72)).
- Missing/unresolvable backend CLIs now surface a clear error instead of hanging the turn or crashing the main process.
- Removing an agent no longer silently force-deletes a branch with unmerged commits — it warns and points to reflog recovery.
- Ollama bubble theming (amber, not Claude purple) and a clearer empty-`AskUserQuestion` message ([#16](https://github.com/overcodelions/overcli/pull/16), [#26](https://github.com/overcodelions/overcli/pull/26)).

### Changed
- Markdown re-parses throttled to ~12 fps during streaming for smoother output ([#11](https://github.com/overcodelions/overcli/pull/11)).
- Dropped the full-viewport backdrop blur on modal overlays — snappier modals ([#39](https://github.com/overcodelions/overcli/pull/39)).
- Dead-code cleanup and de-duplication across the codebase ([#54](https://github.com/overcodelions/overcli/pull/54)).
- macOS builds target arm64 (Apple Silicon); download docs corrected to match.

### Security
- Disabled the `runAsNode` Electron fuse (defense in depth).
- Overrode `qs` to patch a ReDoS/DoS ([GHSA-q8mj-m7cp-5q26](https://github.com/overcodelions/overcli/pull/38)) and bumped DOMPurify ([#35](https://github.com/overcodelions/overcli/pull/35)).

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
