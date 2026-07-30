# Changelog

All notable changes to Overcli are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.0] - 2026-07-30

### Added
- **Context-window occupancy in the footer.** The only warning that a conversation was filling its window used to be the model itself mentioning it — by which point a long flow step had been degrading for a while. The footer now shows occupancy (input + cache reads + cache creation from the most recent request, i.e. the floor for what the next request resends), amber past 60% and red past 85%. Subagent usage is excluded, since a Task runs its own window; the denominator comes from the CLI's reported `contextWindow`, and without one the raw count is shown rather than an invented percentage. Reopening a conversation seeds the meter off the replayed transcript, and flow runs get the same readout per participant — participants keep one conversation across every step they run, so that number climbs quietly over a long flow ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **Cmd-click go to definition in the file editor.** Cmd-click (Ctrl elsewhere) an identifier to jump to its definition, with a picker when more than one site is plausible. Resolution is two tiers, cheapest first: ripgrep declaration patterns (~10ms, zero tokens, and enough for most symbols), then a one-shot query on the cheapest fast model when grep is ambiguous or empty. Every candidate is verified against disk before it reaches the renderer — the path must resolve inside the project root, the line must exist, and the line must mention the symbol — which is what makes the cheap model tier safe: a wrong `path:line` fails the check and escalates a rung instead of navigating somewhere wrong. The lookup runs entirely off the conversation, so clicking a symbol never perturbs the agent's context ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **Rename runs and flows in place.** Runs were identified only by the first line of their prompt, and fixing a badly-named flow meant a trip through the full editor. Runs now carry an optional title, editable by double-clicking a sidebar row or the run headline, at any point in a run's life including mid-step. Flows rename from the library row. A rename touches the display name only — the id, and therefore the file on disk, the star key, and every recorded run's `flowId`, is left alone, so it can never orphan anything ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **"Run flows in a worktree by default" setting.** The launcher's run-in toggle reset to the project tree on every launch, so a worktree-first user re-flipped it every time. Settings → Flows now seeds it, for both the start page's flow row and the library launcher; the per-run toggle still wins ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **Compaction is reported as it happens.** The notice carried no numbers and arrived only after the fact, and two states never surfaced at all: the ~20s stall while a large transcript is summarized, and a compaction that *failed* — which the CLI reports on a line overcli dropped, so a manual `/compact` could silently do nothing. Boundaries now read like "Conversation auto-compacted · 180k → 42k tokens", and only claim "auto" when the CLI said so ([#125](https://github.com/overcodelions/overcli/pull/125)).

### Fixed
- **The UI no longer locks up while several agents stream.** Two causes, both on hot paths. Persisting the store serialized every project, workspace and conversation — pretty-printed — synchronously on the main-process thread, which is also what brokers every streaming IPC message from every running agent; a few agents finishing turns at once stalled the whole window. Writes now coalesce over a 500ms window and run off-thread, keeping the atomic tmp+rename, with a synchronous flush on quit and a write-generation guard so an in-flight write can't clobber a newer snapshot. Turn completion — the most frequent write, and one that only moves a scalar — goes through a new targeted `store:patchConversation` instead of cloning the whole tree across IPC. Separately, the sidebar, conversation header and flow-run rows subscribed to the full runners map, whose identity changes on every ingested event, so they re-rendered at the streaming rate (~60Hz for the duration of every turn) while re-running unmemoized filters over every conversation in the app; they now read a value-compared projection of just the fields they use ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **Saving an existing flow no longer forks a user copy of a project flow.** The editor's target defaulted to the user layer regardless of where the flow came from. It now defaults to the flow's own layer, and changing a flow's id properly moves the file — previously the new file was written and the old one left behind, so the library showed the flow twice — carrying the star over to the new key. Saving into the *other* layer is still treated as a copy and deletes nothing ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **The expanded changes list scrolls instead of pushing the composer off-screen** on runs that touched dozens of files ([#125](https://github.com/overcodelions/overcli/pull/125)).
- **Dev userData no longer grows without bound.** Vite's HMR appends a fresh cache-busting query to every module on every edit, and Chromium treats each as a new permanently-cacheable URL; months of dev had accumulated ~32k entries and 1.6GB. The dev HTTP and code caches are now cleared on launch. Production loads from `file://` and was never affected ([#125](https://github.com/overcodelions/overcli/pull/125)).

## [0.10.0] - 2026-07-25

### Added
- **Claude Opus 5 is the default Claude model.** Added at the head of the catalog, so it's the auto-pick default, the flow drafter's model, and the `thinking`-tier substitution. `claude-opus-4-7` is retired ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Retired models auto-lift instead of breaking saved flows.** Dropping a model from the catalog used to make every flow pinned to it fail validation as "not supported". An unsupported id is now lifted to the next-highest version in the same model family — Opus 4.7 becomes 4.8, not a jump to 5 — falling back to the family's highest when nothing newer ships. Ids from an unknown family pass through untouched so validation can still reject them. Runs at flow load and in the drafter's model repair ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Find in diff (⌘F).** A find bar over any unified diff body, matching the editor's search keymap: case-insensitive, ordered, non-overlapping matches, stepped with Enter / ⇧Enter, with the current hit scrolled into view and highlighted. Searching includes the leading `+`/`−`, so a query like `-import` finds removals. When several diffs are mounted, only the topmost claims the key ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Orchestrator batches can run in the project's working tree.** Worktrees stay the default, but work that has to see the tree as it actually is — uncommitted changes, untracked files, a local build — can now run against it. Because cwd items share one working tree, such a batch is forced to `maxConcurrent: 1` and drains strictly one at a time; that's enforced in `startBatch` rather than trusted to the UI. Base branch is dropped in this mode, and the "open a PR" suffix asks for a new branch so a batch can't dump commits onto whatever was checked out ([#114](https://github.com/overcodelions/overcli/pull/114)).
- **Local directory flow registries.** A registry can now be a plain folder of `*.yaml` files — typically a git repo you already pull yourself — instead of a remote `index.json` with hand-maintained sha256 entries. overcli runs no git here: it reads the folder, hashes bodies itself, and rescans on every browse so an edited flow appears without hunting for Refresh. Browse surfaces each entry's mtime ([#114](https://github.com/overcodelions/overcli/pull/114)).
- **The sidebar Active section keeps a floor of 3.** It was a pure liveness filter, so stepping away emptied it entirely. The 3 most recent items now stay pinned however long they've been idle. Chats, agents and flow runs compete for the same slots instead of flows sitting on top with a separate cap; hidden conversations and archived runs are excluded from the backfill. "3" is a floor, not a cap — if five things are genuinely running, all five show ([#115](https://github.com/overcodelions/overcli/pull/115)).
- **Custom step roles in the flow drafter.** A step whose real job fell outside the role presets was forced into the nearest-sounding one, inheriting its system prompt. The drafter can now emit `role: custom` with a self-contained prompt it writes, and near-misses are reconciled so a written prompt left under a preset role is honored rather than silently discarded ([#118](https://github.com/overcodelions/overcli/pull/118)).
- **Deleted files render in the file view.** Clicking a deleted file used to dump a raw ENOENT into the pane. `fs:fileInfo` now flags a missing path, and the view skips the content read, shows the deletion diff under a banner with a `deleted` badge, and offers **Restore**. The changes bar strikes through deleted paths and keeps them clickable ([#113](https://github.com/overcodelions/overcli/pull/113)).
- **Harness-injected transcript lines render as themselves.** A finished background Task arrived as an ordinary `user` message, so a subagent's report showed as the user's own bubble; it now parses into a `taskNotification` card. `model_refusal_fallback` was dropped entirely on replay, leaving one model's answers under another model's header with no explanation; it now surfaces as a system notice ([#113](https://github.com/overcodelions/overcli/pull/113)).

### Fixed
- **Running indicators self-heal instead of spinning forever.** The indicator is edge-triggered, and a run's liveness ORs in its conversations, so one lost `running: false` made a *finished* flow run read as still working — one held a sidebar spinner for 13 hours. Three defences: a conservative main-side sweep that retracts only when nothing can still speak for the conversation (silence alone is never enough — a long tool call is quiet for minutes), a 10-minute ceiling on reviewer rounds, and a renderer reconcile that polls main's authoritative busy set and clears local flags absent from it ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Flow runs no longer wedge permanently on a single step.** A step with no assigned participant filed its conversation under its own id but was looked up under a blank key, so its own completion event was discarded and the run waited forever for something it had already thrown away. Separately, a step whose backend died quietly had no path out of `running` at all. Steps silent for over 30 minutes now fail into the same recoverable pause a rejected step gets ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Flow steps no longer fail off a superseded process's close.** When a conversation's process is killed to apply changed launch params, it drains asynchronously while a replacement turn is already live; the dead process's late `running:false` was mistaken for the new step finishing ("produced no `<output>`") ([#115](https://github.com/overcodelions/overcli/pull/115)).
- **The app returns to what you were looking at after sleep.** Only the selected conversation was persisted, so a renderer re-init — macOS discards the render process during a long sleep — dropped you off any flow run, orchestrator batch or project welcome screen back to the default view. The full view identity is now persisted and restored ([#116](https://github.com/overcodelions/overcli/pull/116)).
- **The orchestrator's main-tree choice survives a reload.** The `runIn` toggle lived only in the renderer store, whose fresh default is `worktree`, so after a reload a batch you'd set to main tree silently went back to worktrees. The sticky batch-launch defaults are now persisted alongside the view ([#117](https://github.com/overcodelions/overcli/pull/117)).
- **Two new flows no longer overwrite each other.** A flow's id becomes its filename, and every blank flow started as the constant `new-flow`, so the second silently replaced the first. New flows get a collision-free id; editing an existing flow keeps its id ([#118](https://github.com/overcodelions/overcli/pull/118)).
- **An unknown step role fails validation instead of running "undefined".** A role that is neither a preset nor `custom` resolved to the literal system prompt `"undefined"` — a silent runtime failure ([#118](https://github.com/overcodelions/overcli/pull/118)).
- **Codex tool output that arrives as content blocks no longer breaks history.** Codex now writes `function_call_output.output` as an array of content blocks; the field is typed `string`, so an array poisoned every consumer that trusted the type and broke `runner:loadHistory` in the dedupe path ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Queued workspace context notices stay bounded.** Workspace edits queue a notice onto every conversation, cleared only when that conversation next sends — so one you never send to again accumulated them forever. One real workspace had 103 stacked notices (52 KB) on a single conversation, which would have prepended ~13k tokens of stale churn to its next message. Notices are now deduped and capped, on both load and save ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **An explicitly chosen model is always passed to the backend.** Copilot conversations had no model field, and `--model` was omitted when the resolved model came back blank, so the CLI substituted its own default while the header still showed the user's pick. Resuming a session from the terminal also dropped its model ([#113](https://github.com/overcodelions/overcli/pull/113)).

### Security
- **AWS MCP entry migrated to the managed endpoint.** AWS put `awslabs.aws-api-mcp-server` into end-of-development. The catalog now installs the managed endpoint through a pinned `mcp-proxy-for-aws`, with the default region carried in `--metadata` rather than `env` (the managed server reads its region from proxy metadata, so the old env var silently stopped meaning what it meant). Existing installs are detected, badged **Legacy**, and can be reinstalled in place ([#122](https://github.com/overcodelions/overcli/pull/122)).
- **Credential leak in the auto-updater.** `electron-updater` pulled a `builder-util-runtime` that leaks `PRIVATE-TOKEN` and mixed-case `Authorization` headers across a cross-origin redirect — a production dependency doing authenticated network I/O on every update check ([#123](https://github.com/overcodelions/overcli/pull/123)).
- **Shipping-tree advisories cleared.** `fast-uri` (host confusion via failed IDN canonicalization, reached through the Agent SDK's MCP dependency), `body-parser` and `dompurify` are pinned to patched versions; build-only advisories in `axios`, `brace-expansion`, `electron-builder` and `postcss` are cleared too. The production tree goes from 1 high + 3 moderate to 0 high + 3 moderate — the remainder being a single Windows-only `@hono/node-server` path-traversal issue whose patch is a major outside the MCP SDK's declared range, and whose code path overcli never mounts ([#123](https://github.com/overcodelions/overcli/pull/123)).

## [0.9.0] - 2026-07-10

### Added
- **Compare two files in the explorer.** ⌥-click a file in the tree to pick a base, then ⌥-click a second to open a line diff in the right pane. Per changed block, arrows move it onto the other side (← left file, → right file); moves are staged in memory and nothing touches disk until Save (⌘S), with undo/redo (⌘Z / ⌘⇧Z), a dirty indicator, and a discard prompt when navigating away with unsaved moves. Reads both files through the existing file IPC, so the same size caps and binary rejection apply, and it works outside git repositories ([#106](https://github.com/overcodelions/overcli/pull/106)).
- **Revert a file from its diff.** A **Revert** button on a HEAD-based diff of a tracked file discards all uncommitted changes back to HEAD after a confirm — hidden for untracked files and for agent/flow views that diff against a base branch. Backed by a new, path-validated `git:restoreFile` handler kept off the read-only renderer git allowlist ([#106](https://github.com/overcodelions/overcli/pull/106)).
- **Committed vs uncommitted badges in the changes bar.** Each file now carries a `commitState` — `committed` (on the branch vs the fork point), `uncommitted` (pending working-tree edit), or `both` — computed by splitting `git diff --name-status <base> HEAD` against `git status --porcelain`, so the bar shows what's already committed apart from what's still pending ([#106](https://github.com/overcodelions/overcli/pull/106)).
- **Figma Dev Mode MCP server in the catalog.** Lists the Figma desktop app's built-in Dev Mode server (local http endpoint on `127.0.0.1:3845`, no OAuth or API key) under a new **Design** category, targeting Claude and Gemini ([#106](https://github.com/overcodelions/overcli/pull/106)).
- **GPT-5.6 codex models in the catalog.** Adds the GPT-5.6 codex generation (sol/terra/luna) with tier mapping — sol maps to the thinking tier, terra/luna to fast — plus display-name casing rules ([#107](https://github.com/overcodelions/overcli/pull/107)).

### Fixed
- **Switching flows resets per-run state.** The flow run pane is now keyed on the active run id so per-run local state (focused step / auto-follow) no longer carries across flow switches — previously a step selected in the prior flow stayed "picked", and because that id didn't exist in the new flow, nothing highlighted and the body falsely read "no participants" ([#106](https://github.com/overcodelions/overcli/pull/106)).
- **Codex app-server picker no longer strands you on compatibility mode.** overcli prefers Codex's `app-server` transport (tool cards + approvals) and falls back to `codex exec` without it. The picker now selects the **newest** app-server-capable codex instead of the first one in PATH order, and on a version tie prefers a **native binary over a `#!/usr/bin/env node` script** — the script fails with exit 127 when node isn't on PATH (e.g. under a bare launchd/Dock launch). Detection also probes support and version per candidate and bumps the timeout 3s → 5s for cold node-shebang starts ([#107](https://github.com/overcodelions/overcli/pull/107)).

## [0.8.0] - 2026-07-08

### Added
- **Browse a run's worktree files without leaving the run.** A **Files** toggle in the flow run header opens a lazy file tree rooted at the run's cwd — the worktree for a single-project run, or the coordinator symlink root for a workspace run — with a resizable divider that reuses the shared explorer width. Picking a file opens it in the side editor ([#105](https://github.com/overcodelions/overcli/pull/105)).
- **Open-in-Finder button on the file tree header** to reveal the current folder in the system file browser ([#105](https://github.com/overcodelions/overcli/pull/105)).

### Fixed
- **Opening a file mid-run no longer hangs the preview.** The Claude SDK message loop ran the whole parse → merge → send chain synchronously and never yielded, so a burst of streamed messages starved the main-process IPC handlers backing the Diff/File pane — the preview spinner spun until the round finished. The loop now yields a tick between messages, so file reads are serviced immediately during an active turn ([#105](https://github.com/overcodelions/overcli/pull/105)).
- **The reviewer rebound waits for background agents.** When the primary ends its turn but a detached background agent or workflow it launched is still working, the reviewer no longer fires against a half-finished step — it's held until the background work drains ([#104](https://github.com/overcodelions/overcli/pull/104)).
- **Hijacking a flow participant continues the step's session.** A hijack side-chat started a fresh session, so the model answered as if newly woken on a disconnected thread. It now resumes the participant's existing step session with full context, and a hijack that starts a new session can no longer overwrite the step's real transcript ([#105](https://github.com/overcodelions/overcli/pull/105)).
- **Stranded transcript loads retry instead of blanking.** An empty runner that cached a failed or raced history load blocked every retry, leaving the transcript blank until an app restart. Loads are now gated on a staleness window so a load that never settled self-heals, and reloads of an already-settled runner run quietly ([#105](https://github.com/overcodelions/overcli/pull/105)).
- **Workspace symlink reconcile no longer deletes agent files.** The reconcile, which re-runs on every app launch/reload, unlinked any root entry no member/project owned — silently destroying standalone deliverables and scratch notes agents wrote there. It now only reclaims its own stale symlinks and leaves regular files and directories alone ([#105](https://github.com/overcodelions/overcli/pull/105)).
- **Enabled buttons show a pointer cursor.** Tailwind's Preflight left buttons on the default arrow cursor; enabled buttons now read as clickable while disabled ones keep `not-allowed` ([#105](https://github.com/overcodelions/overcli/pull/105)).

### Changed
- **Attio MCP uses the hosted remote endpoint.** The Attio catalog entry switched from the community stdio server (`npx attio-mcp-server` + `ATTIO_API_KEY`) to Attio's hosted HTTP MCP endpoint with OAuth, dropping the API-key prompt ([#105](https://github.com/overcodelions/overcli/pull/105)).

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

[Unreleased]: https://github.com/overcodelions/overcli/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/overcodelions/overcli/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/overcodelions/overcli/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/overcodelions/overcli/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/overcodelions/overcli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/overcodelions/overcli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/overcodelions/overcli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/overcodelions/overcli/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/overcodelions/overcli/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/overcodelions/overcli/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/overcodelions/overcli/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/overcodelions/overcli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/overcodelions/overcli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/overcodelions/overcli/releases/tag/v0.1.0
