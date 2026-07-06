# Changelog

All notable changes to Overcli are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-07-06

### Added
- **"Run as agent" from the welcome composer.** The run pill now offers **Run as agent** next to **Work locally**: it mints an isolated git worktree on a fresh branch (single project) or one per member repo through a coordinator (workspace), then fires the prompt into the resulting agent — reusing the sidebar "+ agent" wiring ([#102](https://github.com/overcodelions/overcli/pull/102)).
- **Copy button on the run prompt card** to quickly grab the prompt that kicked off a flow run ([#102](https://github.com/overcodelions/overcli/pull/102)).

### Fixed
- **The flow ChangesBar counts changes against the run's fork point.** The chat ChangesBar used a HEAD-relative probe, so a flow worktree's files dropped out of the bar the moment a step committed them — even though the review sheet still counted them (it diffs against the run's captured fork point). Committed + uncommitted divergence vs base is now rolled into one pass, so the bar and the review diff agree. This covers both single-project ([#102](https://github.com/overcodelions/overcli/pull/102)) and workspace ([#103](https://github.com/overcodelions/overcli/pull/103)) runs — a workspace run with 1 committed + 1 uncommitted file per member showed 2 instead of 4.
- **Aborting a batch settles paused items.** A run parked at a `pause_before` checkpoint is non-terminal, so aborting a batch that had one left the ledger stuck on "Abort batch" with no "Clear". Paused runs are now cancelled alongside killing running ones ([#102](https://github.com/overcodelions/overcli/pull/102)).
- **Deleting a flow run no longer blocks the UI** ([#102](https://github.com/overcodelions/overcli/pull/102)).

### Security
- **CI supply-chain hardening.** Third-party GitHub Actions are pinned to commit SHAs, workflow `GITHUB_TOKEN` permissions are scoped to least privilege per job, and `scorecard-action` is pinned to v2.4.3.

## [0.6.0] - 2026-07-05

### Added
- **Override a stuck reviewer gate.** A failure pause (e.g. a gating reviewer that didn't approve) now offers an **Override & continue** action that rolls the run forward past the failed step — handing that step's already-recorded output to the next step — instead of only ever re-running it. The primary button is relabelled **Re-run step** to match what it does ([#101](https://github.com/overcodelions/overcli/pull/101)).

### Fixed
- **Labelled reviewer verdicts are recognized as approvals.** A review that says `Verdict: APPROVED` (or `Decision:` / `Result:` / `Status:` / `Outcome:`) now passes the gate. Previously only a line *beginning* with `APPROVED` counted, so a labelled approval failed the gate, paused the flow, and every Continue silently re-ran the same reviewer in a loop. `Verdict: NOT APPROVED` still correctly fails ([#101](https://github.com/overcodelions/overcli/pull/101)).
- **Pause banner no longer sticks on "Continuing…".** When a resume landed on a new paused state (e.g. Override rolling onto a pre-step pause) or was rejected, the optimistic spinner never cleared even though the run had advanced. It now clears on any pause-identity change or a not-ok resume ([#101](https://github.com/overcodelions/overcli/pull/101)).
- **Undo/redo works in the file editor.** The Edit menu is spelled out with `registerAccelerator: false` on Undo/Redo so `Cmd/Ctrl+Z` falls through to CodeMirror's own history instead of the native `execCommand` no-op that silently swallowed the keystroke ([#101](https://github.com/overcodelions/overcli/pull/101)).
- **Registered roots match across filesystem case.** `realpathSync.native` canonicalizes case on case-insensitive filesystems, so path-containment checks still recognize files under a root persisted with different casing (e.g. after an app-name case change) ([#101](https://github.com/overcodelions/overcli/pull/101)).
- **Runner races fixed:** a superseded Claude process no longer unlinks the live process's `--mcp-config` file, and an `AskUserQuestion` tool_use isn't killed until its `questions` have actually been parsed ([#99](https://github.com/overcodelions/overcli/pull/99)).
- **Shared-conversation step labels are correct.** When viewing a step that hasn't run yet but shares a model (and conversation) with earlier steps, the banner now names the most recently-run step whose transcript is actually shown, instead of the first step in pipeline order ([#99](https://github.com/overcodelions/overcli/pull/99), [#100](https://github.com/overcodelions/overcli/pull/100)).

## [0.5.0] - 2026-06-30

### Added
- **Claude Sonnet 5 (`claude-sonnet-5`)** added to the model catalog as the default `fast` Claude model — used for rebound reviewers and the cheap tier, and auto-selected as the worker/verify model in claude-only flow templates (ahead of Sonnet 4.6). The Welcome pane's model picker now reads from the shared catalog so newly added models can't silently go stale ([#98](https://github.com/overcodelions/overcli/pull/98)).
- **Untracked files now appear in worktree reviews.** The review and diff sheets show a synthetic `new file` block for each untracked path, mirroring what a merge would bring across, so files an agent wrote but never staged are no longer silently dropped — and the "N files ±X" badge counts them too ([#98](https://github.com/overcodelions/overcli/pull/98)).

### Changed
- **Deleting a flow run now removes its git worktree** instead of leaving it orphaned on disk ([#97](https://github.com/overcodelions/overcli/pull/97)).
- **Snappier file opens.** Main-process git status probes went async so they no longer block the event loop, realpath'd project roots are memoized, and absolute path hints skip the recursive same-name walk — cutting the antivirus-taxed syscalls on every file IPC ([#98](https://github.com/overcodelions/overcli/pull/98)).
- **Sidebar search matches flow runs** by title or flow name, surfacing the owning project/workspace even when its name and conversations don't match ([#98](https://github.com/overcodelions/overcli/pull/98)).

### Fixed
- **Switching flow runs closes the open side-file editor** so it re-roots at the new run's worktree instead of re-resolving the old file against the wrong tree ([#98](https://github.com/overcodelions/overcli/pull/98)).

## [0.4.1] - 2026-06-29

A bugfix release: flow runs resume correctly after an app restart, plus review-sheet, explorer, Codex, and git fixes ([#96](https://github.com/overcodelions/overcli/pull/96)).

## [0.4.0] - 2026-06-28

The Orchestrator: fan a backlog out into a batch of flow runs, one git worktree per ask. Plus paused-run durability, snappier flow launches, and a security dependency sweep.

### Added
- **Orchestrator — batch fan-out of flows.** A new tab turns a source of requests (product feedback, tickets, a backlog — reached through your connected MCP tools) into a list of small, self-contained asks, maps each to a flow, and launches them together under a concurrency cap, one git worktree per ask. The producer turn investigates read-only and emits a candidate list you can triage and remap before launching, and each batch persists as a ledger ("why did I launch these?") across restarts ([#88](https://github.com/overcodelions/overcli/pull/88)).
- **Recent producer prompts.** The Orchestrator's Ask pane remembers the prompts you start fresh asks with and offers the most recent as one-click starters, so a good backlog query is re-runnable without retyping. Refinements are never recorded (they're meaningless out of context), and the list is deduped, capped, and persisted globally across projects ([#92](https://github.com/overcodelions/overcli/pull/92)).

### Changed
- **Launching a flow no longer freezes the app.** Worktree creation for a new run now happens asynchronously, so kicking off a flow — or a whole batch — keeps the UI responsive instead of blocking on git ([#89](https://github.com/overcodelions/overcli/pull/89)).

### Fixed
- **Paused flow runs stay paused across an app restart** instead of being demoted or silently resumed, so a human checkpoint survives a relaunch ([#90](https://github.com/overcodelions/overcli/pull/90)).
- **Opening a flow run no longer duplicates its chat,** and opening runs is faster ([#91](https://github.com/overcodelions/overcli/pull/91)).

### Security
- **Patched vulnerable dependencies to clear every open Dependabot alert (16 → 0).** `dompurify` — the renderer's HTML sanitizer — was bumped to 3.4.11; `hono`, `shell-quote`, `form-data`, and `tar` were forced to patched versions via npm `overrides`, and regenerating the lockfile cleared four further dev-tooling advisories (babel/core, joi, js-yaml, vite) ([#93](https://github.com/overcodelions/overcli/pull/93)).

## [0.3.1] - 2026-06-09

A bugfix release that makes packaged Claude usable again, plus the Fable 5 model.

### Fixed
- **Packaged builds spawned a fresh Overcli window on every Claude message turn**, making the app unusable. The `runAsNode` Electron fuse was disabled, so packaged binaries silently ignored `ELECTRON_RUN_AS_NODE` and booted a full GUI instance instead of running the Claude permission-broker helper headlessly as Node. Re-enabled the fuse (entitlements already permit it under hardened runtime) and documented the coupling at the helper spawn site so it isn't hardened back off ([#85](https://github.com/overcodelions/overcli/pull/85)).

### Added
- **Claude Fable 5 (`claude-fable-5`)** added to the model catalog as a new top `frontier` tier. The default Claude model is now **Opus 4.8**, and the bundled flow templates' planning steps (`plan` / `design`) use Fable 5, degrading to the backend's `thinking` model where Fable isn't available. Also salvages AI-drafted flows that named a near-miss model id (e.g. `claude-haiku-4.5` → `claude-haiku-4-5`) before validation ([#86](https://github.com/overcodelions/overcli/pull/86)).

## [0.3.0] - 2026-06-07

A polish release on top of 0.2.0: a real first-run onboarding experience, accurate install/signing docs, and a tightened Codex model list.

### Added
- **First-run setup screen** for users with no coding-agent CLI installed yet. Entry points (the welcome "Add your first project" button, sidebar **+ Add project** / **+ New workspace**, and the composer) are now gated behind a single `noBackendReady` helper with explanatory tooltips so they no longer dead-end. Each setup-guide row gets a **Copy** command button and a **Docs ↗** link, all five backends (incl. Copilot) are covered, a Flows feature card was added in a 2×2 grid, the header uses the real app icon, and the sidebar hides on a true first run so onboarding gets full width ([#78](https://github.com/overcodelions/overcli/pull/78)).

### Changed
- **Restricted the Codex model list to supported models.** Unavailable Codex model ids (`gpt-5.3-codex`, `gpt-5.2`) are removed from the picker catalog and renderer lists, scrubbed from persisted settings and conversations on load/save, and rejected across the renderer, flow validation, preflight, and runtime send paths ([#80](https://github.com/overcodelions/overcli/pull/80), [#81](https://github.com/overcodelions/overcli/pull/81)).

### Documentation
- Corrected the README Download section: macOS builds are **signed & notarized** and open normally. Replaced the blanket "unsigned" warning with per-platform first-run notes and an explanation of the **"Overcli Safe Storage"** keychain prompt (Electron `safeStorage`); Windows still uses SmartScreen → Run anyway and Linux needs `chmod +x` ([#77](https://github.com/overcodelions/overcli/pull/77)).
- Backfilled the `[0.2.0]` changelog with its full feature history (Flows, Copilot, auto-update, MCP catalog, Opus 4.8, and the Fixed/Changed/Security sections) ([#76](https://github.com/overcodelions/overcli/pull/76)).

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

[Unreleased]: https://github.com/overcodelions/overcli/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/overcodelions/overcli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/overcodelions/overcli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/overcodelions/overcli/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/overcodelions/overcli/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/overcodelions/overcli/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/overcodelions/overcli/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/overcodelions/overcli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/overcodelions/overcli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overcli/releases/tag/v0.1.0
