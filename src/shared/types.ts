// Shared type definitions used by both the Electron main process and the
// renderer. Modeled on the Swift app's Conversation / Project / StreamEvent
// types so the JSON persistence shape stays compatible where it can.

import type { Flow, FlowArtifact, FlowRun, FlowToolDescriptor } from './flows/schema';
import type { FlowTemplate } from './flows/templates';

export type UUID = string;
export type Backend = 'claude' | 'codex' | 'gemini' | 'ollama' | 'copilot';
export type PermissionMode = 'default' | 'plan' | 'auto' | 'acceptEdits' | 'bypassPermissions';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | '';

/// Curated rebound presets surfaced in the UI. 'custom' means the user
/// edited the underlying fields directly and we shouldn't try to pin a
/// preset name on the result. See `src/main/reboundPresets.ts` for the
/// source of truth on how each one resolves to backend/model/persona.
export type ReviewPreset =
  | 'half-finished'
  | 'security'
  | 'cheap-paranoid'
  | 'skeptical-user'
  | 'design-review'
  | 'independent'
  | 'custom';

/// Persona keys for the reviewer prompt preamble. The actual prompt
/// text lives in the same table — storing the key lets us tweak wording
/// without migrating saved conversations.
export type PersonaKey =
  | 'half-finished'
  | 'security'
  | 'critic'
  | 'skeptical-user'
  | 'design';

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
  | { type: 'easterEgg'; text: string; from: string }
  | { type: 'stderr'; line: string }
  | { type: 'parseError'; message: string }
  | { type: 'streamDelta' }
  | { type: 'other'; label: string };

export interface StreamEvent {
  id: string;
  timestamp: number;
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
  reviewer?: { backend: Backend; round: number; mode: 'review' | 'collab'; verdict?: boolean };
}

export interface Conversation {
  id: UUID;
  name: string;
  sessionId?: string;
  createdAt: number;
  lastActiveAt?: number;
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
  codexRolloutPath?: string;
  /// Every rollout file codex has created for this conversation. codex proto
  /// has no --resume, each spawn writes a fresh file — we merge on load.
  codexRolloutPaths?: string[];
  effortLevel?: EffortLevel;
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

/// One credential a catalog MCP server needs. Collected in overcli at
/// install time and written verbatim into the server's `env` block in
/// each target CLI's config (where the CLIs already read MCP env from).
export interface McpSecretField {
  /// Env var name, e.g. "BRAVE_API_KEY".
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
  | { type: 'progress'; tag: string; percent: number; completed: number; total: number; message?: string }
  | { type: 'done'; tag: string; success: boolean; message?: string };

export type OllamaServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface OllamaServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface FlowRegistry {
  id: string;          // slug
  name: string;
  indexUrl: string;    // https URL to index.json
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
  yamlUrl: string;     // absolute URL, resolved from index entry's yaml_url
}

export interface InstalledRegistryFlow {
  registryId: string;
  id: string;
  version: string;
  filename: string;    // basename under <userData>/flows/
}

export interface AppSettings {
  backendPaths: Partial<Record<Backend, string>>;
  backendDefaultModels: Partial<Record<Backend, string>>;
  /// Backends hidden/disabled in the UI. Disabled backends are not used as
  /// defaults and are skipped by health probes.
  disabledBackends: Partial<Record<Backend, boolean>>;
  /// Preferred default backend for new conversations and agents. If unset
  /// or disabled, falls back to the first enabled backend.
  preferredBackend?: Backend;
  defaultPermissionMode: PermissionMode;
  defaultEffort: EffortLevel;
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
  /// Sidebar shortcut strip for running/recent conversations.
  showActiveSidebarSection?: boolean;
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
  flowRegistries?: FlowRegistry[];
  installedRegistryFlows?: InstalledRegistryFlow[];
  /// Which auto-update feed the app follows. 'stable' tracks tagged
  /// releases (the `latest` channel); 'nightly' tracks the rolling nightly
  /// prerelease. The in-app updater is the single source of truth — whatever
  /// build you installed, this setting decides what it upgrades to.
  updateChannel?: 'stable' | 'nightly';
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
  };
  'store:saveProjects': (projects: Project[]) => void;
  'store:saveWorkspaces': (workspaces: Workspace[]) => void;
  'store:saveColosseums': (colosseums: Colosseum[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;
  'store:saveSelection': (id: UUID | null) => void;
  /// Quit and install a downloaded update now (triggered from UpdateToast).
  'update:quitAndInstall': () => void;
  'runner:send': (args: {
    conversationId: UUID;
    prompt: string;
    backend: Backend;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    sessionId?: string;
    effortLevel?: EffortLevel;
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
  'runner:stop': (args: { conversationId: UUID }) => void;
  'runner:newConversation': (args: { conversationId: UUID }) => void;
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
  'runner:probeHealth': (backend: Backend) => BackendHealth;
  'runner:listInstalledReviewers': () => Record<string, boolean>;
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
  'skills:uninstallByPath': (args: {
    path: string;
  }) => { ok: true } | { ok: false; error: string };
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
  }) =>
    | { ok: true; written: Backend[]; errors: string[] }
    | { ok: false; error: string };
  /// Curated MCP catalog: list entries with per-CLI installed status.
  'mcp:listCatalog': () => McpCatalogItem[];
  /// Install a catalog entry into the given CLIs, merging any collected
  /// secrets into the server's `env` block. Partial success via `written`
  /// + `errors`, same shape as `capabilities:addMcp`.
  'mcp:installCatalog': (args: {
    id: string;
    targets: Backend[];
    secrets?: Record<string, string>;
  }) =>
    | { ok: true; written: Backend[]; errors: string[] }
    | { ok: false; error: string };
  /// Remove a catalog entry from the given CLIs.
  'mcp:uninstallCatalog': (args: { id: string; targets: Backend[] }) =>
    | { ok: true; removed: Backend[]; errors: string[] }
    | { ok: false; error: string };
  /// Trigger a remote MCP server's OAuth login. Only Codex supports this
  /// (spawns `codex mcp login <name>`); Claude/Gemini return a message
  /// pointing at their in-session login.
  'mcp:login': (args: { cli: Backend; name: string }) =>
    | { ok: true; output: string }
    | { ok: false; error: string; output?: string };
  'fs:pickDirectory': () => string[] | null;
  'fs:fileInfo': (args: { path: string; rootPath?: string }) => FileInfoResult;
  'fs:readFile': (args: { path: string; rootPath?: string }) =>
    | { ok: true; content: string; resolvedPath: string }
    | { ok: false; error: string };
  'fs:readLargeTextPreview': (args: { path: string; rootPath?: string }) =>
    | { ok: true; content: string; resolvedPath: string; truncated: boolean; totalBytes: number; previewBytes: number }
    | { ok: false; error: string };
  'fs:readArtifactPreview': (args: { path: string; rootPath?: string }) => ArtifactPreviewResult;
  'fs:writeFile': (args: { path: string; content: string }) => { ok: true } | { ok: false; error: string };
  'fs:listFiles': (root: string) => string[];
  'fs:listFileEntries': (root: string) => FileTreeEntry[];
  'fs:openInFinder': (path: string) => void;
  'fs:openPath': (path: string) => { ok: true } | { ok: false; error: string };
  /// Write a flow artifact's body to a temp file and open it with the OS
  /// default app. Flow artifacts live only in memory (no on-disk path), so
  /// this materializes one on demand. `kind` picks the file extension.
  'flows:openArtifact': (args: {
    name: string;
    kind: 'markdown' | 'diff' | 'text' | 'url';
    body: string;
  }) => { ok: true } | { ok: false; error: string };
  'preview:projectHints': (args: { path: string; rootPath?: string }) => ProjectPreviewHintsResult;
  'preview:runProjectCommand': (args: {
    cwd: string;
    command: string;
  }) => { ok: true } | { ok: false; error: string };
  'git:run': (args: { args: string[]; cwd: string }) => {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
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
  'git:checkoutAgentLocally': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    commitSubject: string;
    commitBody?: string;
    /// When present, relocate the Claude session file from the worktree's
    /// cwd slug to the project's cwd slug so history + --resume survive.
    sessionId?: string;
  }) =>
    | { ok: true; message: string; stashed: boolean; autoCommitted: boolean }
    | { ok: false; error: string };
  'git:listBaseBranches': (projectPath: string) => string[];
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
  }) => WorktreeStatus;
  'git:rescueMainTree': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:commitStatus': (args: { cwd: string }) => {
    isRepo: boolean;
    currentBranch: string;
    changes: Array<{ path: string; status: string; additions: number; deletions: number }>;
    insertions: number;
    deletions: number;
  };
  'git:currentBranch': (args: { cwd: string }) => { isRepo: boolean; branch: string };
  'git:workspaceCommitStatus': (args: { projects: Array<{ name: string; path: string }> }) => {
    isRepo: boolean;
    currentBranch: string;
    changes: Array<{ path: string; status: string; additions: number; deletions: number }>;
    insertions: number;
    deletions: number;
  };
  'git:commitAll': (args: { cwd: string; message: string }) =>
    | { ok: true; sha: string; subject: string }
    | { ok: false; error: string };
  'git:workspaceCommitAll': (args: {
    projects: Array<{ name: string; path: string }>;
    message: string;
  }) =>
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
    projects: Array<{ name: string; projectPath: string; branchName?: string | null }>;
  }) => { ok: true; rootPath: string } | { ok: false; error: string };
  'workspace:removeCoordinatorSymlinkRoot': (
    coordinatorId: UUID,
  ) => { ok: true } | { ok: false; error: string };
  'auth:openCliLogin': (backend: Backend) => { ok: true } | { ok: false; error: string };
  'terminal:popConversation': (args: {
    cwd: string;
    backend: Backend;
    sessionId?: string;
  }) => { ok: true } | { ok: false; error: string };
  'app:openExternal': (url: string) => void;
  'app:showAbout': () => void;
  'app:reloadStats': () => StatsReport;
  /// Notify the OS that an agent finished while the app wasn't focused.
  /// macOS: dock bounce. Windows/Linux: taskbar flash. No-op when the
  /// window is already focused. Debounced in main to avoid a chain of
  /// bounces when many agents finish in quick succession.
  'app:notifyCompleted': () => void;
  'ollama:detect': () => OllamaDetectionReport;
  'ollama:hardware': () => OllamaHardwareReport;
  'ollama:catalog': () => OllamaRecommendedModel[];
  'ollama:install': () => { started: 'brew' | 'browser'; detail?: string };
  'ollama:startServer': () => { ok: boolean; message: string };
  'ollama:stopServer': () => void;
  'ollama:serverStatus': () => { status: OllamaServerStatus; log: OllamaServerLogLine[] };
  'ollama:pullModel': (args: { tag: string }) => { ok: true } | { ok: false; error: string };
  'ollama:cancelPull': (args: { tag: string }) => void;
  'ollama:deleteModel': (args: { tag: string }) => { ok: true } | { ok: false; error: string };
  'ollama:deleteSession': (sessionId: string) => void;
  'diagnostics:list': () => SilentLogEntry[];
  'diagnostics:clear': () => void;
  'diagnostics:log': (args: { level: LogLevel; scope: string; message: string }) => void;
  /// Flows — see src/shared/flows/. Library is the user-global +
  /// project-local YAML files; runs are in-memory state machines that
  /// drive a sequence of step Conversations.
  'flows:list': (args: { projectPaths?: string[] }) => Flow[];
  'flows:save': (args: {
    flow: Flow;
    target: 'user' | 'project';
    /// Required when target === 'project'. The flow file is written to
    /// <projectPath>/.overcli/flows/<flow.id>.yaml.
    projectPath?: string;
  }) => { ok: true; filePath: string } | { ok: false; error: string };
  'flows:delete': (args: {
    flowId: string;
    source: 'user' | 'project';
    projectPath?: string;
  }) => { ok: true } | { ok: false; error: string };
  'flows:validate': (args: { yaml: string; id?: string }) =>
    | { ok: true; flow: Flow }
    | { ok: false; errors: Array<{ path: string; message: string }> };
  'flows:toolCatalog': (args: { backend: Backend }) => FlowToolDescriptor[];
  /// Bundled-with-the-app curated templates shown in the "+ New flow"
  /// picker. Not part of the user/project library — these are immutable
  /// starting points; selecting one clones it into a fresh editor draft.
  'flows:listTemplates': () => FlowTemplate[];
  /// Draft a flow from a natural-language description using Claude. The
  /// renderer surfaces this behind a "✨ Describe a flow" button. On
  /// success, the user drops into the editor with the generated draft.
  'flows:draftFromPrompt': (args: { description: string }) =>
    | { ok: true; flow: Flow }
    | { ok: false; error: string };
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
    | { ok: false; error: string; preflight?: { problems: Array<{ path: string; message: string; hint?: string }> } };
  'flows:listRuns': () => FlowRun[];
  'flows:getRun': (args: { runId: UUID }) => FlowRun | null;
  'flows:resumeRun': (args: {
    runId: UUID;
    /// Optional per-artifact overrides. Each key/value replaces the
    /// artifact body in the run's artifact map before the next step
    /// reads its inputs. Used by the pause-card "edit artifact" affordance.
    editedArtifacts?: Record<string, string>;
  }) => { ok: true } | { ok: false; error: string };
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
  /// Permanently remove a run from memory + disk. Aborts mid-flight
  /// subprocesses if still running. Idempotent — deleting an unknown
  /// id returns ok.
  'flows:deleteRun': (args: { runId: UUID }) => { ok: true } | { ok: false; error: string };
  'flows:listRegistries': () => FlowRegistry[];
  'flows:upsertRegistry': (args: { registry: FlowRegistry; authHeader?: string | null }) =>
    { ok: true } | { ok: false; error: string };
  'flows:removeRegistry': (args: { registryId: string }) =>
    { ok: true } | { ok: false; error: string };
  'flows:browseRegistry': (args: { registryId?: string; force?: boolean }) =>
    { ok: true; entries: FlowRegistryEntry[]; errors: Array<{ registryId: string; error: string }> };
  'flows:installFromRegistry': (args: { registryId: string; id: string; version: string }) =>
    { ok: true; filePath: string } | { ok: false; error: string };
  'flows:previewRegistryFlow': (args: { registryId: string; id: string; version: string }) =>
    { ok: true; flow: Flow } | { ok: false; error: string };
}

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
      converterPath?: string;
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
  | { ok: false; error: string };

export interface FileTreeEntry {
  path: string;
  sizeBytes: number;
}

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
  flowImpact: FlowImpactStats;
  /// Last 90 days of activity for the stats-page chart.
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
  /// Auto-updater lifecycle (see src/main/updater.ts). Not tied to a
  /// conversation — consumed by the global UpdateToast.
  | { type: 'update:available'; payload: { version: string } }
  | { type: 'update:progress'; payload: { percent: number } }
  | { type: 'update:downloaded'; payload: { version: string } };

export const DEFAULT_SETTINGS: AppSettings = {
  backendPaths: {},
  backendDefaultModels: {},
  disabledBackends: {},
  defaultPermissionMode: 'plan',
  defaultEffort: '',
  agentBranchPrefix: 'agent/',
  showCost: false,
  defaultShowToolActivity: false,
  autoDowngrade: true,
  theme: 'system',
  sidebarWidth: 260,
  editorPaneWidth: 540,
  explorerTreeWidth: 280,
  showActiveSidebarSection: true,
  showDebug: false,
  claudeTransport: 'cli',
  claudeMcpDebug: false,
  starredFlows: [],
  flowRegistries: [
    { id: 'official', name: 'Official', indexUrl: 'https://raw.githubusercontent.com/overcodelions/overcli-flow-registry/main/index.json' },
  ],
  installedRegistryFlows: [],
  updateChannel: 'stable',
};
