// Shared type definitions used by both the Electron main process and the
// renderer. Modeled on the Swift app's Conversation / Project / StreamEvent
// types so the JSON persistence shape stays compatible where it can.

import type { Flow, FlowArtifact, FlowRun, FlowToolDescriptor } from './flows/schema';
import type { Candidate, Orchestration, RecentPrompt, RunIn } from './flows/orchestration';
import type { Schedule } from './flows/schedule';
import type {
  Worker,
  WorkerContract,
  WorkerErrandResult,
  WorkerJournalEntry,
  WorkerScorecard,
  WorkerTrustLevel,
} from './flows/worker';
import type { PortableWorker, WorkerImportNotes } from './flows/workerYaml';
import type { WorkerReport } from './flows/workerReport';
import type { Treasury, TreasuryAllocation } from './flows/treasury';
import type { FlowTemplate } from './flows/templates';
import type { ChangelogRelease } from './changelog';
// Type-only, so the types ⇄ modelCatalog cycle is erased at compile time.
import type { FlowModelDefaults } from './modelCatalog';

export type UUID = string;
export type Backend = 'claude' | 'codex' | 'gemini' | 'ollama' | 'copilot';
export type PermissionMode = 'default' | 'plan' | 'auto' | 'acceptEdits' | 'bypassPermissions';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | '';
export type ResponseStyle = 'normal' | 'concise' | 'efficient';
export type ResponseMode = 'full' | 'swift' | 'turbo' | 'warp';

/// Curated rebound presets surfaced in the UI. 'custom' means the user
/// edited the underlying fields directly and we shouldn't try to pin a
/// preset name on the result. See `src/main/reboundPresets.ts` for the
/// source of truth on how each one resolves to backend/model/persona.
export type ReviewPreset =
  'half-finished' | 'security' | 'cheap-paranoid' | 'skeptical-user' | 'design-review' | 'independent' | 'custom';

/// Persona keys for the reviewer prompt preamble. The actual prompt
/// text lives in the same table — storing the key lets us tweak wording
/// without migrating saved conversations.
export type PersonaKey = 'half-finished' | 'security' | 'critic' | 'skeptical-user' | 'design';

export interface ToolUseBlock {
  id: string;
  name: string;
  /// Raw JSON string of the tool's arguments. The Swift app also parsed this
  /// for known tools; we do the same lazily at render time.
  inputJSON: string;
  filePath?: string;
  oldString?: string;
  newString?: string;
}

export interface ToolResultBlock {
  id: string;
  content: string;
  isError: boolean;
}

export interface AssistantEventInfo {
  model: string | null;
  text: string;
  toolUses: ToolUseBlock[];
  thinking: string[];
  /// Opaque (redacted / encrypted) reasoning — visible as a pill but not rendered
  hasOpaqueReasoning?: boolean;
  /// Set on streaming snapshots synthesized from `stream_event` deltas so
  /// the runner can skip reviewer-digest bookkeeping that the final
  /// non-partial `assistant` event will do once anyway. The renderer still
  /// shows partial events — that's the whole point.
  isPartial?: boolean;
  /// Token usage reported on this assistant message. Pulled from the
  /// CLI's `message.usage` block on the consolidated `assistant` line
  /// (not on per-token deltas). The SubagentDrawer's inline card sums
  /// these across a subagent's stream to surface "12 tool uses · 78k
  /// tokens"-style totals. Absent on streaming snapshots.
  usage?: ModelUsage;
}

export interface SystemInitInfo {
  sessionId: string;
  model: string;
  cwd: string;
  apiKeySource: string;
  tools: string[];
  slashCommands: string[];
  mcpServers: Array<{ name: string; status: string }>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /// Size of this model's context window, as reported by the CLI's
  /// per-model `modelUsage` block on the result line (e.g. 1_000_000 for
  /// `claude-opus-5[1m]`). Only the result path carries it — per-message
  /// usage blocks come straight from the API and don't include it. It is
  /// the denominator for the footer's context meter; absent means we show
  /// occupancy in raw tokens instead of a percentage.
  contextWindow?: number;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs: number;
  totalCostUSD: number;
  modelUsage: Record<string, ModelUsage>;
}

export interface RateLimitInfo {
  status: string;
  rateLimitType: string;
  remaining?: number;
  resetsAt?: number;
  limit?: number;
}

export interface PermissionRequestInfo {
  backend?: Backend;
  requestId: string;
  toolName: string;
  description: string;
  toolInput: string;
  decided?: 'allow' | 'deny';
  /// Filesystem path the request references (when the main process can
  /// pick one out of toolInput). Used by the card to offer an "Allow +
  /// add this directory for the session" action.
  requestedPath?: string;
  /// True when requestedPath is outside the conversation's current set of
  /// allowed directories (cwd + projects + workspaces + prior grants).
  outsideAllowedDirs?: boolean;
}

export interface CodexApprovalInfo {
  callId: string;
  kind: 'exec' | 'patch';
  command?: string;
  changesSummary?: string;
  reason?: string;
  decided?: 'allow' | 'deny';
}

export interface UserInputQuestionOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: UserInputQuestionOption[] | null;
}

export interface UserInputAnswer {
  answers: string[];
}

export interface UserInputRequestInfo {
  backend?: Backend;
  requestId: string;
  threadId?: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  submitted?: boolean;
}

export interface PatchFileChange {
  id: string;
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'move';
  movedFrom?: string;
  additions: number;
  deletions: number;
  /// Unified-diff text (optional — older patches may only carry summary).
  diff?: string;
}

export interface PatchApplyInfo {
  id: string;
  files: PatchFileChange[];
  success: boolean;
  stderr?: string;
}

/// One sub-agent inside a running Workflow/Task, distilled from the
/// `workflow_progress` array on `task_progress` system events. The CLI
/// emits the full agent set on every progress tick, so the renderer keys
/// these by `index` and lets newer ticks overwrite older ones.
export interface TaskAgentProgress {
  index: number;
  label: string;
  phaseTitle?: string;
  /// 'start' | 'done' | 'error' | 'queued' … — whatever the CLI reports.
  state: string;
  /// First ~1 sentence of the agent's prompt, for the row subtitle.
  promptPreview?: string;
  /// First chunk of the agent's final answer once it's done.
  resultPreview?: string;
  lastToolName?: string;
  lastToolSummary?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

/// A background Workflow/Task lifecycle update. Claude Code runs the
/// `Workflow` tool (and background `Agent`s) as a detached task and
/// reports progress out-of-band via `system` lines carrying a `task_id`
/// and the originating `tool_use_id`. We fold every subtype
/// (task_started / task_progress / task_updated / task_notification)
/// into this one shape; the renderer buckets them by `toolUseId` so the
/// inline Workflow card can show live phase/agent progress instead of a
/// dead generic tool card.
export interface TaskProgressInfo {
  taskId: string;
  /// The `Workflow`/`Task` tool_use block this task belongs to. Ties the
  /// out-of-band progress stream back to the inline card in the transcript.
  toolUseId: string;
  /// Coarse lifecycle phase derived from the system subtype.
  phase: 'started' | 'progress' | 'completed';
  /// Fine-grained status string when the CLI provides one ("completed",
  /// "failed", …); undefined while merely running.
  status?: string;
  taskType?: string;
  workflowName?: string;
  description?: string;
  /// Rolled-up usage for the whole task (tokens / tool calls / duration).
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
  /// Per-agent progress, present on `task_progress` ticks. Empty on the
  /// started/completed bookends.
  agents?: TaskAgentProgress[];
}

export interface ReviewInfo {
  backend: string;
  text: string;
  isRunning: boolean;
  error?: string;
  startedAt: number;
  round: number;
  mode?: string;
  thinking?: string;
  /// One-line summaries of tool calls the reviewer made while
  /// producing the verdict — `Read /path/to/file`, `Grep validateStages`,
  /// `Bash ls`. Streamed live so the user sees the reviewer doing work
  /// instead of just a spinner. Empty when the reviewer didn't invoke
  /// any tools (most non-claude paths today).
  toolActivity?: string[];
  raw?: string;
}

/// One conversation with a turn in flight, as reported by
/// `runner:runningSnapshot`. The authoritative answer to "is this
/// conversation busy right now" — see the channel's doc comment.
export interface RunningConversation {
  conversationId: UUID;
  activityLabel?: string;
}

/// Image attachment sent alongside a user prompt. `dataBase64` is the raw
/// file bytes in standard base64 (no `data:` prefix). Each backend encodes
/// this differently on the wire — claude takes base64 inline, codex wants
/// a file path so we write temp files, gemini is text-only today.
export interface Attachment {
  id: string;
  mimeType: string;
  dataBase64: string;
  label?: string;
  size?: number;
}

export type StreamEventKind =
  | { type: 'localUser'; text: string; attachments?: Attachment[] }
  | { type: 'systemInit'; info: SystemInitInfo }
  | { type: 'assistant'; info: AssistantEventInfo }
  | { type: 'toolResult'; results: ToolResultBlock[] }
  | { type: 'result'; info: ResultInfo }
  | { type: 'rateLimit'; info: RateLimitInfo }
  | { type: 'permissionRequest'; info: PermissionRequestInfo }
  | { type: 'codexApproval'; info: CodexApprovalInfo }
  | { type: 'userInputRequest'; info: UserInputRequestInfo }
  | { type: 'patchApply'; info: PatchApplyInfo }
  | { type: 'reviewResult'; info: ReviewInfo }
  | { type: 'taskProgress'; info: TaskProgressInfo }
  | { type: 'systemNotice'; text: string }
  | { type: 'metaReminder'; text: string }
  /// A background Task/Agent finishing. The harness injects these into the
  /// transcript as plain `user` messages with no distinguishing flag, so
  /// without this they render as something the user typed.
  | { type: 'taskNotification'; summary: string; body: string }
  | { type: 'easterEgg'; text: string; from: string }
  | { type: 'stderr'; line: string }
  | { type: 'parseError'; message: string }
  | { type: 'streamDelta' }
  | { type: 'other'; label: string };

export interface StreamEvent {
  id: string;
  timestamp: number;
  /// Timestamp of the first partial snapshot for this stable event id. The
  /// renderer replaces partial assistant snapshots in place, so `timestamp`
  /// advances while this anchor stays fixed for latency diagnostics.
  firstSeenAt?: number;
  /// Timestamp when this assistant id first contained visible prose.
  firstVisibleAt?: number;
  raw: string;
  kind: StreamEventKind;
  /// Bumps on in-place mutation of the partial-assistant slot so the renderer
  /// can tell a row changed even when its id didn't.
  revision: number;
  /// Set when this event came from a Task/Agent subagent rather than the
  /// main turn — value is the parent Task tool_use id from Claude's
  /// transport. The renderer routes these into a side store keyed by
  /// this id so the right-drawer SubagentDrawer can show the nested
  /// stream while the main transcript stays clean.
  parentToolUseId?: string;
  /// Set when the event came from the rebound reviewer rather than the
  /// primary backend. Lets consumers that only care about primary output
  /// (reviewer-digest bookkeeping, fork preamble, last-assistant-text
  /// extractors, the latest-tool-reveal in ChatView) filter these out,
  /// and drives the renderer's per-block "Codex · collab · round 2"
  /// header. `verdict: true` is set on exactly one assistant event per
  /// round (the final text-bearing message) — server-side, at
  /// turn/completed only. The renderer renders a small check next to
  /// that bubble's CLI label and demotes the round's other assistant
  /// text bubbles to intermediate styling. While the round is still in
  /// flight no event carries `verdict`, so nothing is dimmed and no
  /// check appears prematurely.
  reviewer?: {
    backend: Backend;
    round: number;
    mode: 'review' | 'collab';
    verdict?: boolean;
  };
}

export interface Conversation {
  id: UUID;
  name: string;
  sessionId?: string;
  createdAt: number;
  lastActiveAt?: number;
  /// Last time the *user* sent a turn here. `lastActiveAt` also moves when
  /// an agent finishes on its own, so it can't order a list by "what I was
  /// last working on" — this can.
  lastPromptAt?: number;
  totalCostUSD: number;
  turnCount: number;
  currentModel: string;
  permissionMode: PermissionMode;
  /// When set, the user has queued a permission-mode change that should
  /// apply the next time they send a turn instead of interrupting the
  /// current or idle session immediately.
  pendingPermissionMode?: PermissionMode;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
  /// The conversation is BORROWING a worktree someone else owns — today
  /// only a flow run's (`FlowRun.worktreePath`), attached via "New chat
  /// here" on the run pane so a fresh context can keep working in the
  /// same tree. It still looks and behaves like an agent conversation
  /// (`isAgentConversation` keys off `worktreePath`), but deleting it
  /// must NOT `git worktree remove` — the run still owns that tree and
  /// its Review & merge path depends on it. See `removeAgent`.
  adoptedWorktree?: boolean;
  orphaned?: boolean;
  hidden?: boolean;
  reviewBackend?: string | null;
  reviewMode?: 'review' | 'collab' | null;
  /// User-facing rebound configuration. The renderer picks a preset
  /// (e.g. 'half-finished', 'security'); selecting a preset writes the
  /// concrete reviewBackend / reviewMode / reviewModel / reviewPersona
  /// fields below. Editing anything in the Advanced section flips the
  /// preset to 'custom'. Stored separately from the resolved fields so
  /// the closed-state pill can show "rebound · half-finished" instead
  /// of "rebound · claude · review", and so the panel can show the
  /// active preset selection on reopen.
  reviewPreset?: ReviewPreset | null;
  /// Reviewer model override. Passed as `--model X` (claude) or `-m X`
  /// (codex/gemini). Null leaves the reviewer CLI on its default model.
  /// Ignored for ollama (use reviewOllamaModel instead).
  reviewModel?: string | null;
  /// Reviewer persona key. Resolved into a prompt preamble at run time
  /// from the table in `src/main/reboundPresets.ts` — storing the key
  /// (not the body) lets us tune persona wording without migrating
  /// saved conversations.
  reviewPersona?: PersonaKey | null;
  /// Captured reviewer session ids per backend. Persisted across app
  /// restarts so the next review can resume into the same warm thread
  /// instead of cold-starting (warm thread = cache reuse on the
  /// persona + transcript prefix, plus the reviewer's own prior
  /// verdicts stay in context). Today only `claude` is populated
  /// (via `--resume <id>`); the keyed shape leaves room for `codex`
  /// and others to join without renaming. Updated by the
  /// `reviewerSessionConfigured` IPC event after each successful
  /// review captures or refreshes its session id.
  reviewerSessionIds?: Partial<Record<Backend, string>>;
  collabMaxTurns?: number | null;
  /// SHA-256 hashes of synthetic collab pingPrompts overcli has fed to
  /// the primary CLI. The primary's transcript persists those as
  /// `role: 'user'` messages, which on restart history-replay would
  /// otherwise render as misattributed user-style bubbles. We use these
  /// hashes at replay time to skip them. The list grows by one per
  /// collab round and is small (64 chars/entry) — bounded by round
  /// count, not by prompt size.
  syntheticPrompts?: string[];
  /// Ollama-specific reviewer model override. When the reviewer is
  /// `ollama`, this takes precedence over the app-wide Ollama default.
  reviewOllamaModel?: string | null;
  /// Codex-only: when the Codex reviewer fires, launch it with a
  /// workspace-write sandbox and auto-approve so it can actually edit
  /// files instead of bouncing off its default read-only sandbox.
  /// Ignored for non-Codex reviewers.
  reviewYolo?: boolean | null;
  primaryBackend?: Backend;
  claudeModel?: string;
  codexModel?: string;
  geminiModel?: string;
  ollamaModel?: string;
  copilotModel?: string;
  codexRolloutPath?: string;
  /// Every rollout file codex has created for this conversation. codex proto
  /// has no --resume, each spawn writes a fresh file — we merge on load.
  codexRolloutPaths?: string[];
  effortLevel?: EffortLevel;
  /// Controls visible answer length and, in efficient mode, asks the model
  /// to consolidate independent tool work. It does not lower reasoning
  /// effort or change the selected model.
  responseStyle?: ResponseStyle;
  /// Named speed preset shown in the conversation header. The underlying
  /// responseStyle/turbo/model fields remain explicit so runners do not need
  /// to interpret a UI concept.
  responseMode?: ResponseMode;
  /// Values displaced by Warp so selecting Full/Swift/Turbo can restore the
  /// user's prior model and effort. Models are kept per backend because a
  /// conversation can switch providers while Warp remains selected.
  responseModeRestore?: {
    models: Partial<Record<Exclude<Backend, 'ollama'>, string>>;
    effortLevel?: EffortLevel;
  };
  /// Trade depth for latency on this conversation: `--effort low`,
  /// `--strict-mcp-config`, and a directive to consolidate tool calls.
  /// Absent means off — there is deliberately no global default, because
  /// turbo is a per-task judgement, not a mode to leave running.
  /// Claude CLI also uses this to suppress global MCP startup. The SDK
  /// transport honors the low-effort half but has no CLI argv to tighten.
  turbo?: boolean;
  colosseumId?: UUID;
  workspaceAgentMemberIds?: UUID[];
  workspaceAgentCoordinatorId?: UUID;
  /// Set on a workspace-agent member after the user runs "Check out
  /// locally" on it: the worktree was removed and the project repo was
  /// switched onto `branchName`. The coordinator keeps the member in
  /// `workspaceAgentMemberIds` so the review sheet can render a
  /// "demoted to local" card instead of a perpetual spinner — the other
  /// members remain reviewable as usual.
  checkedOutLocally?: boolean;
  /// Set on a workspace-agent coordinator after all its members were
  /// checked out locally AND the user opted to keep conversing. The
  /// coordinator's symlink root has been rebound to point at each
  /// project's main repo (not the removed worktrees), so resuming the
  /// session via --resume continues the chat against the branches that
  /// are now checked out locally. Separate from `checkedOutLocally`
  /// (members use that flag; the coordinator becomes
  /// `continuedLocally` instead).
  continuedLocally?: boolean;
  /// Set on workspace-agent coordinators: a synthetic directory whose
  /// symlinks point at each member's worktree. Used as the coordinator's
  /// cwd so the agent's file-system tools land in the worktrees, not the
  /// projects' main trees. Absent on single-project conversations and on
  /// plain workspace conversations.
  coordinatorRootPath?: string;
  /// Read-only agents check out someone else's branch into a
  /// detached-HEAD worktree so the user can read + converse about the
  /// changes without touching their main project tree. The flag drives
  /// header actions (Promote to agent, Dismiss) and selecting a canned
  /// first-turn prompt via `reviewAgentKind`.
  reviewAgent?: boolean;
  /// Branch being reviewed — only set when `reviewAgent` is true. Kept
  /// separate from `branchName` because the worktree is detached and
  /// doesn't own its own branch.
  reviewTargetBranch?: string;
  /// Which read-only flow this agent was spawned for. 'review' = PR-style
  /// code review; 'docs' = produce user-facing documentation for the
  /// feature in the target branch. Defaults to 'review' when absent for
  /// back-compat with conversations saved before `docs` existed.
  reviewAgentKind?: 'review' | 'docs';
  /// Directories the user has granted this conversation access to beyond
  /// its cwd. Passed to Claude as `--add-dir` on every spawn so mid-turn
  /// cross-project approvals persist across process restarts.
  allowedDirs?: string[];
  /// One-shot context blob prepended to the next `send` — set when this
  /// conversation was created as a fork of another. Consumed + cleared on
  /// the first turn so the new CLI sees the prior exchange once without
  /// flooding every subsequent turn.
  forkPreamble?: string;
  /// Same one-shot prepend mechanism as forkPreamble, but triggered when
  /// the surrounding workspace's project list changes after this conv has
  /// already started. Lets the live CLI subprocess pick up new/removed
  /// member projects without needing a session restart — the rewritten
  /// CLAUDE.md / AGENTS.md / GEMINI.md only matters at session start.
  pendingContextUpdate?: string;
}

export interface Project {
  id: UUID;
  name: string;
  path: string;
  conversations: Conversation[];
  lastOpenedAt?: number;
  /// Scaffolded by "New everyday project" rather than pointed at with the
  /// folder picker. The welcome pane keys its non-engineer copy off this
  /// rather than off "is a git repo" — everyday projects ARE git repos (that
  /// is what makes undo work), so the repo test says "code project" for
  /// exactly the folders that are not one.
  everyday?: boolean;
}

export interface Workspace {
  id: UUID;
  name: string;
  projectIds: UUID[];
  rootPath: string;
  conversations: Conversation[];
  createdAt: number;
  instructions?: string;
}

export type ColosseumStatus = 'running' | 'comparing' | 'merged' | 'cancelled';

export interface Colosseum {
  id: UUID;
  name: string;
  prompt: string;
  baseBranch: string;
  projectId: UUID;
  contenderIds: UUID[];
  createdAt: number;
  status: ColosseumStatus;
  winnerId?: UUID;
}

/// Snapshot of the agent worktree's git state relative to its base branch
/// and to the project checkout the worktree was spawned from. Drives the
/// diff/merge/push sheet's status pills and enables/disables action
/// buttons. Computed synchronously on demand — cheap enough since we
/// already shell out to git for the diff.
export type RemoteKind = 'github' | 'other' | 'none';

/// Why an init did not happen. The renderer picks its wording from this
/// rather than from the error string: "couldn't start a history" has several
/// causes with completely different remedies (install something / pick a
/// different folder / nothing you can do), and guessing one of them in the UI
/// is how someone with no git installed got told their folder was nested
/// inside another project.
export type InitRepoFailure = 'no-folder' | 'no-git' | 'needs-xcode-tools' | 'already-tracked' | 'too-large' | 'failed';

export interface WorktreeStatus {
  filesChanged: number;
  insertions: number;
  deletions: number;
  commitsAhead: number;
  hasUncommittedChanges: boolean;
  /// Worktree branch is already merged into its base branch (nothing to
  /// re-merge). Computed from `merge-base --is-ancestor`.
  isMergedIntoBase: boolean;
  /// Whatever branch the main project checkout is currently on. `null`
  /// means detached HEAD or a git error.
  currentProjectBranch: string | null;
  remoteKind: RemoteKind;
  /// Count of dirty files in the *main* project checkout — flags the
  /// "agent wrote to the wrong tree" case so the UI can offer a rescue.
  mainTreeDirtyFiles: number;
}

/// What a swept worktree is, from least to most deletable. See
/// `classifyWorktree` for the precedence rules.
///   foreign     — outside `~/.overcli/worktrees`; another tool's or the
///                 user's own. Reported for honest accounting, never offered.
///   live        — a conversation or flow run still claims it. Left alone;
///                 releasing one of these is Settings → Conversations' job,
///                 because it means deleting the conversation, not disk.
///   has-work    — unreferenced, but holds uncommitted or unmerged changes.
///                 Offered, never pre-selected.
///   reclaimable — nothing claims it, clean, nothing unmerged. Safe.
export type WorktreeSweepBucket = 'foreign' | 'live' | 'has-work' | 'reclaimable';

export interface WorktreeSweepEntry {
  worktreePath: string;
  projectPath: string;
  projectName: string;
  /// null for a detached HEAD (review worktrees).
  branchName: string | null;
  baseBranch: string;
  bucket: WorktreeSweepBucket;
  /// Which bit of app state still claims this tree, if any.
  referenced: 'conversation' | 'run' | null;
  /// Timestamp of the last commit in the worktree. An orphan has no
  /// conversation left to date it by, so this is what the pane's age filter
  /// runs on. Absent when the branch has no commits or the tree is gone.
  lastCommitAt?: number;
  dirtyFiles: number;
  commitsAhead: number;
  isMergedIntoBase: boolean;
  /// Apparent disk usage from `du -sk`. 0 when unreadable or prunable.
  sizeKb: number;
  locked: boolean;
  /// git says the registration is stale (directory gone). Cleared by
  /// `git worktree prune`, not by `git worktree remove`.
  prunable: boolean;
}

export interface WorktreeSweepResult {
  entries: WorktreeSweepEntry[];
  scannedAt: number;
}

/// How long a conversation can sit untouched before Settings → Conversations
/// offers it up. Two weeks covers a normal context switch (a sprint, a
/// holiday) without letting finished work pile up for months. Archived
/// conversations age at half this — see `isStaleConversation`.
export const DEFAULT_STALE_DAYS = 14;

export const STALE_DAY_CHOICES = [7, 14, 30, 90] as const;

/// Choices for the Storage pane's "older than" view filter. Purely a display
/// filter, so it needs no rescan and can be swept through freely. 0 means no
/// filter.
export const AGE_FILTER_CHOICES = [0, 7, 30, 60, 90, 180] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/// When a conversation was last touched. `lastActiveAt` is only written when
/// a turn streams or the conversation is opened, so a never-run conversation
/// falls back to when it was created.
export function conversationActiveAt(conv: { lastActiveAt?: number; createdAt?: number }): number {
  return conv.lastActiveAt ?? conv.createdAt ?? 0;
}

/// Whether a conversation has gone quiet long enough to offer up. An archived
/// one is held to half the threshold: archiving is the user explicitly saying
/// "done with this for now", a far stronger signal than mere silence.
export function isStaleConversation(args: {
  lastActiveAt?: number;
  createdAt?: number;
  archived: boolean;
  staleDays: number;
  now: number;
}): boolean {
  const days = args.archived ? args.staleDays / 2 : args.staleDays;
  return args.now - conversationActiveAt(args) > days * DAY_MS;
}

export interface BackendHealth {
  kind: 'ready' | 'unauthenticated' | 'missing' | 'unknown' | 'error';
  message?: string;
}

/// CLI extensions (skills, subagents, slash commands, plugins, MCP
/// servers) discovered by scanning each CLI's on-disk config. Unlike
/// `SystemInitInfo.slashCommands` this is populated at app-start — no
/// first-turn required — and models availability per-CLI so the UI can
/// show which backends expose each item.
export type CapabilityKind = 'skill' | 'agent' | 'command' | 'plugin' | 'mcp';
export type CapabilitySource = 'user' | 'project' | 'plugin' | 'builtin';

export interface CapabilityEntry {
  kind: CapabilityKind;
  /// Stable key across scans, e.g. "skill:atlassian:triage-issue",
  /// "mcp:github". Used for React keys and dedup across CLI sources.
  id: string;
  name: string;
  description?: string;
  source: CapabilitySource;
  /// Plugin bundle this came from, when source === 'plugin'.
  pluginId?: string;
  /// File backing this capability (SKILL.md, agent .md, command .md).
  /// For MCP this is the config file where the server is defined.
  path?: string;
  /// Which CLIs currently expose this capability. MCP servers may appear
  /// in multiple CLIs; skills/agents/commands today are typically one.
  clis: Backend[];
}

export interface CapabilitiesReport {
  generatedAt: number;
  entries: CapabilityEntry[];
  /// Non-fatal scan errors, per source, so the UI can surface them
  /// without failing the whole scan.
  warnings: string[];
}

/// Curated skill that can be installed into a CLI's skills/ directory.
/// `targets` lists the backends this skill can be installed into;
/// Gemini is intentionally excluded today because gemini-cli has no
/// `skills/` convention to write into.
export type SkillTarget = Extract<Backend, 'claude' | 'codex'>;

export interface MarketplaceSkill {
  /// Stable id used as the install directory name (e.g. "git-helper").
  id: string;
  name: string;
  description: string;
  targets: SkillTarget[];
  /// Per-target installed status, set by the main process at list time.
  installed: Partial<Record<SkillTarget, boolean>>;
}

/// CLIs that can host MCP servers. Unlike `SkillTarget`, Gemini is
/// included — all three CLIs have an MCP server config format that
/// `mcpConfig.ts` knows how to read and write.
export type McpCli = Extract<Backend, 'claude' | 'codex' | 'gemini'>;

/// One value a catalog MCP server needs. Collected in overcli at install
/// time and written into the server's `env` block in each target CLI's
/// config (where the CLIs already read MCP env from) — unless the entry's
/// template references the key as `${KEY}` in its `args`, in which case it
/// is substituted there instead. Some servers read the two from different
/// places and only honour the command line.
export interface McpSecretField {
  /// Env var name, e.g. "BRAVE_API_KEY"; or the `${KEY}` an entry's args
  /// interpolate, e.g. "AWS_REGION".
  key: string;
  label: string;
  /// Short hint, e.g. where to generate the token.
  help?: string;
  /// URL to the provider's token page.
  link?: string;
  /// When true, the field is non-blocking (Apply works if left empty) and
  /// rendered as plain text rather than a masked secret — e.g. a profile
  /// name that isn't actually a credential.
  optional?: boolean;
  /// Prefilled at install and used when an optional field is left blank.
  /// Only ever a sane public default (a region, an endpoint) — never a
  /// credential.
  defaultValue?: string;
}

/// A curated MCP server the user can one-click install into any of their
/// CLIs. Two auth shapes: `stdio` servers that take API keys via `env`
/// (collected by overcli), and `remote` servers configured by URL whose
/// OAuth login the CLI completes on first connect.
export interface McpCatalogItem {
  /// Stable id, also used as the MCP server name written to config.
  id: string;
  name: string;
  description: string;
  /// UI grouping bucket, e.g. "Dev tools".
  category: string;
  transport: 'stdio' | 'remote';
  targets: McpCli[];
  /// Env-var credentials to collect at install. Empty when none needed.
  secrets: McpSecretField[];
  /// Shown for remote/OAuth servers — explains login finishes in the CLI.
  authNote?: string;
  docsUrl?: string;
  /// Per-target installed status, set by the main process at list time.
  installed: Partial<Record<McpCli, boolean>>;
  /// Per-target "installed, but the config predates the current template"
  /// — the vendor retired or re-shaped the server. Implies `installed`.
  /// Reinstalling overwrites the entry in place.
  legacy: Partial<Record<McpCli, boolean>>;
  /// Why the installed config is stale, shown next to Reinstall.
  legacyNote?: string;
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface OllamaDetectionReport {
  installed: boolean;
  running: boolean;
  version?: string;
  binaryPath?: string;
  models: OllamaModelInfo[];
  installHint?: { brewAvailable: boolean; downloadUrl: string };
}

export type OllamaTier = 'tiny' | 'small' | 'medium' | 'large';

export interface OllamaRecommendedModel {
  tag: string;
  displayName: string;
  sizeGB: number;
  license: string;
  /// Maker of the model (e.g. "Alibaba Cloud", "Meta", "Mistral AI"). The
  /// UI groups/filters by this and we surface it on the pull card so it's
  /// clear whose weights you're downloading.
  company: string;
  /// ISO-3166 alpha-2 of the maker's primary jurisdiction. "EU" is used
  /// for pan-European consortia. Useful for users with data-sovereignty
  /// or regulatory constraints.
  country: string;
  /// Approximate public release of this model family/size in `YYYY-MM`.
  /// Helps users spot stale models at a glance — AI moves fast enough
  /// that a 2-year-old coder model is usually not the right default.
  releasedAt?: string;
  note?: string;
  /// True if the model's training supports Ollama's tool-calling protocol.
  /// Used to promote agentic-capable models in the picker and to show a
  /// "Tools" badge in the UI. Models without this still work as chat-only.
  supportsTools?: boolean;
}

export interface OllamaHardwareReport {
  platform: string;
  arch: string;
  totalRamGB: number;
  cpuModel: string;
  gpu?: string;
  appleSilicon: boolean;
  recommendedTier: OllamaTier;
  recommendedModels: OllamaRecommendedModel[];
}

export type OllamaPullEvent =
  | { type: 'status'; tag: string; message: string }
  | {
      type: 'progress';
      tag: string;
      percent: number;
      completed: number;
      total: number;
      message?: string;
    }
  | { type: 'done'; tag: string; success: boolean; message?: string };

export type OllamaServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface OllamaServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

export type OllamaSecuritySeverity = 'critical' | 'high' | 'medium' | 'info';

export interface OllamaSecurityFinding {
  id: string;
  severity: OllamaSecuritySeverity;
  title: string;
  detail: string;
  /// Present only when overcli can fix this itself via 'ollama:applyFix'.
  fixId?: 'update-ollama' | 'restart-loopback';
  /// Shown as copyable text when there is no automatic fix.
  manualCommand?: string;
  url?: string;
}

export interface OllamaSecurityReport {
  installedVersion?: string;
  latestVersion?: string;
  /// Source of installedVersion: the running server, or the binary on disk.
  versionSource: 'server' | 'binary' | 'unknown';
  updateAvailable: boolean;
  checkedAt: number;
  findings: OllamaSecurityFinding[];
}

export type ThemePreference = 'light' | 'dark' | 'system';

/// A source of installable flows. Exactly one of `indexUrl` / `dir` is set:
/// a registry is either remote (an index.json served over http(s)) or local
/// (a folder of YAML files on disk).
export interface FlowRegistry {
  id: string;          // slug
  name: string;
  indexUrl?: string;   // http(s) URL to index.json
  /// Absolute path to a directory of `*.yaml` flow files. Read directly —
  /// no index.json, no sha256 to hand-maintain. overcli only reads the
  /// folder; keeping it current (e.g. `git pull` on a repo you own) is the
  /// user's job, which is what makes a private registry cost nothing to run.
  dir?: string;
}

export function isLocalRegistry(r: FlowRegistry): r is FlowRegistry & { dir: string } {
  return typeof r.dir === 'string' && r.dir.length > 0;
}

export interface FlowRegistryEntry {
  registryId: string;
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  author?: { name: string; url?: string };
  version: string;
  sha256: string;
  /// Where the YAML lives — `yamlUrl` for remote registries (absolute,
  /// resolved from the index entry's `yaml_url`), `yamlPath` for local ones.
  yamlUrl?: string;
  yamlPath?: string;
  /// Local registries only: the file's mtime. Surfaced in the browse UI
  /// because overcli can't tell you whether the folder is behind its remote —
  /// it never talks to git — so the honest signal is "last touched when".
  updatedAt?: number;
}

export interface InstalledRegistryFlow {
  registryId: string;
  id: string;
  version: string;
  filename: string;    // basename under <userData>/flows/
}

export type SidebarLayout = 'stream' | 'projects';

export interface AppSettings {
  backendPaths: Partial<Record<Backend, string>>;
  backendDefaultModels: Partial<Record<Backend, string>>;
  /// Which model each speed tier means when a flow is generated or a
  /// template is resolved, per backend. Distinct from
  /// `backendDefaultModels` (one model for new conversations): a flow
  /// spends several models at once, and what it needs pinned is the
  /// *tier* mapping — which model is "the thinking one", which is "the
  /// fast one". An unset tier means auto: the newest catalog model at
  /// that tier, so the default keeps up with the catalog on its own.
  flowModelDefaults?: FlowModelDefaults;
  /// Backends hidden/disabled in the UI. Disabled backends are not used as
  /// defaults and are skipped by health probes.
  disabledBackends: Partial<Record<Backend, boolean>>;
  /// Preferred default backend for new conversations and agents. If unset
  /// or disabled, falls back to the first enabled backend.
  preferredBackend?: Backend;
  defaultPermissionMode: PermissionMode;
  /// Fallback reasoning effort for backends with no explicit entry in
  /// `backendDefaultEfforts`.
  defaultEffort: EffortLevel;
  /// Per-backend reasoning effort, overriding `defaultEffort`. Exists
  /// because "Auto" is not neutral: it defers to each CLI's own default,
  /// and those differ sharply — a Claude model can land on `high` while
  /// codex lands on its own middle tier. Tuning one backend's latency
  /// used to mean moving the other's at the same time.
  /// See `effortForBackend`.
  backendDefaultEfforts?: Partial<Record<Backend, EffortLevel>>;
  agentBranchPrefix: string;
  showCost: boolean;
  /// Initial value for the chat's "show tool activity" toggle at app
  /// launch. The toggle itself remains a per-session runtime flag so
  /// users can flip it mid-conversation without touching Settings.
  defaultShowToolActivity: boolean;
  autoDowngrade: boolean;
  /// Theme preference. 'system' follows the OS's dark-mode setting via
  /// the `prefers-color-scheme` media query.
  theme: ThemePreference;
  /// Persisted pane widths. Clamped on read to the component's min/max
  /// so a stored-too-large value from a wider monitor doesn't pin the
  /// app's content region to zero.
  sidebarWidth: number;
  editorPaneWidth: number;
  /// Width of the file-tree column inside the standalone explorer view.
  explorerTreeWidth: number;
  /// How the primary sidebar is organised.
  ///
  /// 'stream' is one flat, newest-first list of everything you have worked
  /// on, with the owning project printed once per run of consecutive rows.
  /// 'projects' is the project/workspace tree. They are two answers to two
  /// different questions — "what was I doing" and "where does this live" —
  /// rather than a feature and its absence, which is why this is a choice
  /// and not a boolean.
  sidebarLayout?: SidebarLayout;
  /// Sidebar shortcut strip for running/recent conversations.
  showActiveSidebarSection?: boolean;
  /// Set once the user has opened Flows → Schedules. Until then the segment
  /// carries a discovery glow. Persisted rather than per-session so the hint
  /// doesn't come back every launch — a highlight that never retires is one
  /// the eye learns to skip.
  seenSchedules?: boolean;
  /// When true, the sidebar footer shows a "Debug" button that opens the
  /// DebugSheet. Off by default to keep the footer lean; developers can
  /// flip it on in Settings → Advanced.
  showDebug?: boolean;
  /// Transport used to drive Claude. 'cli' (default) spawns `claude -p`
  /// with stream-json over stdio — the long-standing path. 'sdk' is the
  /// in-process @anthropic-ai/claude-agent-sdk path; it survives future
  /// restrictions on `-p` and exposes typed events / direct permission
  /// callbacks. Opt-in while the SDK transport is being built out.
  claudeTransport?: 'cli' | 'sdk';
  /// When true, the Claude CLI is launched with `--debug mcp`, which prints
  /// MCP server startup/registration diagnostics to stderr. overcli forwards
  /// stderr as `stderr` stream events, so the output shows up in the Debug
  /// viewer — use it to diagnose MCP issues (e.g. the permission broker not
  /// registering in a crowded MCP config). Off by default; it's noisy.
  claudeMcpDebug?: boolean;
  /// Flow keys (`${source}:${id}`) the user has starred. Starred flows
  /// sort first in the welcome pane's "Or run a flow" row.
  starredFlows?: string[];
  /// Where a flow launched from the start page or the Flows library runs
  /// by default: 'cwd' works directly in the project/workspace tree,
  /// 'worktree' mints a fresh worktree off the base branch. The launcher's
  /// toggle still overrides it per run — this only picks its initial side.
  defaultFlowRunIn?: 'cwd' | 'worktree';
  flowRegistries?: FlowRegistry[];
  installedRegistryFlows?: InstalledRegistryFlow[];
  /// Which auto-update feed the app follows. 'stable' tracks tagged
  /// releases (the `latest` channel); 'nightly' tracks the rolling nightly
  /// prerelease. The in-app updater is the single source of truth — whatever
  /// build you installed, this setting decides what it upgrades to.
  updateChannel?: 'stable' | 'nightly';
  /// How long a conversation's backend process may sit idle — turn finished,
  /// nothing pending — before overcli tears it down. `claude -p --input-format
  /// stream-json` (and codex app-server) stay resident with every configured
  /// MCP server loaded for as long as stdin is open, so a session the user
  /// walked away from an hour ago still costs its full footprint. The next
  /// send respawns and `--resume`s the stored sessionId, so reaping is
  /// invisible apart from a slightly slower first turn. 0 disables it.
  idleSessionTimeoutMinutes?: number;
  /// Newest version whose release notes the user has been shown. Drives the
  /// "What's new" panel — see src/main/whatsNew.ts. Absent means the baseline
  /// hasn't been seeded yet (a fresh install, or an install that predates the
  /// feature); main stamps it on first launch so nothing is shown for a
  /// version the user was already running.
  lastSeenVersion?: string;
}

/// The user's current "where am I" view, persisted alongside the selected
/// conversation so a full renderer re-init — e.g. macOS discarding the render
/// process during a long sleep, then Electron reloading the page — restores
/// the exact flow run / orchestrator batch / project screen instead of
/// dropping back to the default conversation view. `detailMode` is the
/// renderer's DetailMode union, kept loose here to avoid coupling shared types
/// to renderer code.
export interface PersistedView {
  detailMode?: string;
  focusedProjectId?: UUID | null;
  focusedWorkspaceId?: UUID | null;
  activeRunId?: string | null;
  activeOrchestrationId?: string | null;
  /// Sticky orchestrator batch-launch defaults. These live only in the
  /// renderer store, whose fresh default is `runIn: 'worktree'`; without
  /// persisting them a renderer reload silently reverted a user's "main tree"
  /// choice back to worktrees for the next batch. `runIn` is the flows RunIn
  /// union, kept loose here to avoid coupling shared types across modules.
  orchestrator?: {
    runIn?: 'cwd' | 'worktree';
    maxConcurrent?: number;
    openPrOnFinish?: boolean;
  };
}

/// Open file-editor tabs, keyed by scope — `conv:<id>`, `flow:<runId>` or
/// `explorer:<rootPath>` (see the renderer's fileScope.ts). Only the paths
/// and which one was in front are persisted: view mode and any jumped-to
/// line range are per-session, and unsaved buffers deliberately never
/// reach disk.
export type PersistedFileTabs = Record<string, { paths: string[]; activePath?: string | null }>;

/// What the "What's new" panel renders, assembled in src/main/whatsNew.ts
/// from the CHANGELOG.md that ships in the app bundle.
export interface WhatsNewReport {
  /// The running build's version, i.e. `app.getVersion()`.
  currentVersion: string;
  /// Releases the user hasn't seen, newest first, capped — see `olderCount`.
  releases: ChangelogRelease[];
  /// Unseen releases dropped by the cap. Surfaced in the UI rather than
  /// silently truncated, so a long-absent user knows there's more.
  olderCount: number;
  /// Whether to surface this unprompted — auto-open on launch plus the dot
  /// on the title bar's About button. False for a freshly seeded install
  /// (nothing is "new" on your first launch) and on the nightly channel,
  /// where a panel every launch would just train the dismissal reflex.
  unseen: boolean;
}

/// Renderer → main requests. Responses come back via invoke's return value.
export interface IPCInvokeMap {
  'store:load': () => {
    projects: Project[];
    workspaces: Workspace[];
    colosseums: Colosseum[];
    settings: AppSettings;
    selectedConversationId?: UUID;
    lastInit?: SystemInitInfo;
    view?: PersistedView;
    fileTabs?: PersistedFileTabs;
  };
  'store:saveProjects': (projects: Project[]) => void;
  'store:saveWorkspaces': (workspaces: Workspace[]) => void;
  /// Patch a single conversation's metadata without shipping (and
  /// re-sanitizing) the entire projects/workspaces tree. Resolves false if
  /// the conversation isn't on disk yet, so the caller can fall back to a
  /// full save.
  'store:patchConversation': (args: { id: UUID; patch: Partial<Conversation> }) => boolean;
  'store:saveColosseums': (colosseums: Colosseum[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;
  'store:saveSelection': (id: UUID | null) => void;
  'store:saveView': (view: PersistedView) => void;
  'store:saveFileTabs': (tabs: PersistedFileTabs) => void;
  /// Quit and install a downloaded update now (triggered from UpdateToast).
  'update:quitAndInstall': () => void;
  /// Release notes the user hasn't seen yet, parsed from the bundled
  /// CHANGELOG.md. Cheap enough to call on every launch — the file is read
  /// and parsed once per process.
  'app:whatsNew': () => WhatsNewReport;
  /// Stamp `lastSeenVersion` at the running version, clearing the unseen
  /// flag. Called when the What's New sheet is opened.
  'app:markWhatsNewSeen': () => void;
  /// The running build's version. Nightly builds stamp package.json at CI
  /// time, so this is the only honest source — a constant in the renderer
  /// goes stale the moment it isn't hand-edited alongside a release.
  'app:version': () => string;
  'runner:send': (args: {
    conversationId: UUID;
    prompt: string;
    backend: Backend;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    sessionId?: string;
    effortLevel?: EffortLevel;
    turbo?: boolean;
    codexRolloutPaths?: string[];
    attachments?: Attachment[];
    /// Reviewer ("rebound") config for this turn. When `reviewBackend` is
    /// set, the runner fires the reviewer after the primary turn
    /// completes and streams reviewResult events back.
    reviewBackend?: string | null;
    reviewMode?: 'review' | 'collab' | null;
    reviewModel?: string | null;
    reviewPersona?: PersonaKey | null;
    /// Persisted reviewer session ids per backend. When present for the
    /// active reviewer backend, the runner primes ReviewerManager's
    /// in-memory map so the next reviewer invocation resumes the warm
    /// thread (survives app restart). Today only `claude` is wired.
    reviewerSessionIds?: Partial<Record<Backend, string>>;
    collabMaxTurns?: number | null;
    reviewOllamaModel?: string | null;
    reviewYolo?: boolean | null;
    /// Absolute paths Claude should be allowed to read beyond its cwd.
    /// Renderer fills this from the conversation's project/workspace and
    /// the persisted `conversation.allowedDirs`.
    allowedDirs?: string[];
    /// Optimistic id the renderer assigned to the user's bubble so it can
    /// show instantly. Main uses the same id on its emitted localUser event
    /// so `mergeIncomingEvents` updates in place instead of double-rendering.
    localUserId?: string;
    /// Cleaner version of `prompt` to show in the UI bubble. The model
    /// still receives `prompt` verbatim (full scaffolding / role
    /// instructions / output contract). Used by flow runtime to hide
    /// the noisy meta-instructions from the user-facing transcript.
    /// Falls back to `prompt` when omitted.
    displayText?: string;
    /// Transport to use for Claude turns. Defaults to 'cli' when omitted.
    /// 'sdk' routes through @anthropic-ai/claude-agent-sdk instead of
    /// spawning `claude -p`. Ignored for non-claude backends.
    claudeTransport?: 'cli' | 'sdk';
  }) => { ok: true } | { ok: false; error: string };
  /// Spawn a conversation's backend process before the user sends, so CLI
  /// startup and session resume happen off the critical path. Best-effort:
  /// the runner ignores it when a runtime already exists.
  'runner:prewarm': (args: {
    conversationId: UUID;
    backend: Backend;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    sessionId?: string;
    effortLevel?: EffortLevel;
    turbo?: boolean;
    allowedDirs?: string[];
    claudeTransport?: 'cli' | 'sdk';
  }) => void;
  'runner:stop': (args: { conversationId: UUID }) => void;
  'runner:newConversation': (args: { conversationId: UUID }) => void;
  /// Tear down every runtime holding a conversation — subprocess, ollama
  /// session, gemini ACP client, warm reviewer — because the conversation
  /// itself is going away (delete) or being parked (archive). Distinct from
  /// `runner:stop`, which the UI only reaches for a *running* turn: a
  /// finished-but-resident session is invisible to the running indicator and
  /// would otherwise leak until quit. `onlyIfIdle` declines to cut a turn
  /// short — archive passes it, delete does not.
  'runner:release': (args: { conversationId: UUID; onlyIfIdle?: boolean }) => void;
  'runner:respondPermission': (args: {
    conversationId: UUID;
    requestId: string;
    approved: boolean;
    /// When present, persist the directory on the conversation's
    /// allowedDirs and respawn Claude with it on the next turn so the
    /// directory gate admits it.
    addDir?: string;
    /// 'always' with approved=true marks the tool auto-approvable for
    /// the rest of this conversation's subprocess lifetime. Future
    /// permission requests for the same toolName resolve without
    /// surfacing a prompt.
    scope?: 'once' | 'always';
    /// Paired with scope='always' so main knows which tool name to add
    /// to the conversation's auto-approve set.
    toolName?: string;
  }) => void;
  'runner:respondCodexApproval': (args: {
    conversationId: UUID;
    callId: string;
    kind: 'exec' | 'patch';
    approved: boolean;
  }) => void;
  'runner:respondUserInput': (args: {
    conversationId: UUID;
    requestId: string;
    answers: Record<string, UserInputAnswer>;
  }) => void;
  'runner:loadHistory': (args: {
    conversationId: UUID;
    backend: Backend;
    projectPath: string;
    sessionId?: string;
    codexRolloutPaths?: string[];
    conversationCreatedAt?: number;
    conversationLastActiveAt?: number;
    /// SHA-256 hashes of synthetic collab pingPrompts the primary's
    /// transcript persists. Replay skips any user-role message whose
    /// content hashes to one of these so reviewer feedback doesn't
    /// resurface as a user-style bubble after restart.
    syntheticPrompts?: string[];
  }) => StreamEvent[];
  /// Conversations main currently believes have a turn in flight. The
  /// renderer polls this to reconcile its own per-conversation `isRunning`
  /// flags: the indicator is edge-triggered, so a single dropped `running`
  /// event would otherwise leave a spinner (and any flow run that reads it
  /// via `runIsLive`) stuck busy until the window reloads.
  'runner:runningSnapshot': () => RunningConversation[];
  'runner:probeHealth': (backend: Backend) => BackendHealth;
  'runner:listInstalledReviewers': () => Record<string, boolean>;
  /// Drop main's backend-health probe cache, so the next `runner:probeHealth`
  /// re-executes the CLIs instead of answering from the last 15s.
  'health:invalidate': () => void;
  'capabilities:scan': () => CapabilitiesReport;
  'skills:listMarketplace': () => MarketplaceSkill[];
  'skills:installMarketplace': (args: {
    skillId: string;
    targets: SkillTarget[];
  }) => { ok: true } | { ok: false; error: string };
  'skills:uninstallMarketplace': (args: {
    skillId: string;
    targets: SkillTarget[];
  }) => { ok: true } | { ok: false; error: string };
  /// Removes any installed skill — marketplace or hand-rolled. Validates
  /// the path lives directly under ~/.claude/skills or ~/.codex/skills
  /// before deleting the skill's directory.
  'skills:uninstallByPath': (args: { path: string }) => { ok: true } | { ok: false; error: string };
  /// Copies an MCP server config from one CLI to another, translating
  /// between JSON (`mcpServers`) and TOML (`[mcp_servers.<name>]`) as
  /// needed. The source CLI must already have the server configured;
  /// the target CLI gets it added (or replaced if already present).
  'capabilities:copyMcp': (args: {
    name: string;
    fromCli: Backend;
    toCli: Backend;
  }) => { ok: true } | { ok: false; error: string };
  /// Creates an MCP server entry in every target CLI in one shot.
  /// Partial success is reported via `written` + `errors`.
  'capabilities:addMcp': (args: {
    name: string;
    config: Record<string, unknown>;
    targets: Backend[];
  }) => { ok: true; written: Backend[]; errors: string[] } | { ok: false; error: string };
  /// Curated MCP catalog: list entries with per-CLI installed status.
  'mcp:listCatalog': () => McpCatalogItem[];
  /// Install a catalog entry into the given CLIs, merging any collected
  /// secrets into the server's `env` block. Partial success via `written`
  /// + `errors`, same shape as `capabilities:addMcp`.
  'mcp:installCatalog': (args: {
    id: string;
    targets: Backend[];
    secrets?: Record<string, string>;
  }) => { ok: true; written: Backend[]; errors: string[] } | { ok: false; error: string };
  /// Remove a catalog entry from the given CLIs.
  'mcp:uninstallCatalog': (args: {
    id: string;
    targets: Backend[];
  }) => { ok: true; removed: Backend[]; errors: string[] } | { ok: false; error: string };
  /// Trigger a remote MCP server's OAuth login. Only Codex supports this
  /// (spawns `codex mcp login <name>`); Claude/Gemini return a message
  /// pointing at their in-session login.
  'mcp:login': (args: {
    cli: Backend;
    name: string;
  }) => { ok: true; output: string } | { ok: false; error: string; output?: string };
  'fs:pickDirectory': () => string[] | null;
  'fs:fileInfo': (args: { path: string; rootPath?: string }) => FileInfoResult;
  'fs:readFile': (args: {
    path: string;
    rootPath?: string;
  }) => { ok: true; content: string; resolvedPath: string } | { ok: false; error: string };
  'fs:readLargeTextPreview': (args: { path: string; rootPath?: string }) =>
    | {
        ok: true;
        content: string;
        resolvedPath: string;
        truncated: boolean;
        totalBytes: number;
        previewBytes: number;
      }
    | { ok: false; error: string };
  'fs:readArtifactPreview': (args: { path: string; rootPath?: string }) => ArtifactPreviewResult;
  /// `path` may be a hint relative to `rootPath` (workspace/flow tabs keep
  /// their `<member>/…` prefix); it goes through the same resolver as reads.
  'fs:writeFile': (args: {
    path: string;
    content: string;
    rootPath?: string;
  }) => { ok: true } | { ok: false; error: string };
  'fs:listFiles': (root: string) => string[];
  'fs:listFileEntries': (root: string) => FileTreeEntry[];
  /// Start watching `root` so the file tree can relist itself when an agent
  /// (or anything else) writes into the project. Refcounted in main — every
  /// `fs:watchTree` needs a matching `fs:unwatchTree`. `key` is the resolved
  /// root carried by the `fileTreeChanged` events; `ok: false` means the
  /// platform refused a recursive watch and only manual refresh will work.
  'fs:watchTree': (root: string) => { ok: boolean; key: string };
  'fs:unwatchTree': (root: string) => void;
  'fs:openInFinder': (path: string) => void;
  'fs:openPath': (path: string) => { ok: true } | { ok: false; error: string };
  /// Copy a previewed file into the OS Downloads folder (macOS/Windows/Linux
  /// via Electron's `app.getPath('downloads')`). Never overwrites: a name
  /// clash gets ` (2)`, ` (3)`, … before the extension. `savedPath` is the
  /// file that was actually written.
  'fs:saveToDownloads': (path: string) => { ok: true; savedPath: string } | { ok: false; error: string };
  /// Resolve a clicked symbol to its definition site(s). Runs entirely off
  /// the conversation — ripgrep first, then a one-shot fast-model query if
  /// that's ambiguous. See src/main/symbolLookup.ts.
  'symbols:findDefinition': (args: {
    /// Project root to search within.
    cwd: string;
    /// Absolute path of the file the symbol was clicked in.
    filePath: string;
    symbol: string;
    /// 1-based line of the click, for disambiguating context.
    line: number;
  }) => SymbolLookupResult;
  /// Second pass for an ambiguous grep answer: skips the grep tier and asks
  /// a fast model to pick the definition. Only reached when the user clicks
  /// "Refine" in the candidate picker, so a lookup never spends model time
  /// unasked.
  'symbols:refineDefinition': (args: {
    cwd: string;
    filePath: string;
    symbol: string;
    line: number;
  }) => SymbolLookupResult;
  /// Write a flow artifact's body to a temp file and open it with the OS
  /// default app. Flow artifacts live only in memory (no on-disk path), so
  /// this materializes one on demand. `kind` picks the file extension.
  'flows:openArtifact': (args: {
    name: string;
    kind: 'markdown' | 'diff' | 'text' | 'url';
    body: string;
  }) => { ok: true } | { ok: false; error: string };
  /// Read the local files an HTML preview references (stylesheets, images,
  /// fonts) so the renderer can inline them. The preview iframe is
  /// sandboxed onto an opaque origin and cannot fetch `file://` itself.
  'preview:htmlAssets': (args: { path: string; rootPath?: string; refs: string[] }) => HtmlPreviewAssetsResult;
  /// Compile a .tsx/.jsx component into a self-contained script the
  /// preview iframe can run. `contents` carries the editor's unsaved
  /// buffer so the preview tracks what you are looking at.
  'preview:reactBundle': (args: { path: string; rootPath?: string; contents?: string }) => ReactPreviewBundleResult;
  /// Hand a finished preview document to the main process and get back an
  /// `overcli-preview://` URL for it. The renderer's own CSP forbids the
  /// inline script a compiled component needs, and a srcDoc frame inherits
  /// that CSP — a document served over its own scheme does not.
  /// `policy` picks the document's CSP: `bundle` (the default) for a
  /// component Overcli compiled and inlined itself, `document` for a
  /// hand-written .html file, which is nearly always a CDN page and renders
  /// blank without remote script.
  'preview:publishDocument': (args: {
    html: string;
    policy?: 'bundle' | 'local' | 'document';
  }) => { ok: true; url: string } | { ok: false; error: string };
  'preview:projectHints': (args: { path: string; rootPath?: string }) => ProjectPreviewHintsResult;
  'preview:runProjectCommand': (args: { cwd: string; command: string }) => { ok: true } | { ok: false; error: string };
  'git:run': (args: { args: string[]; cwd: string }) => {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  /// Discard uncommitted changes to a single file, resetting it to HEAD.
  /// Destructive; the renderer confirms first and the main process
  /// re-validates the cwd against registered roots.
  'git:restoreFile': (args: { cwd: string; path: string }) => { ok: true } | { ok: false; error: string };
  'git:createWorktree': (args: {
    projectPath: string;
    agentName: string;
    baseBranch: string;
    branchPrefix: string;
  }) => { ok: true; worktreePath: string; branchName: string } | { ok: false; error: string };
  'git:createReviewWorktree': (args: {
    projectPath: string;
    agentName: string;
    targetBranch: string;
  }) => { ok: true; worktreePath: string; resolvedTarget: string } | { ok: false; error: string };
  'git:promoteReviewWorktree': (args: {
    projectPath: string;
    worktreePath: string;
    agentName: string;
    branchPrefix: string;
  }) => { ok: true; branchName: string } | { ok: false; error: string };
  'git:switchProjectToBranch': (args: {
    projectPath: string;
    worktreePath: string;
    targetBranch: string;
  }) => { ok: true; message: string; stashed: boolean } | { ok: false; error: string };
  'git:switchBranch': (args: {
    cwd: string;
    targetBranch: string;
  }) => { ok: true; message: string; stashed: boolean } | { ok: false; error: string };
  'git:removeWorktree': (args: { projectPath: string; worktreePath: string; branchName: string }) => {
    ok: boolean;
    error?: string;
    warning?: string;
  };
  /// Scan every project for worktrees and classify them for cleanup. The
  /// renderer passes the worktree paths its conversations still claim; main
  /// adds the flow runtime's. Anything git knows about but neither side
  /// claims is an orphan. Disk only — releasing a worktree a conversation
  /// still owns belongs to `git:conversationWorktreeStates` and the store's
  /// `removeAgent`, since that deletes history rather than reclaiming space.
  'git:scanWorktrees': (args: {
    projects: Array<{ path: string; name: string }>;
    conversationPaths: string[];
  }) => WorktreeSweepResult;
  /// Cheap per-conversation worktree check for Settings → Conversations: is
  /// there uncommitted or unmerged work that deleting would destroy? No `du`
  /// — that pane is about history, not disk, and sizing is what makes the
  /// Storage scan slow.
  'git:conversationWorktreeStates': (args: {
    targets: Array<{
      convId: UUID;
      projectPath: string;
      worktreePath: string;
      branchName: string | null;
      baseBranch: string;
    }>;
  }) => Array<{
    convId: UUID;
    exists: boolean;
    dirtyFiles: number;
    commitsAhead: number;
    isMergedIntoBase: boolean;
  }>;
  'git:sweepWorktrees': (args: {
    entries: Array<{
      projectPath: string;
      worktreePath: string;
      branchName: string | null;
      baseBranch?: string;
    }>;
  }) => {
    removed: number;
    freedKb: number;
    failures: Array<{ worktreePath: string; error: string }>;
    warnings: string[];
  };
  'git:checkoutAgentLocally': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    commitSubject: string;
    commitBody?: string;
    /// When present, relocate the Claude session file from the worktree's
    /// cwd slug to the project's cwd slug so history + --resume survive.
    sessionId?: string;
  }) => { ok: true; message: string; stashed: boolean; autoCommitted: boolean } | { ok: false; error: string };
  'git:listBaseBranches': (projectPath: string) => string[];
  /// Same list, but fetches from origin first so branches pushed
  /// elsewhere (a PR opened on another machine) show up in the picker.
  'git:listBaseBranchesFresh': (projectPath: string) => string[];
  'git:detectBaseBranch': (projectPath: string) => string;
  'git:mergeAgent': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    target: string;
    baseBranch: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:rebaseAgent': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:pushBranch': (args: {
    worktreePath: string;
    branchName: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string; compareUrl?: string } | { ok: false; error: string };
  'git:openPR': (args: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string; url?: string } | { ok: false; error: string };
  'git:worktreeStatus': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    baselineCommit?: string | null;
  }) => WorktreeStatus;
  'git:worktreeDiff': (args: { cwd: string; baseBranch: string; baselineCommit?: string | null }) => {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  'git:rescueMainTree': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:commitStatus': (args: { cwd: string }) => {
    isRepo: boolean;
    currentBranch: string;
    // `commitState` splits committed-on-branch from uncommitted working-tree
    // edits (`'both'` = committed with further pending edits). HEAD-relative,
    // so `git:commitStatus` reports every file as `'uncommitted'`.
    changes: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      commitState: 'committed' | 'uncommitted' | 'both';
    }>;
    insertions: number;
    deletions: number;
  };
  /// Base-relative twin of `git:commitStatus` for flow worktrees: counts
  /// committed + uncommitted changes vs the run's fork point so the chat
  /// ChangesBar matches the review sheet's diff.
  'git:worktreeChanges': (args: { worktreePath: string; baseBranch: string; baselineCommit?: string | null }) => {
    isRepo: boolean;
    currentBranch: string;
    changes: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      commitState: 'committed' | 'uncommitted' | 'both';
    }>;
    insertions: number;
    deletions: number;
    /// Ref the counts were measured against, for labelling the bar. Null
    /// when we fell back to the run's frozen fork point.
    baseRef: string | null;
  };
  'git:currentBranch': (args: { cwd: string }) => {
    isRepo: boolean;
    branch: string;
  };
  'git:workspaceCommitStatus': (args: {
    projects: Array<{
      name: string;
      path: string;
      baseBranch?: string;
      baselineCommit?: string | null;
    }>;
  }) => {
    isRepo: boolean;
    currentBranch: string;
    changes: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      commitState: 'committed' | 'uncommitted' | 'both';
    }>;
    insertions: number;
    deletions: number;
    /// Set only when every member agreed on the same base ref.
    baseRef: string | null;
  };
  /// Resolve the commit a base-relative diff should start from, live. The
  /// renderer needs this for per-file diffs, which run through `git:run`
  /// rather than one of the aggregate probes.
  'git:resolveDiffBase': (args: { cwd: string; preferredBranch?: string | null; fallbackCommit?: string | null }) => {
    commit: string;
    ref: string | null;
  };
  'git:commitAll': (args: {
    cwd: string;
    message: string;
  }) => { ok: true; sha: string; subject: string } | { ok: false; error: string };
  'git:initRepo': (args: {
    projectPath: string;
  }) => { ok: true; branch: string } | { ok: false; reason: InitRepoFailure; error: string };
  /// Whether git is usable on this machine. `needs-xcode-tools` is macOS
  /// with the Command Line Tools stub — git is one dialog away, not absent.
  'git:availability': (args?: {
    refresh?: boolean;
  }) => { state: 'ok'; version: string } | { state: 'needs-xcode-tools' } | { state: 'missing' };
  /// Opens a Terminal window running the platform's git install command.
  /// `command` comes back either way so the UI can offer it as copyable text
  /// when we could not open a window (Linux, or a refused Apple Event).
  'git:install': () => { ok: true; command: string } | { ok: false; error: string; command?: string };
  'git:removeHistory': (args: { projectPath: string }) => { ok: true } | { ok: false; error: string };
  /// Convert an existing project folder to or from an everyday project by
  /// writing or deleting its marker. The store's `everyday` flag alone would
  /// not survive a reinstall or a second machine.
  'fs:setEverydayMarker': (args: {
    projectPath: string;
    everyday: boolean;
  }) => { ok: true } | { ok: false; error: string };
  'fs:syncProjectMarkers': (args: { projects: Array<{ path: string; everyday?: boolean }> }) => Record<string, boolean>;
  'fs:listDocuments': (args: {
    dirPath: string;
  }) => { ok: true; entries: DocumentEntry[] } | { ok: false; error: string };
  'versions:checkpoint': (args: { projectPath: string; message: string }) => {
    ok: boolean;
    skipped?: 'nothing-to-save' | 'too-large';
    error?: string;
  };
  'versions:list': (args: {
    projectPath: string;
    limit?: number;
  }) => { ok: true; versions: ProjectVersion[] } | { ok: false; error: string };
  'versions:diff': (args: {
    projectPath: string;
    sha: string;
    file?: string;
  }) => { ok: true; diff: string } | { ok: false; error: string };
  'versions:restore': (args: {
    projectPath: string;
    sha: string;
    label: string;
  }) => { ok: true } | { ok: false; error: string };
  'fs:cancelRevise': (args: { requestId: string }) => { stopped: boolean };
  'fs:reviseDocument': (args: {
    path: string;
    content: string;
    instruction: string;
    rootPath?: string;
    /// Correlates the `documentRevise` progress events with this call.
    requestId?: string;
    /// Set when `content` is a SELECTED PASSAGE rather than the whole file.
    /// The passage is what gets rewritten; this is the surrounding document,
    /// passed as read-only context so the rewrite fits where it lands.
    fullDocument?: string;
  }) => { ok: true; content: string } | { ok: false; error: string };
  'fs:createBlankDocument': (args: {
    dirPath: string;
    name: string;
    ext: string;
  }) => { ok: true; path: string } | { ok: false; error: string };
  'fs:createDocumentFromPrompt': (args: {
    dirPath: string;
    description: string;
  }) => { ok: true; path: string; backend: string } | { ok: false; error: string };
  'fs:copyIntoProject': (args: {
    projectPath: string;
    files: Array<{ name: string; dataBase64: string }>;
  }) => { ok: true; written: number } | { ok: false; error: string };
  /// The folder is scaffolded and the history started in one call. A failed
  /// history is NOT a failed creation — the folder exists and is usable — so
  /// it comes back as `historyOn: false` plus the reason, and the caller
  /// decides how much of a problem that is.
  'fs:createEverydayProject': (args: { title: string; goal: string }) =>
    | { ok: true; path: string; historyOn: true }
    | {
        ok: true;
        path: string;
        historyOn: false;
        historyReason: InitRepoFailure;
        historyError: string;
      }
    | { ok: false; error: string };
  'git:workspaceCommitAll': (args: { projects: Array<{ name: string; path: string }>; message: string }) =>
    | {
        ok: true;
        committed: Array<{ name: string; sha: string }>;
        skipped: Array<{ name: string; reason: string }>;
        subject: string;
      }
    | { ok: false; error: string };
  'workspace:ensureSymlinkRoot': (args: {
    workspaceId: UUID;
    projects: Array<{ name: string; path: string }>;
    instructions?: string;
  }) => { ok: true; rootPath: string } | { ok: false; error: string };
  'workspace:removeSymlinkRoot': (workspaceId: UUID) => { ok: true } | { ok: false; error: string };
  'workspace:ensureCoordinatorSymlinkRoot': (args: {
    coordinatorId: UUID;
    members: Array<{ name: string; worktreePath: string }>;
  }) => { ok: true; rootPath: string } | { ok: false; error: string };
  'workspace:rebindCoordinatorRootToProjects': (args: {
    coordinatorId: UUID;
    projects: Array<{
      name: string;
      projectPath: string;
      branchName?: string | null;
    }>;
  }) => { ok: true; rootPath: string } | { ok: false; error: string };
  'workspace:removeCoordinatorSymlinkRoot': (coordinatorId: UUID) => { ok: true } | { ok: false; error: string };
  /// `command` is present on failure when we know what the user should run
  /// themselves — a blocked Apple Event means we opened a window but couldn't
  /// type into it, so the UI offers the line to copy.
  'auth:openCliLogin': (backend: Backend) => { ok: true } | { ok: false; error: string; command?: string };
  'terminal:popConversation': (args: {
    cwd: string;
    backend: Backend;
    sessionId?: string;
    /// The session's model. Without it the popped-out CLI resumes on its own
    /// default, silently dropping the model the conversation was running on.
    model?: string;
  }) => { ok: true } | { ok: false; error: string; command?: string };
  /// Open a terminal window sitting in a folder, nothing typed. Used by the
  /// file tree's per-folder terminal button.
  'terminal:openFolder': (args: { path: string }) => { ok: true } | { ok: false; error: string };
  'app:openExternal': (url: string) => void;
  'app:showAbout': () => void;
  'app:reloadStats': () => StatsReport;
  /// Shell out to `claude -p "/usage"` for Claude's real limit percentages —
  /// it writes nothing to disk, so this is the only way to get them. Takes
  /// ~6s, hence its own channel: the Usage page renders from the cached
  /// snapshot first and calls this afterwards. Resolves false when claude is
  /// missing, logged out, or changed its wording.
  'app:refreshClaudeUsage': () => boolean;
  /// Notify the OS that an agent finished while the app wasn't focused.
  /// macOS: dock bounce. Windows/Linux: taskbar flash. No-op when the
  /// window is already focused. Debounced in main to avoid a chain of
  /// bounces when many agents finish in quick succession.
  'app:notifyCompleted': () => void;
  'ollama:detect': () => OllamaDetectionReport;
  'ollama:hardware': () => OllamaHardwareReport;
  'ollama:catalog': () => OllamaRecommendedModel[];
  'ollama:install': () => {
    started: 'brew' | 'browser';
    detail?: string;
    command?: string;
  };
  'ollama:startServer': () => { ok: boolean; message: string };
  'ollama:stopServer': () => { ok: boolean; message: string };
  'ollama:serverStatus': () => {
    status: OllamaServerStatus;
    log: OllamaServerLogLine[];
  };
  'ollama:pullModel': (args: { tag: string }) => { ok: true } | { ok: false; error: string };
  'ollama:cancelPull': (args: { tag: string }) => void;
  'ollama:deleteModel': (args: { tag: string }) => { ok: true } | { ok: false; error: string };
  'ollama:deleteSession': (sessionId: string) => void;
  'ollama:securityAudit': (args?: { force?: boolean }) => OllamaSecurityReport;
  'ollama:applyFix': (args: { fixId: 'update-ollama' | 'restart-loopback' }) => {
    ok: boolean;
    message: string;
    command?: string;
  };
  'diagnostics:list': () => SilentLogEntry[];
  'diagnostics:clear': () => void;
  'diagnostics:log': (args: { level: LogLevel; scope: string; message: string }) => void;
  /// Flows — see src/shared/flows/. Library is the user-global +
  /// project-local YAML files; runs are in-memory state machines that
  /// drive a sequence of step Conversations.
  'flows:list': (args: { projectPaths?: string[] }) => Flow[];
  'flows:save': (args: {
    flow: Flow;
    /// `generated` writes to the worker-drafted bucket, which the library
    /// keeps out of its main groups — see Flow['source'].
    target: Flow['source'];
    /// Required when target === 'project'. The flow file is written to
    /// <projectPath>/.overcli/flows/<flow.id>.yaml.
    projectPath?: string;
  }) => { ok: true; filePath: string } | { ok: false; error: string };
  'flows:delete': (args: {
    flowId: string;
    source: Flow['source'];
    projectPath?: string;
  }) => { ok: true } | { ok: false; error: string };
  'flows:validate': (args: {
    yaml: string;
    id?: string;
  }) => { ok: true; flow: Flow } | { ok: false; errors: Array<{ path: string; message: string }> };
  'flows:toolCatalog': (args: { backend: Backend }) => FlowToolDescriptor[];
  /// Bundled-with-the-app curated templates shown in the "+ New flow"
  /// picker. Not part of the user/project library — these are immutable
  /// starting points; selecting one clones it into a fresh editor draft.
  'flows:listTemplates': () => FlowTemplate[];
  /// Draft a flow from a natural-language description using Claude. The
  /// renderer surfaces this behind a "✨ Describe a flow" button. On
  /// success, the user drops into the editor with the generated draft.
  'flows:draftFromPrompt': (args: { description: string }) => { ok: true; flow: Flow } | { ok: false; error: string };
  /// Revise the flow currently open in the builder. Takes the draft's YAML
  /// plus a plain-English instruction ("drop the test step", "review for
  /// security before shipping") and returns the whole flow with that change
  /// applied, validated the same way a fresh draft is. `id` carries the
  /// draft's existing id through — the YAML body doesn't hold it, and a
  /// revision must keep it so the next save updates the flow rather than
  /// forking a new file.
  'flows:reviseFromPrompt': (args: {
    yaml: string;
    instruction: string;
    id?: string;
  }) => { ok: true; flow: Flow } | { ok: false; error: string };
  'flows:startRun': (args: {
    flowId: string;
    projectPath: string;
    userPrompt: string;
    /// Images / files attached to the launch prompt. Handed to the
    /// step(s) that read `user_prompt` (typically the first / planning
    /// step) so the flow can act on a screenshot, spec, or log.
    attachments?: Attachment[];
    /// Optional. `cwd` (default) runs in the project/workspace as-is.
    /// `worktree` creates a fresh git worktree off `baseBranch` and runs
    /// there — isolates file changes from the user's main checkout.
    runIn?: 'cwd' | 'worktree';
    /// Required when `runIn === 'worktree'`.
    baseBranch?: string;
  }) =>
    | { ok: true; runId: UUID }
    | {
        ok: false;
        error: string;
        preflight?: {
          problems: Array<{ path: string; message: string; hint?: string }>;
        };
      };
  /// Every retained run, plus the ids of the `done` ones whose worktree still
  /// holds uncommitted work. The dirty ids ride alongside the runs rather than
  /// on them: `flowRunUpdate` echoes runs back wholesale and `saveRun` persists
  /// them, so a field on FlowRun would be clobbered on the next update and
  /// reload stale. Computed at fetch time; see `unreviewedDoneRunIds`.
  'flows:listRuns': () => { runs: FlowRun[]; unreviewedRunIds: UUID[] };
  /// Just the dirty ids, recomputed. The renderer calls this on window focus:
  /// the user may have committed or cleaned a worktree in another app, and a
  /// stale "unreviewed" dot outlives its truth otherwise. Separate from
  /// `flows:listRuns` so a refresh doesn't re-ship every run.
  'flows:listUnreviewedRuns': () => UUID[];
  'flows:getRun': (args: { runId: UUID }) => FlowRun | null;
  'flows:resumeRun': (args: {
    runId: UUID;
    /// Optional per-artifact overrides. Each key/value replaces the
    /// artifact body in the run's artifact map before the next step
    /// reads its inputs. Used by the pause-card "edit artifact" affordance.
    editedArtifacts?: Record<string, string>;
    /// On a FAILURE pause, roll forward past the failed step (handing its
    /// already-recorded output to the next step) instead of re-running it.
    /// The "override the gate" escape hatch; ignored on other pauses.
    override?: boolean;
  }) => { ok: true } | { ok: false; error: string };
  /// Rewind a run and re-execute from `stepId`, rolling forward through
  /// every later step. Artifacts from EARLIER steps are kept (they're this
  /// step's inputs); this step and everything after it re-run and overwrite
  /// their own outputs — so edits made to an upstream artifact via hijack
  /// chat finally propagate downstream. Valid only from a settled state
  /// (paused / done / aborted), never while a step is actively running.
  'flows:rerunFromStep': (args: { runId: UUID; stepId: string }) => { ok: true } | { ok: false; error: string };
  /// Adopt the projects added to this run's workspace since it launched —
  /// a worktree each, on the run's own branch, symlinked into the run's
  /// root. Additive only: existing members and their baselines are never
  /// touched. Resume and re-run already do this implicitly; this is the
  /// paused run's "the workspace grew" banner asking for it on its own, so
  /// the user can keep chatting in the same pause. Returns the member names
  /// actually adopted (short of what was pending means a repo failed to
  /// check out — see the log).
  'flows:adoptWorkspaceMembers': (args: {
    runId: UUID;
  }) => { ok: true; adopted: string[] } | { ok: false; error: string };
  /// Stop offering the "workspace grew" banner for the projects pending on
  /// this run right now. Records those paths, so a project added LATER still
  /// raises the banner for itself. Display-only: resume / re-run still adopt
  /// dismissed members. Returns the paths just dismissed.
  'flows:dismissWorkspaceMembers': (args: {
    runId: UUID;
  }) => { ok: true; dismissed: string[] } | { ok: false; error: string };
  /// Bring a single-project flow worktree into the main project checkout,
  /// then re-home every Claude participant session and persistently rebind
  /// the run's cwd so post-completion chat can continue there.
  'flows:checkoutRunLocally': (args: {
    runId: UUID;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string; stashed: boolean; autoCommitted: boolean } | { ok: false; error: string };
  'flows:abortRun': (args: { runId: UUID }) => { ok: true } | { ok: false; error: string };
  /// Put a completed run into the post-completion `watching` state — it
  /// stops doing work and periodically polls `binding` (via the named
  /// source + the user's own tools) for follow-up comments, answering them
  /// through `participantId`'s conversation. `instructions` is the natural-
  /// language description for the AI-defined source (`sourceId: 'ai'`).
  'flows:enterWatch': (args: {
    runId: UUID;
    sourceId: string;
    binding: string;
    instructions?: string;
    participantId?: string;
    pollIntervalSec?: number;
    ttlHours?: number;
  }) => { ok: true } | { ok: false; error: string };
  /// End a watched run (the watch off-switch). Also marks any other run
  /// `archived` as a clean terminal.
  'flows:archiveRun': (args: { runId: UUID }) => { ok: true } | { ok: false; error: string };
  /// All-time run tallies per flow id, from the same summary log the Usage
  /// page reads. Drives the library's most-used-first ordering — computed in
  /// main so a renderer with only the 50 retained runs doesn't undercount.
  'flows:runCounts': () => Record<string, { count: number; lastAt: number }>;
  /// List the registered watch sources for the watch-entry picker.
  'flows:listWatchSources': () => Array<{ id: string; displayName: string }>;
  /// Set (or clear) a per-participant model override on a live run. The
  /// override drives all subsequent turns for that participant. Pass
  /// `null` to revert to the declared model.
  'flows:setModelOverride': (args: {
    runId: UUID;
    participantId: string;
    model: string | null;
  }) => { ok: true } | { ok: false; error: string };
  /// Give a run its own display title (sidebar + library rows). Works at
  /// any point in a run's life — including mid-flight, which is when a
  /// user most wants to label what's in the list. Pass an empty string to
  /// clear it and fall back to the prompt-derived title.
  'flows:renameRun': (args: { runId: UUID; title: string }) => { ok: true } | { ok: false; error: string };
  /// Stamp "the user just typed at this run". Sent when a hijack turn goes
  /// out to a participant — the turn itself rides the generic `runner:send`
  /// path, which knows nothing about runs, so the run would otherwise have
  /// no record that the user drove it. Ordering-only; nothing in the runtime
  /// reads it.
  'flows:noteUserTurn': (args: { runId: UUID }) => { ok: true } | { ok: false; error: string };
  /// Queue a course correction to be injected at the top of the next step's
  /// prompt. Empty `text` withdraws a queued steer.
  'flows:steerRun': (args: { runId: UUID; text: string }) => { ok: true } | { ok: false; error: string };
  /// Permanently remove a run from memory + disk. Aborts mid-flight
  /// subprocesses if still running. Idempotent — deleting an unknown
  /// id returns ok.
  /// Pass `force: true` to skip the uncommitted-changes guard. Without it,
  /// a run whose worktree(s) have uncommitted changes returns
  /// `{ ok: false, needsConfirm: true, dirty }` and deletes nothing, so the
  /// renderer can warn before the work is discarded.
  'flows:deleteRun': (args: { runId: UUID; force?: boolean }) =>
    | { ok: true }
    | { ok: false; error: string }
    | {
        ok: false;
        needsConfirm: true;
        dirty: Array<{ name: string; worktreePath: string; fileCount: number }>;
      };
  'flows:listRegistries': () => FlowRegistry[];
  'flows:upsertRegistry': (args: {
    registry: FlowRegistry;
    authHeader?: string | null;
  }) => { ok: true } | { ok: false; error: string };
  'flows:removeRegistry': (args: { registryId: string }) => { ok: true } | { ok: false; error: string };
  'flows:browseRegistry': (args: { registryId?: string; force?: boolean }) => {
    ok: true;
    entries: FlowRegistryEntry[];
    errors: Array<{ registryId: string; error: string }>;
  };
  'flows:installFromRegistry': (args: {
    registryId: string;
    id: string;
    version: string;
  }) => { ok: true; filePath: string } | { ok: false; error: string };
  'flows:previewRegistryFlow': (args: {
    registryId: string;
    id: string;
    version: string;
  }) => { ok: true; flow: Flow } | { ok: false; error: string };

  // ---- Orchestrator (batch fan-out over flows) --------------------------
  /// Run one producer turn: ask the user's preferred AI (with its MCP
  /// tools) to investigate `message` and return a list of small,
  /// self-contained asks. The reply text is shown in the conversation
  /// pane; `candidates` is the parsed `<candidates>` block. `priorReply`
  /// carries the previous turn so a refinement ("only the docs ones")
  /// builds on context. Read-only — the producer never edits files.
  'orchestrator:propose': (args: {
    message: string;
    projectPath: string;
    priorPrompt?: string;
    priorReply?: string;
  }) => { ok: true; reply: string; candidates: Candidate[] } | { ok: false; error: string };
  /// Launch a batch: one child flow run per item, never more than
  /// `maxConcurrent` in flight. `runIn` decides where those runs work —
  /// `worktree` (the default) gives each item its own fresh worktree forked
  /// from `baseBranch`; `cwd` runs them in the project's own working tree,
  /// which forces `maxConcurrent` to 1 (one checkout can't host two agents)
  /// and ignores `baseBranch`. Returns the new orchestration id; progress
  /// streams back via `orchestrationUpdate`.
  'orchestrator:startBatch': (args: {
    title: string;
    projectPath: string;
    runIn?: RunIn;
    baseBranch?: string;
    maxConcurrent: number;
    producer?: { prompt: string; reply: string };
    items: Array<{
      candidate: Candidate;
      flowId: string;
      baseBranch?: string;
    }>;
  }) => { ok: true; orchestrationId: UUID } | { ok: false; error: string };
  /// All orchestrations (in-memory + restored), newest first.
  'orchestrator:list': () => Orchestration[];
  'orchestrator:get': (args: { id: UUID }) => Orchestration | null;
  /// Recent producer seed prompts (newest first) for the Ask pane's
  /// quick-pick. Only fresh asks are recorded — never refinements.
  'orchestrator:recentPrompts': () => RecentPrompt[];
  /// Record a fresh seed prompt. Dedupes by exact text + caps; returns the
  /// updated list.
  'orchestrator:recordRecentPrompt': (args: { text: string }) => RecentPrompt[];
  /// Forget one recent prompt by exact text. Returns the updated list.
  'orchestrator:deleteRecentPrompt': (args: { text: string }) => RecentPrompt[];
  /// Abort a whole batch: queued items become `cancelled`, running child
  /// runs are aborted. Idempotent.
  'orchestrator:abort': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// Re-queue failed/cancelled items. With `candidateId`, retry just that
  /// item; without, retry all failed/cancelled items in the batch. Each
  /// retry launches a fresh child run in a new worktree.
  'orchestrator:retry': (args: { id: UUID; candidateId?: string }) => { ok: true } | { ok: false; error: string };
  /// Permanently delete a batch record (does not touch the child runs'
  /// own history). Idempotent.
  'orchestrator:delete': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// Release a batch a schedule parked. Items named in `approve` are queued
  /// (with an optional flow remap); any other `proposed` item is cancelled.
  /// Omit `approve` to accept the whole batch as proposed.
  'orchestrator:approveBatch': (args: {
    id: UUID;
    approve?: Array<{
      candidateId: string;
      flowId?: string;
      baseBranch?: string;
    }>;
  }) => { ok: true; queued: number } | { ok: false; error: string };
  /// Reject ONE paused item — the per-item form of the decline that
  /// approveBatch applies to unpicked proposals. Settles the item to
  /// `cancelled`, which is what journals the rejection on a worker-origin
  /// batch and feeds the demotion streak. The child run is the CALLER's to
  /// delete first (via `flows:deleteRun`), so the dirty-worktree confirm
  /// stays in one place and a decline there leaves the item untouched.
  'orchestrator:rejectItem': (args: { id: UUID; candidateId: string }) => { ok: true } | { ok: false; error: string };

  // ---- Schedules --------------------------------------------------------
  /// Every schedule, newest first, each with its computed next fire time.
  /// `nextFireAt` is null for a disabled schedule.
  'schedules:list': () => Array<{
    schedule: Schedule;
    nextFireAt: number | null;
  }>;
  /// Create (no `id`) or replace (with `id`). Validates with the same
  /// `validateSchedule` the editor uses, so Save can never fail for a reason
  /// the form didn't already show.
  'schedules:save': (args: {
    schedule: Omit<Schedule, 'id' | 'createdAt' | 'history'> & { id?: UUID };
  }) => { ok: true; schedule: Schedule } | { ok: false; error: string };
  'schedules:setEnabled': (args: { id: UUID; enabled: boolean }) => { ok: true } | { ok: false; error: string };
  /// Delete the trigger. Any run it already started is left alone — it's real
  /// work in a real worktree.
  'schedules:delete': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// Fire once, right now, without touching the cadence. The way to check a
  /// schedule does what you think before trusting it to run unattended.
  'schedules:runNow': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };

  // ---- Workers (standing personas) --------------------------------------
  /// Every hired worker, newest first, each with its computed next shift time
  /// and its scorecard (both derived in main — the renderer never computes
  /// them, so they can't disagree with what the engine will actually do).
  'workers:list': () => Array<{
    worker: Worker;
    nextShiftAt: number | null;
    scorecard: WorkerScorecard;
  }>;
  /// Hire (no `id`) or update (with `id`). Validates with the same
  /// `validateWorker` the editor uses. Trust is not accepted here: hires
  /// start on probation, and promotion goes through `workers:setTrust`.
  'workers:save': (args: {
    worker: Omit<Worker, 'id' | 'createdAt' | 'trust'> & { id?: UUID };
  }) => { ok: true; worker: Worker } | { ok: false; error: string };
  /// Write a note against one of a worker's turns. It lands in the worker's
  /// journal, which means the worker reads it before planning its next shift
  /// — a note is a word in its ear, not a sticky on the screen.
  'workers:note': (args: {
    id: UUID;
    orchestrationId: string;
    note: string;
  }) => { ok: true } | { ok: false; error: string };
  'workers:setEnabled': (args: { id: UUID; enabled: boolean }) => { ok: true } | { ok: false; error: string };
  /// Which of the worker's own outputs renders when you open it: `newest`,
  /// `off`, or the filename of one of the outputs it actually produces.
  'workers:setAutoRender': (args: { id: UUID; autoRender: string }) => { ok: true } | { ok: false; error: string };
  /// The explicit promote/demote act — the only way trust goes UP.
  'workers:setTrust': (args: { id: UUID; trust: WorkerTrustLevel }) => { ok: true } | { ok: false; error: string };
  /// Fire the worker. Its parked batches, launched runs, and journal all
  /// survive — the persona is removed, not its output.
  'workers:delete': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// Work one shift right now, out of band. Advances the shift number but
  /// not the cadence.
  'workers:workShiftNow': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// Hand a worker a one-off instruction, planned through its standing job
  /// description without advancing its scheduled cadence.
  'workers:runErrand': (args: {
    id: UUID;
    instruction: string;
    intent: import('./flows/worker').WorkerMessageIntent;
    attachments?: Attachment[];
  }) => { ok: true; result: WorkerErrandResult } | { ok: false; error: string };
  /// Everything in the worker's own directory, newest first. Deliverables the
  /// engine filed there plus anything the worker wrote for itself.
  /// Persist the roster's reading order, top first. The full list, not a
  /// delta — see `WorkerEngine.reorder`. This is also the FUNDING order: the
  /// treasury pays workers down this list (see `workers:treasury`).
  'workers:reorder': (args: { ids: UUID[] }) => { ok: true };
  /// The monthly pool and the waterfall it produces across the roster. Both
  /// come from main because the allocation is priced against the run-summary
  /// log, and a renderer-side copy of that arithmetic could tell the user a
  /// worker was funded that the engine then refused to run.
  'workers:treasury': () => {
    treasury: Treasury;
    allocation: TreasuryAllocation;
  };
  /// What the roster has actually done — shifts, outcomes, tokens, time.
  /// `sinceMs` is an epoch-ms floor; 0 means all time.
  'workers:report': (args: { sinceMs: number }) => WorkerReport;
  /// Set the monthly pool every worker draws from.
  'workers:setTreasury': (args: { monthlyUSD: number }) => { ok: true } | { ok: false; error: string };
  /// Split the money left this month by funding order across enabled workers.
  'workers:distributeFunds': () =>
    | {
        ok: true;
        workers: Worker[];
        treasury: Treasury;
        allocation: TreasuryAllocation;
      }
    | { ok: false; error: string };
  'workers:files': (args: { id: UUID }) => {
    /// The worker's directory. The renderer scopes the file editor to this so
    /// opening a worker's file can't expose its neighbours — every worker's
    /// directory sits next to every other one under userData.
    root: string;
    files: Array<{
      name: string;
      path: string;
      bytes: number;
      modifiedAt: number;
    }>;
  };
  /// One file's contents. Refuses paths outside the worker's directory and
  /// files too large to preview.
  'workers:file': (args: { id: UUID; name: string }) => { ok: true; body: string } | { ok: false; error: string };
  /// Open the worker's directory in the OS file manager.
  /// The on-disk copies of one finished item's output, addressed by the same
  /// facts that filed them. The desk uses this to link a plan row straight at
  /// the files rather than reproducing main's naming rule in the renderer.
  'workers:deliverables': (args: {
    id: UUID;
    task: 'shift' | 'errand';
    /// The batch's ledger title — `[Shift 3] Warden` / `[Errand] …`.
    label: string;
    /// The candidate's title.
    title: string;
    /// When the item finished, which is the stamp the filing used.
    at: number;
  }) => Array<{
    name: string;
    path: string;
    bytes: number;
    modifiedAt: number;
  }>;
  /// Batched form of `workers:deliverables` — one round trip for every row a
  /// page renders instead of one per row. See renderer/deliverablesCache.ts.
  'workers:deliverablesBatch': (args: {
    requests: Array<{
      id: UUID;
      task: 'shift' | 'errand';
      label: string;
      title: string;
      at: number;
    }>;
  }) => Array<
    Array<{
      name: string;
      path: string;
      bytes: number;
      modifiedAt: number;
    }>
  >;
  /// Delete one job's output — a folder and its contents, or a loose file.
  /// `name` is relative to the worker's own root and is validated there.
  'workers:deleteFile': (args: {
    id: UUID;
    name: string;
  }) => { ok: true; removed: string } | { ok: false; error: string };
  'workers:revealFiles': (args: { id: UUID }) => { ok: true } | { ok: false; error: string };
  /// The worker's journal, newest first — its episodic memory, rendered as
  /// the shift history in the Workers pane.
  'workers:journal': (args: { id: UUID }) => WorkerJournalEntry[];
  /// Return this worker to a just-hired clean slate: remove its journal, files,
  /// shift/errand ledgers and child flow runs, then restart numbering at shift
  /// #1. Trust, budget, job description and historical usage spend remain.
  'workers:resetMemory': (args: { id: UUID }) =>
    | {
        ok: true;
        entries: number;
        files: number;
        shifts: number;
        errands: number;
        runs: number;
      }
    | { ok: false; error: string };
  /// Rub out ONE turn: its ledger, the flow runs it launched, the output they
  /// filed, and its journal entries. If it was the worker's most recent shift
  /// the number is handed back, so the next shift is that number again.
  /// `shiftGivenBack` is null when it wasn't (an errand, or an older shift).
  'workers:deleteActivity': (args: { id: UUID; orchestrationId: UUID }) =>
    | {
        ok: true;
        task: 'shift' | 'errand';
        /// What to call it in the confirmation — `Shift 7` / `that errand`.
        label: string;
        entries: number;
        files: number;
        runs: number;
        shiftGivenBack: number | null;
      }
    | { ok: false; error: string };
  /// Work the most recent shift again from the state it started in: delete
  /// what it did, hand its number back, and plan it afresh over the same
  /// window. Refuses anything but the latest shift — an older one cannot have
  /// its number back, so re-running it would silently be a new shift instead.
  'workers:redoShift': (args: {
    id: UUID;
    orchestrationId: UUID;
  }) => { ok: true; shift: number } | { ok: false; error: string };
  /// The worker as a shareable YAML document: the JOB, with the flows it
  /// launches embedded whole, and none of the employment — no id, no trust,
  /// no project path, no history. See src/shared/flows/workerYaml.ts.
  /// `missingFlowIds` are flows this worker references that the library can
  /// no longer supply, so the sender learns before the recipient does.
  'workers:share': (args: {
    id: UUID;
  }) => { ok: true; yaml: string; filename: string; missingFlowIds: string[] } | { ok: false; error: string };
  /// The same document, written wherever the user points the save dialog.
  /// `filePath: null` means they dismissed it — a cancel is not an error.
  'workers:shareToFile': (args: { id: UUID }) => { ok: true; filePath: string | null } | { ok: false; error: string };
  /// Read a share file: installs any flows the library is missing (never
  /// overwriting one it already has) and returns the worker to open in the
  /// hire editor. Hiring is still the user's click — this only prepares it.
  'workers:import': (args: { yaml: string }) =>
    | {
        ok: true;
        worker: PortableWorker;
        notes: WorkerImportNotes;
        summary: string;
      }
    | { ok: false; error: string };
  /// The same, from a file the user picks. `canceled` when they dismiss the
  /// dialog, which is neither a success to act on nor an error to show.
  'workers:importFromFile': () =>
    | { ok: true; canceled: true }
    | {
        ok: true;
        canceled?: false;
        worker: PortableWorker;
        notes: WorkerImportNotes;
        summary: string;
      }
    | { ok: false; error: string };
  /// One hire-drafter turn: a free-text job description in, a reviewed-not-
  /// saved contract out — plus a drafted Flow when no existing flow fit.
  /// `flowError` is set when a flow was asked for and the flow drafter
  /// failed: the contract is still reviewable, but the flow picker is empty
  /// on purpose and the review screen says why.
  'workers:draftFromPrompt': (args: {
    jobDescription: string;
    /// Files the user attached to the hire (a spec, an example deliverable,
    /// a screenshot). Sent to the drafting CLI alongside the description.
    attachments?: Attachment[];
  }) =>
    | {
        ok: true;
        contract: WorkerContract;
        summary: string;
        draftedFlow?: Flow;
        flowError?: string;
      }
    | { ok: false; error: string };
  /// One revision turn across a worker's two halves: the instruction is
  /// routed to the job description (planning), the flow (execution), or
  /// both. Nothing is saved — the editor shows both proposed halves and
  /// only its Save commits them.
  'workers:reviseFromPrompt': (args: {
    jobDescription: string;
    /// The worker's saved flow, by id.
    flowId?: string;
    /// An UNSAVED ride-along flow (hire-drafted, or already AI-revised),
    /// passed whole because main can't resolve it from disk yet. Takes
    /// precedence over `flowId` — it's the freshest state of the same flow.
    flow?: Flow;
    instruction: string;
    /// Files attached to the instruction — they ride with the routing turn
    /// and with any flow edit it delegates to.
    attachments?: Attachment[];
  }) => { ok: true; jobDescription?: string; flow?: Flow; note: string } | { ok: false; error: string };
}

/// One local subresource of an HTML preview. Stylesheets come back as
/// text (they get inlined into a `<style>` tag, with their own imports and
/// `url()` refs already folded in); everything else comes back as a data
/// URL that can be dropped straight into the attribute it came from.
export type HtmlPreviewAsset =
  { ok: true; kind: 'css'; text: string } | { ok: true; kind: 'data'; dataUrl: string } | { ok: false; error: string };

export type HtmlPreviewAssetsResult =
  /// Keyed by the ref exactly as it appeared in the document.
  { ok: true; assets: Record<string, HtmlPreviewAsset> } | { ok: false; error: string };

/// What happened to the Tailwind pass for a React preview. `not-used` is
/// a file with no className at all; `unavailable` is a project without
/// Tailwind installed — both are normal, and neither is an error.
export interface ReactPreviewTailwind {
  status: 'compiled' | 'not-used' | 'unavailable' | 'failed' | 'skipped';
  version?: number;
  message?: string;
}

export type ReactPreviewBundleResult =
  | {
      ok: true;
      /// A self-contained IIFE: React, the component, and its imports.
      js: string;
      /// CSS the component imported directly, already bundled.
      css: string;
      tailwindCss?: string;
      tailwind: ReactPreviewTailwind;
      /// The element the bundle mounts into; the shell must provide it.
      rootElementId: string;
      /// Whether the component was compiled against the project's React or
      /// Overcli's own copy — worth surfacing, since they can differ.
      reactSource: 'project' | 'overcli';
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      details?: string[];
      hint?: 'esbuild-missing' | 'react-missing' | 'build-failed';
    };

export type ArtifactPreviewResult =
  | {
      ok: true;
      kind: 'image';
      resolvedPath: string;
      sizeBytes: number;
      mimeType: string;
      dataUrl: string;
    }
  | {
      ok: true;
      kind: 'pdf';
      resolvedPath: string;
      sizeBytes: number;
      mimeType: string;
      fileUrl: string;
      dataUrl?: string;
    }
  | {
      ok: true;
      kind: 'office';
      resolvedPath: string;
      sizeBytes: number;
      extension: string;
      family: 'document' | 'spreadsheet' | 'presentation';
      convertedPdfDataUrl?: string;
      convertedPdfSizeBytes?: number;
      /// Quick Look renders Office documents to HTML rather than PDF, so the
      /// macOS fallback fills this instead of `convertedPdfDataUrl`.
      convertedHtml?: string;
      /// The deck's own slide size, used to scale `convertedHtml` to the pane.
      slideWidth?: number;
      slideHeight?: number;
      converterPath?: string;
      converterKind?: 'libreoffice' | 'quicklook' | 'office-com';
      conversionError?: string;
    }
  | { ok: false; error: string };

export type FileInfoResult =
  | {
      ok: true;
      resolvedPath: string;
      sizeBytes: number;
      tooLarge: boolean;
      largeText: boolean;
      unsupportedBinary: boolean;
      error?: string;
    }
  /// `missing` means the path resolved to nothing on disk — usually a file
  /// the agent deleted. The file view treats that as "show me the deletion
  /// diff", not as a hard error.
  | { ok: false; error: string; missing?: boolean };

/// One row in the documents view: a single level of a folder, with the
/// modified time a file card shows. Distinct from `FileTreeEntry` (a flat
/// recursive walk for the code tree) because browsing documents is a
/// folder-at-a-time activity.
/// One entry in an everyday project's version history — a commit, named for
/// the people who will read it rather than for git.
export interface ProjectVersionFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ProjectVersion {
  sha: string;
  /// ISO 8601, author date.
  at: string;
  subject: string;
  files: ProjectVersionFile[];
}

export interface DocumentEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

export interface FileTreeEntry {
  path: string;
  sizeBytes: number;
}

/// One possible definition site for a clicked symbol. Every candidate the
/// renderer receives has already been checked against disk in
/// `symbolLookup.verifyCandidate` — the path resolves inside the project
/// root, the line exists, and the line mentions the symbol.
export interface SymbolCandidate {
  /// Project-relative, for display.
  path: string;
  /// Absolute, for `openFile`.
  absolutePath: string;
  /// 1-based.
  line: number;
  /// The matched source line, trimmed — lets the picker show what it found
  /// without a second read.
  snippet: string;
  /// Which tier produced it: `grep` is the free ripgrep pre-filter,
  /// `model` a fast-model query.
  source: 'grep' | 'model';
}

export type SymbolLookupResult =
  | {
      ok: true;
      /// Most likely first. A single candidate means jump straight there;
      /// several means show a picker.
      candidates: SymbolCandidate[];
      via: 'grep' | 'model' | 'cache';
      /// Set when `via` is `model` — which rung of the ladder answered.
      model?: string;
      /// The grep tier answered but couldn't pick a winner, so a model
      /// could still narrow it down. The picker turns this into a "Refine"
      /// action (`symbols:refineDefinition`) rather than spending a model
      /// call the user didn't ask for — grep answers in ~20ms and the model
      /// tier costs seconds.
      refinable?: boolean;
    }
  | { ok: false; error: string };

export type ProjectPreviewHintsResult =
  | {
      ok: true;
      rootPath: string;
      packageManager: 'npm' | 'pnpm' | 'yarn';
      commands: ProjectPreviewCommand[];
    }
  | { ok: false; error: string };

export interface ProjectPreviewCommand {
  id: string;
  label: string;
  command: string;
  kind: 'dev' | 'storybook' | 'preview' | 'test';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SilentLogEntry {
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
  stack?: string;
}

export interface DailyBackendBucket {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface DailyBucket {
  /// YYYY-MM-DD key in local time. Days with no activity are still
  /// present with zero counts so the chart has continuous x-axis data.
  day: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  linesAdded: number;
  linesDeleted: number;
  /// Per-backend breakdown so the chart can render stacked bars. Keys
  /// match the `Backend` type. Missing keys = zero for that backend.
  byBackend?: Partial<Record<Backend, DailyBackendBucket>>;
}

export interface StatsReport {
  generatedAt: number;
  totalSessions: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  byBackend: BackendStats[];
  byProject: ProjectStats[];
  byModel: Array<{
    model: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  }>;
  byTier: TierStats[];
  quotas: BackendQuota[];
  flowImpact: FlowImpactStats;
  /// Last 365 days of activity for the stats-page chart, merged from the
  /// persisted daily snapshots so days whose transcripts have since been
  /// pruned are still in here.
  daily: DailyBucket[];
}

export type ModelTier = 'frontier' | 'thinking' | 'standard' | 'fast' | 'local';

export interface TierStats {
  tier: ModelTier;
  models: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface FlowImpactStats {
  totalRuns: number;
  completedRuns: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD: number;
  totalWallClockMs: number;
  byFlow: FlowImpactRow[];
}

export interface FlowImpactRow {
  flowId: string;
  flowName: string;
  runs: number;
  completedRuns: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  wallClockMs: number;
  lastRunAt: number;
}

export interface QuotaWindow {
  label: string;
  /// Real percentage when the CLI reports one; null when we can only
  /// count tokens ourselves.
  usedPercent: number | null;
  windowMinutes: number;
  /// Epoch ms when the window resets, when the CLI tells us.
  resetsAt: number | null;
  /// Pre-formatted reset text for CLIs that print a human string with no
  /// year (claude's `/usage`), where reconstructing an epoch would be
  /// guesswork. Shown verbatim when present.
  resetsLabel?: string;
  tokens: number;
}

export interface BackendQuota {
  backend: Backend;
  /// 'reported' = read from the CLI's own rate-limit payload.
  /// 'inferred' = counted from transcripts by us.
  source: 'reported' | 'inferred';
  /// True when `source` is 'reported' but the snapshot is old enough that the
  /// percentages may have moved since.
  stale?: boolean;
  planType?: string;
  /// Epoch ms the reported snapshot was written. 0 when inferred.
  capturedAt: number;
  windows: QuotaWindow[];
}

export interface BackendStats {
  backend: Backend;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  tokensLast5h: number;
  tokensLast24h: number;
  tokensLast7d: number;
  sessionsToday: number;
  lastActive?: number;
  linesAdded: number;
  linesDeleted: number;
}

export interface ProjectStats {
  id: string;
  name: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
  linesAdded: number;
  linesDeleted: number;
}

/// Main → renderer push events. The runner emits stream events here as they
/// come off the CLI's stdout. Events are tagged with the conversationId so
/// the renderer can route them to the right pane.
export type MainToRendererEvent =
  | {
      /// Live text from an in-flight document rewrite. The rewrite runs on
      /// the hidden one-shot transport, which has no conversation to stream
      /// into — without this the editor sits unchanged behind a spinner for
      /// the whole turn, which is the one place this app stops showing its
      /// work.
      type: 'documentRevise';
      requestId: string;
      text: string;
    }
  | {
      type: 'stream';
      conversationId: UUID;
      events: StreamEvent[];
    }
  | {
      type: 'running';
      conversationId: UUID;
      isRunning: boolean;
      activityLabel?: string;
    }
  | {
      type: 'error';
      conversationId: UUID;
      message: string;
    }
  | {
      type: 'sessionConfigured';
      conversationId: UUID;
      sessionId: string;
      rolloutPath?: string;
    }
  | {
      // Surfaces a captured reviewer session id (per backend) so the
      // renderer can persist it on the conversation under
      // `reviewerSessionIds[reviewBackend]`. The next time a review
      // fires for the same backend (this conversation, even after an
      // app restart), it gets passed back via runner:send so the
      // reviewer resumes its warm thread instead of cold-starting.
      // Today only `claude` ever fires this; the keyed shape keeps
      // room for codex/other backends to join later.
      type: 'reviewerSessionConfigured';
      conversationId: UUID;
      reviewBackend: Backend;
      sessionId: string;
    }
  | {
      type: 'codexRuntimeMode';
      conversationId: UUID;
      mode: 'proto' | 'exec' | 'app-server';
      sandbox: string;
      approval: string;
    }
  | {
      /// Notifies the renderer that overcli just fed a synthetic
      /// collab pingPrompt to the primary CLI. The renderer adds the
      /// hash to `Conversation.syntheticPrompts` and persists, so
      /// history replay can skip it instead of rendering the wrapped
      /// reviewer feedback as a misattributed user bubble.
      type: 'syntheticPrompt';
      conversationId: UUID;
      hash: string;
    }
  | {
      type: 'ollamaPull';
      event: OllamaPullEvent;
    }
  | {
      type: 'ollamaServerLog';
      line: OllamaServerLogLine;
    }
  | {
      type: 'ollamaServerStatus';
      status: OllamaServerStatus;
    }
  | {
      /// Flow run state transition — emitted whenever a run advances
      /// (step started/completed, paused, aborted, finished). The
      /// renderer's flowsStore reacts by patching its in-memory copy
      /// of the run; the active flow run pane re-renders.
      type: 'flowRunUpdate';
      run: FlowRun;
    }
  | {
      /// A step produced a named artifact. Bundled separately from the
      /// run update for fine-grained UI invalidation (the artifact panel
      /// updates without rebuilding the whole step list).
      type: 'flowArtifactProduced';
      runId: UUID;
      artifact: FlowArtifact;
    }
  | {
      /// A run was deleted from main. Renderer evicts it from its
      /// in-memory map so the library doesn't keep showing a ghost.
      type: 'flowRunDeleted';
      runId: UUID;
    }
  | {
      /// Progress of a flow launch's worktree preparation, before the run
      /// exists. Worktree checkout can take a few seconds (more for a
      /// multi-repo workspace), so the launching pane shows this under its
      /// spinner instead of a blank wait. Keyed by the launch target's
      /// `projectPath` (a pane guards its own in-flight launch, so two
      /// concurrent launches to the same target don't happen).
      type: 'flowLaunchProgress';
      projectPath: string;
      completed: number;
      total: number;
      message: string;
    }
  | {
      /// Progress of a Settings → Storage worktree scan. Inspecting a
      /// candidate means a `git status` walk plus a `du` over the tree, so a
      /// large install spends a minute or more here — the pane shows this
      /// rather than an unmoving spinner. `total` is the number of candidates
      /// left after live/foreign worktrees are ruled out, not every worktree
      /// found.
      type: 'worktreeScanProgress';
      completed: number;
      total: number;
    }
  | {
      /// Something changed under a watched explorer root (see
      /// `fs:watchTree`). Debounced in main and already filtered against the
      /// tree's skip list, so a tree seeing this should just relist itself.
      /// `root` is the resolved path returned by `fs:watchTree`.
      type: 'fileTreeChanged';
      root: string;
    }
  | {
      /// An orchestration (batch) changed — an item launched, a child run
      /// finished and the next pumped, or the batch completed. The
      /// renderer's orchestratorStore replaces its copy. Coarse-grained on
      /// purpose: a batch is small (a handful of items) so whole-record
      /// updates are cheap and keep the ledger trivially consistent.
      type: 'orchestrationUpdate';
      orchestration: Orchestration;
    }
  | {
      /// An orchestration record was deleted from main.
      type: 'orchestrationDeleted';
      id: UUID;
    }
  | {
      /// A schedule changed — saved, toggled, fired, or its run finished.
      /// Whole-record like `orchestrationUpdate`: a schedule is tiny and the
      /// consistency is worth more than the diffing. `nextFireAt` rides along
      /// because it's derived in main from the trigger and the last firing,
      /// and recomputing it in the renderer would let the two disagree.
      type: 'scheduleUpdate';
      schedule: Schedule;
      nextFireAt: number | null;
    }
  | {
      /// A schedule was deleted from main.
      type: 'scheduleDeleted';
      id: UUID;
    }
  | {
      /// A worker changed — hired, edited, promoted/demoted, toggled, worked
      /// a shift, or a verdict landed in its journal. Whole-record like
      /// `scheduleUpdate`; `nextShiftAt` and the scorecard ride along because
      /// both are derived in main (from the cadence and the journal) and
      /// recomputing them in the renderer would let the two disagree.
      type: 'workerUpdate';
      worker: Worker;
      nextShiftAt: number | null;
      scorecard: WorkerScorecard;
    }
  | {
      /// A worker was fired (deleted) from main.
      type: 'workerDeleted';
      id: UUID;
    }
  | {
      /// The pool, or anything that changes who it reaches: a reorder, a cap
      /// edit, a pause, a hire, a firing, or a run whose cost just landed.
      ///
      /// One event carrying the WHOLE allocation rather than a funding field
      /// on `workerUpdate`, because funding is not a property of a worker —
      /// one worker spending a dollar changes what every worker below it may
      /// draw, and N per-worker events would render a roster that briefly
      /// doesn't add up.
      type: 'treasuryUpdate';
      treasury: Treasury;
      allocation: TreasuryAllocation;
    }
  | {
      /// Live progress of the in-flight producer turn — the running
      /// assistant text and the tools it has invoked so far. Lets the
      /// Orchestrator's Ask pane stream the investigation like the chat
      /// interface instead of showing a blank spinner. Only one producer
      /// turn runs at a time. `workerId` is set when the turn is a worker's
      /// shift-planning pass — those stream to the Workers pane instead of
      /// the Ask pane.
      type: 'orchestrationProducerProgress';
      text: string;
      tools: string[];
      workerId?: UUID;
    }
  | {
      /// A worker's shift lifecycle: `active: true` when the planning turn
      /// starts (the row shows "working a shift"), `false` when the shift
      /// settles either way. The streaming text/tools ride on
      /// `orchestrationProducerProgress` with the same `workerId`.
      type: 'workerShiftProgress';
      workerId: UUID;
      active: boolean;
      /// Which entry point is running. Both a cadence shift and a typed errand
      /// stream through this event, and telling the user "working a shift"
      /// while they watch their own errand plan is simply wrong — main knows
      /// which it is, so it says so rather than making the UI guess.
      task?: 'shift' | 'errand';
    }
  /// Auto-updater lifecycle (see src/main/updater.ts). Not tied to a
  /// conversation — consumed by the global UpdateToast.
  | { type: 'update:available'; payload: { version: string } }
  | { type: 'update:progress'; payload: { percent: number } }
  | { type: 'update:downloaded'; payload: { version: string } };

export const DEFAULT_SETTINGS: AppSettings = {
  backendPaths: {},
  backendDefaultModels: {},
  flowModelDefaults: {},
  disabledBackends: {},
  defaultPermissionMode: 'plan',
  defaultEffort: '',
  backendDefaultEfforts: {},
  agentBranchPrefix: 'agent/',
  showCost: false,
  defaultShowToolActivity: false,
  autoDowngrade: true,
  theme: 'system',
  sidebarWidth: 260,
  editorPaneWidth: 540,
  explorerTreeWidth: 280,
  sidebarLayout: 'stream',
  showActiveSidebarSection: true,
  showDebug: false,
  claudeTransport: 'cli',
  claudeMcpDebug: false,
  starredFlows: [],
  defaultFlowRunIn: 'cwd',
  flowRegistries: [
    {
      id: 'official',
      name: 'Official',
      indexUrl: 'https://raw.githubusercontent.com/overcodelions/overcli-flow-registry/main/index.json',
    },
  ],
  installedRegistryFlows: [],
  updateChannel: 'stable',
  idleSessionTimeoutMinutes: 30,
};
