// Flow definitions and runtime state. Flows are an alternate session-entry
// primitive: instead of picking a single backend/model/permission combo for a
// conversation, a Flow defines a sequence of LLM steps with per-step model +
// tools + role, optional rebound critique, and artifact handoff. Premium
// models plan/review, local Ollama models build/test.
//
// A Flow lives on disk as YAML (round-tripped via ./yaml.ts). A FlowRun is the
// in-memory + persisted state of one execution of a Flow; each step backs onto
// a real (hidden) Conversation so the existing runner/reviewer/stream UI just
// works.

import type { Backend, ModelUsage, PermissionMode, PersonaKey, UUID } from '../types';

/// Built-in role presets surface as a friendly picker in the builder UI and
/// resolve to default system prompts at run time (see ./roles.ts). `'custom'`
/// means the user typed their own prompt; the preset name no longer applies.
export type FlowRolePreset =
  | 'planner'
  | 'implementer'
  | 'plan-reviewer'
  | 'reviewer'
  | 'test-writer'
  | 'researcher'
  | 'shipper'
  | 'technical-writer'
  | 'editor'
  | 'debugger'
  | 'code-reader'
  | 'code-reviewer'
  | 'security-reviewer'
  | 'adversarial-reviewer'
  | 'custom';

/// Backend + model selection. Models are strings here on purpose so the
/// schema doesn't need a migration every time a new model ships — the
/// builder UI picks from a live registry.
export interface FlowModelRef {
  backend: Backend;
  model: string;
}

/// A participant in the flow — the conceptual "Primary" / "Worker" /
/// "Reviewer" roles users actually think in, decoupled from any
/// particular step. Each participant gets ONE persistent conversation
/// across all steps it owns, so memory + context carry forward naturally
/// (the planner remembers its plan when it later reviews the diff). The
/// user can switch to any participant's tab in the run UI and chat with
/// it directly ("hijack").
export interface FlowParticipant {
  /// Stable id referenced by `step.participantId`. Lowercase slug.
  id: string;
  /// Friendly name shown in tabs and the builder ("Primary", "Worker").
  name: string;
  backend: Backend;
  model: string;
  /// Conceptual role — drives default coloring in the UI and ordering of
  /// tabs. 'custom' means none of the above; arbitrary participant.
  kind?: 'primary' | 'worker' | 'reviewer' | 'custom';
}

/// Standard participant id every auto-migrated old flow uses for the
/// first synthesized participant. Stable so re-saves produce the same
/// YAML round-trip.
export const DEFAULT_PARTICIPANT_ID = 'primary' as const;

/// Per-step rebound config. Maps onto the existing ReviewerManager: the
/// `critic` model is what overcli already calls "reviewBackend/reviewModel",
/// and `mode` mirrors the existing review/collab modes. `maxIters` caps how
/// many rounds the critic gets before the step has to move on.
export interface FlowReboundConfig {
  critic: FlowModelRef;
  mode: 'review' | 'collab';
  maxIters: number;
  persona?: PersonaKey;
}

/// What to do when a step fails (hard error or rebound exhausted without an
/// approval). `pause` (default) leaves the run paused so the user can decide;
/// `goto` re-runs a named earlier step up to `maxRetries` times; `abort`
/// terminates the run.
export type FlowFailureAction =
  | { action: 'pause' }
  | { action: 'goto'; target: string; maxRetries: number }
  | { action: 'abort' };

export interface FlowStep {
  /// Stable id used in `inputs` references and `on_fail.target`. Slug-like.
  id: string;
  /// Which participant runs this step. After migration this is the
  /// authoritative model assignment; `model` below is retained on the
  /// type for the legacy code path that wrote step-level model directly
  /// before participants existed. The loader synthesizes participants
  /// when only `model` is present so both forms read cleanly.
  participantId: string;
  /// LEGACY. Old-format flows specify the model per step; the loader
  /// synthesizes a participant for each unique backend+model and points
  /// `participantId` at it. Kept on the type so existing flow files
  /// round-trip without losing data. New flows should leave this empty
  /// and rely on `participantId`.
  model?: FlowModelRef;
  role: FlowRolePreset;
  /// When set, overrides the preset prompt. Setting this from the builder
  /// flips `role` to `'custom'`.
  systemPromptOverride?: string;
  /// Refs to artifact names produced by earlier steps, or the sentinel
  /// `'user_prompt'` for the run's input. Order-preserving — the runtime
  /// concatenates them into the step's user message in this order.
  inputs: string[];
  /// Tool ids the step is allowed to call. Surfaces in the picker as
  /// checkboxes; the runtime translates to backend-specific flags.
  tools: string[];
  /// Permission mode the step's underlying conversation should run in.
  /// Defaults applied by the runtime if absent — typically `acceptEdits`
  /// for steps with write/bash tools, `default` otherwise.
  permissionMode?: PermissionMode;
  rebound?: FlowReboundConfig;
  onFail?: FlowFailureAction;
  /// When true, the runtime pauses BEFORE entering this step. The just-
  /// finished prior step's conversation remains live and resumable — the
  /// user can keep chatting with it (ask follow-ups, redirect, give more
  /// context) just like a normal conversation. On `continue`, the prior
  /// step's artifact is re-extracted from the latest assistant message so
  /// any changes made via conversation propagate forward. The first step
  /// ignores this (no prior conversation to converse with).
  pauseBefore?: boolean;
  /// Name of the artifact this step produces (e.g. `'plan.md'`, `'diff'`,
  /// `'review.md'`, `'pr_url'`). Referenced by later steps' `inputs`.
  output: string;
}

/// A flow definition. Round-trips to/from YAML via ./yaml.ts.
export interface Flow {
  /// Stable id — typically the file basename without `.yaml`.
  id: string;
  name: string;
  description?: string;
  /// What feeds the run's `user_prompt` artifact. v1 only supports the
  /// literal `'user_prompt'` (a free-text input collected at launch). Future
  /// values can be `jira:<ticket>`, `file:<path>`, etc.
  input: 'user_prompt';
  /// Optional text prefilled into the launch composer when this flow is
  /// run. Users can edit it before launching. Round-trips to YAML as
  /// `default_prompt`. Absent when the flow has no canned prompt.
  defaultPrompt?: string;
  /// Declared participants for the flow. Steps reference these by id.
  /// Every flow has at least one participant after load; the loader
  /// synthesizes them from per-step models for old-format flows.
  participants: FlowParticipant[];
  steps: FlowStep[];
  /// Resolved at load time — where this flow was read from.
  source: 'user' | 'project';
  /// Absolute path on disk. Re-saves write back to this path.
  filePath: string;
}

/// A typed artifact a step produced. `body` is the raw text for markdown/text/
/// diff and a URL string for `kind: 'url'`.
export type FlowArtifactKind = 'markdown' | 'diff' | 'text' | 'url';

export interface FlowArtifact {
  name: string;
  kind: FlowArtifactKind;
  body: string;
  producedByStepId: string;
  producedAt: number;
}

/// Per-step run history. Records each attempt + its outcome so the run pane
/// can show "build failed, retried, then succeeded" timelines.
export interface FlowStepAttempt {
  startedAt: number;
  endedAt?: number;
  conversationId: UUID;
  /// Result of this attempt:
  /// - `success`: produced its output artifact cleanly.
  /// - `reboundExhausted`: critic never approved within maxIters.
  /// - `error`: hard failure (subprocess crashed, output parse failed, …).
  /// - `aborted`: user aborted the run mid-step.
  outcome?: 'success' | 'reboundExhausted' | 'error' | 'aborted';
  errorMessage?: string;
  reboundRounds?: number;
  /// Accumulated token usage for this attempt. Summed from `assistant`
  /// stream events' `usage` block. Absent when the backend doesn't
  /// report usage (Ollama, in some configurations).
  usage?: ModelUsage;
  /// Cumulative cost in USD as reported by the CLI's last `result`
  /// event on this step's conversation. Absent for backends that
  /// don't price (Ollama) or don't report (some CLIs).
  costUSD?: number;
  /// The artifact this attempt produced, as it should be DISPLAYED in the
  /// run UI. For diff-kind outputs this body is the step's INCREMENTAL
  /// change (what this step alone touched), which differs from the
  /// cumulative diff kept in `FlowRun.artifacts[name]` (that one is what
  /// gets handed to downstream steps as input). Storing it per-attempt
  /// lets the UI show each step's own contribution instead of re-looking
  /// up the name-keyed map, where multiple steps that share an output
  /// name (e.g. two steps both producing `diff`) would otherwise collide.
  artifact?: FlowArtifact;
}

/// The "stewardship tail" of a run. After a flow's work is done, the user
/// can put the run into a `watching` state: it stops doing work and instead
/// periodically polls an external source (a Jira ticket, a PR, a Zendesk
/// case, …) for new comments and ANSWERS them — reusing the participant's
/// existing conversation, so it replies with full context of the work it
/// did. It never does fresh work; if a comment actually requests work it
/// escalates (notifies the user) and keeps watching. The user ends it by
/// archiving the run. This struct is the persisted state of one such watch.
export interface WatchState {
  /// Which WatchSource drives this watch (e.g. `'jira'`, `'github-pr'`,
  /// `'generic'`). Resolved against the source registry at tick time so a
  /// run persisted under an unknown id degrades to the generic source
  /// rather than crashing.
  sourceId: string;
  /// What's being watched, in the source's own addressing scheme — a Jira
  /// key (`'PROJ-123'`), a PR URL, a Zendesk id, or free text for the
  /// AI-defined source.
  binding: string;
  /// Free-text, natural-language description of WHAT to watch and HOW to
  /// respond — written by the user (optionally AI-drafted). This is what
  /// makes a watch definable without a dedicated integration: the watcher
  /// is an LLM with tools, so a clear description plus whatever tools the
  /// user has (MCP, web fetch, gh, …) is enough. Named sources (Jira, …)
  /// are just presets that pre-phrase this; the `ai` source relies on it
  /// entirely. Folded into every tick prompt.
  instructions?: string;
  /// Participant whose persistent conversation answers comments. Reusing a
  /// participant means the watcher already holds the full context of the
  /// work the flow did, so its answers are grounded, not cold.
  participantId: string;
  /// Model for the cheap "detect" pass that runs on EVERY tick (poll the
  /// source, diff against the cursor, decide if anything genuinely needs a
  /// reply). Most ticks are no-ops, so this is a fast/cheap same-backend
  /// model. When a tick finds a real question, the runtime escalates to the
  /// participant's full model for the grounded "answer" pass. Absent → ticks
  /// just run on the participant's model (no tiering).
  watchModel?: string;
  /// Comment ids the watcher has actually replied to — the dedup set, and the
  /// ONLY thing gating re-answers (there is deliberately no high-water cursor).
  /// Each tick re-scans the recent thread and answers any genuinely-unanswered
  /// question whose id isn't in here, so a question that was skipped or blocked
  /// stays answerable and is simply re-detected next tick rather than getting
  /// stranded behind an advancing marker. Capped by the runtime.
  answeredIds?: string[];
  /// Poll cadence in milliseconds. Floored by the runtime so a stray small
  /// value can't busy-loop the source's API.
  pollIntervalMs: number;
  /// Wall-clock (ms epoch) of the last completed tick. Absent before the
  /// first one. The sweep fires the next tick at `lastTickAt + pollIntervalMs`.
  lastTickAt?: number;
  /// Auto-archive deadline (ms epoch). Absent = watch until the user
  /// archives manually. A watcher past its deadline is archived on the
  /// next sweep so a forgotten watch can't poll forever.
  expiresAt?: number;
  /// Running count of comments answered across all ticks. Surfaced in the UI.
  answered: number;
  /// Set once the watcher has flagged that a comment needs real work and
  /// the user has been notified. The run stays `watching` (it still answers
  /// questions), but the UI shows the escalation so the user knows to step
  /// back in.
  escalated: boolean;
  /// Set when the watcher is stuck unable to reach the source's tools even at
  /// the top of the detect model ladder, and the user has been notified once.
  /// Cleared as soon as a tick reaches the tools again, so the "can't reach
  /// tools" notification fires once per stuck streak rather than every tick.
  toolsUnreachable?: boolean;
  /// One-line, human-readable summary of what the most recent tick saw or
  /// did. Surfaced in the watch banner.
  lastNote?: string;
  /// Append-only log of every completed tick (oldest first), capped by the
  /// runtime. This is what makes a watch *readable*: the user can open it
  /// and see each check — when it ran, what it saw, how many comments it
  /// answered, and whether it escalated — rather than just a running total.
  log?: WatchTickLogEntry[];
}

/// One entry in a watch's tick log — a single poll cycle's outcome.
export interface WatchTickLogEntry {
  /// When the tick completed (ms epoch).
  at: number;
  /// Comments answered in this tick.
  answered: number;
  /// Whether this tick flagged that a comment needs real work.
  needsWork: boolean;
  /// One-line summary of what this tick saw or did.
  note: string;
}

export type FlowRunState =
  | { kind: 'running'; currentStepId: string }
  | { kind: 'paused'; nextStepId: string; reason: 'preStep' | 'failure' }
  | { kind: 'done'; success: boolean }
  | { kind: 'aborted' }
  /// Post-completion stewardship tail — see WatchState. Reached from `done`
  /// when the user opts the run into watching; left via `archived`.
  | { kind: 'watching'; watch: WatchState }
  /// Terminal end of a watched run. Keeps the final WatchState so the UI can
  /// still show "answered N comments" after the watch is closed.
  | { kind: 'archived'; watch?: WatchState };

export interface FlowRun {
  id: UUID;
  flowId: string;
  /// Snapshot of the flow at launch time — flows can be edited after a run
  /// starts, and we want the run to keep using the version it began with.
  flowSnapshot: Flow;
  /// The cwd every step runs in. For runs launched with `runIn: 'cwd'`
  /// this is the project/workspace root verbatim; for `runIn: 'worktree'`
  /// this is the fresh worktree path (and `sourceProjectPath` records
  /// where the worktree was forked from).
  projectPath: string;
  userPrompt: string;
  /// participantId → backing Conversation id. Each participant gets ONE
  /// persistent Conversation across every step it runs, so the planner
  /// remembers its plan when it later reviews, and the user can hijack a
  /// participant from any tab to chat directly with it. Conversations are
  /// created with `hidden: true` so they don't show up in the sidebar.
  conversationIds: Record<string, UUID>;
  /// Per-participant model override applied AFTER launch. Keyed by
  /// participantId → model id (same backend as the participant's declared
  /// model — the picker only offers same-backend choices). When present it
  /// becomes the participant's effective model for everything the rest of
  /// the run does: step orchestration, the synthetic finalize turn,
  /// answering questions the model asks, and hijack chat. Lets the user
  /// bump a struggling small model mid-run without re-running the flow.
  /// Persisted with the run, so the upgrade survives an app restart.
  /// `resolveRunStepModel` / `effectiveParticipantModel` are the readers.
  modelOverrides?: Record<string, string>;
  artifacts: Record<string, FlowArtifact>;
  state: FlowRunState;
  createdAt: number;
  /// Per-step attempts, in order. A step that ran twice via `on_fail.goto`
  /// has two entries.
  attempts: Array<{ stepId: string } & FlowStepAttempt>;
  /// Set when the run was launched with `runIn: 'worktree'`. Absent for
  /// runs that share the project's main checkout. The renderer uses these
  /// to surface the worktree's branch + offer review/merge actions on a
  /// completed run.
  worktreePath?: string;
  branchName?: string;
  /// Branch the worktree(s) were forked from (single project AND every
  /// member of a workspace worktree run share one base). Persisted so the
  /// review/merge UI can run `git diff <baseBranch>`, status, rebase and
  /// merge-to-base without re-deriving it. Absent for `runIn: 'cwd'` runs.
  baseBranch?: string;
  /// Original project the worktree was forked from. Same as `projectPath`
  /// for non-worktree runs (omitted when redundant).
  sourceProjectPath?: string;
  /// `git rev-parse HEAD` captured at the moment the run started, in the
  /// run's cwd. Used to compute real `git diff <baselineCommit>` output
  /// for `diff`-kind artifacts so they reflect what actually changed on
  /// disk rather than whatever the model dumped into its `<output>`
  /// block. Absent for runs in non-git cwds (the diff falls back to the
  /// model's output in that case).
  baselineCommit?: string;
  /// For workspace runs whose `projectPath` is the workspace's symlink
  /// root (not itself a git repo), capture each member project's HEAD
  /// keyed by the same symlink name `workspaceCommitStatus` uses. The
  /// diff is built by running `git diff <baseline>` in each member and
  /// concatenating with the prefix, so the artifact reflects ALL repos
  /// the flow touched — not just one.
  baselineCommitsByMember?: Record<string, { path: string; commit: string }>;
  /// Per-participant CLI session id, captured from the first
  /// `sessionConfigured` event each step emits. Persisted so that on
  /// app restart the renderer can resume the participant's transcript
  /// via `runner:loadHistory` (which needs `{backend, projectPath,
  /// sessionId}`) — without this the chat panel only shows the artifact
  /// and the user can't see what the model actually said. Keyed by
  /// participantId to mirror `conversationIds`.
  sessionIdsByParticipant?: Record<string, string>;
  /// For workspace runs launched with `runIn: 'worktree'`: one worktree
  /// per member project, surfaced through a coordinator symlink root
  /// (which becomes the run's `projectPath`). Tracked here so the run
  /// can capture per-member baselines for diff aggregation and so a
  /// future "clean up worktrees" action knows what to remove.
  workspaceWorktrees?: Array<{
    name: string;
    projectPath: string;
    worktreePath: string;
    branchName: string;
  }>;
  /// Set while a Continue click is being processed and the runtime is
  /// round-tripping a synthetic "finalize" turn through the prior step's
  /// participant before advancing. Cleared once the next step actually
  /// starts (or on abort). The renderer keeps the Pause banner visible
  /// in a "Continuing…" state while this is set so the user sees that
  /// their click was received and work is in flight, instead of the
  /// banner vanishing instantly. Not persisted: it's a transient runtime
  /// signal — on restart, any in-flight finalize is already dead.
  pendingContinue?: {
    priorStepId: string;
    priorOutput: string;
    startedAt: number;
  };
  /// Set when this run was launched as one item of an Orchestrator batch.
  /// Links the child run back to its parent orchestration so the batch
  /// ledger can group it and the runtime can notify the orchestrator to
  /// pump the next queued item when this run reaches a terminal state.
  parentOrchestrationId?: UUID;
  /// Human title of the orchestration item this run came from (the
  /// candidate's title). Display only — lets a run surfaced on its own
  /// (sidebar, run pane) show which ask spawned it.
  orchestrationItemTitle?: string;
}

/// The project/workspace a run logically belongs to — i.e. where the user
/// launched it from. For `runIn: 'worktree'` runs, `projectPath` is the
/// throwaway worktree (single project) or coordinator symlink root
/// (workspace), so it never equals the original project/workspace root;
/// `sourceProjectPath` records that original. For `runIn: 'cwd'` runs
/// `sourceProjectPath` is absent and `projectPath` IS the root. Match runs
/// to their sidebar/library owner with this, not `projectPath` directly —
/// otherwise worktree runs vanish from their workspace's Flows list.
export function flowRunOwnerPath(run: FlowRun): string {
  return run.sourceProjectPath ?? run.projectPath;
}

/// Latest meaningful timestamp for a run: the most recent of its creation
/// and any step attempt's end (or start, while still running). Used to
/// keep recently-finished runs in the sidebar's "Active" set for a grace
/// window, mirroring how recently-touched conversations linger there.
export function flowRunActivityAt(run: FlowRun): number {
  return run.attempts.reduce(
    (max, a) => Math.max(max, a.endedAt ?? a.startedAt ?? 0),
    run.createdAt ?? 0,
  );
}

/// Descriptor for a tool that a step can be configured to use. Built from
/// (Ollama built-in tools, Claude built-in tools, MCP servers, …). The
/// builder renders these as a checkbox list; `available` controls whether
/// the box is greyed (e.g. Ollama can't yet drive Bash, so it's listed but
/// disabled).
export interface FlowToolDescriptor {
  /// Stable id used in `FlowStep.tools[]`. Examples: `'read_file'`,
  /// `'Bash'`, `'mcp:jira'`.
  id: string;
  displayName: string;
  description?: string;
  category: 'builtin' | 'mcp';
  /// Backends that can actually execute this tool. The builder uses this
  /// + the step's selected backend to decide whether to grey the checkbox.
  supportedBackends: Backend[];
  /// When false, render checkbox but disabled, with `unavailableReason`
  /// in the tooltip. Lets us list e.g. write tools for Ollama even though
  /// they don't yet work, so users can see the roadmap.
  available: boolean;
  unavailableReason?: string;
}

/// Sentinel input ref for the run's user prompt. Referenced by step
/// `inputs[]` to pull the launch-time free-text into the step's message.
export const FLOW_USER_PROMPT_REF = 'user_prompt' as const;

/// Resolve the effective backend+model for a step. Prefers the
/// participant lookup (the post-migration source of truth) but falls
/// back to the legacy step-level `model` field so partially-migrated
/// flows still produce a usable answer. Returns a placeholder ref with
/// empty model when neither is set — validation surfaces that as an
/// error.
export function resolveStepModel(flow: Flow, step: FlowStep): FlowModelRef {
  if (step.participantId) {
    const p = flow.participants?.find((x) => x.id === step.participantId);
    if (p) return { backend: p.backend, model: p.model };
  }
  if (step.model) return step.model;
  return { backend: 'claude', model: '' };
}

/// The model a participant should actually run, accounting for any
/// post-launch override on the run. Returns the override when present,
/// otherwise the participant's declared model. Backend is unaffected —
/// overrides are model-only within the same backend.
export function effectiveParticipantModel(run: FlowRun, participantId: string): string {
  const override = run.modelOverrides?.[participantId];
  if (override) return override;
  const p = run.flowSnapshot.participants?.find((x) => x.id === participantId);
  return p?.model ?? '';
}

/// Like `resolveStepModel`, but run-aware: applies the run's per-
/// participant `modelOverrides` so a mid-run model bump drives the actual
/// step execution, not just hijack chat. Use this in the runtime; use
/// `resolveStepModel` for pre-run / editor contexts where no run exists.
export function resolveRunStepModel(run: FlowRun, step: FlowStep): FlowModelRef {
  const base = resolveStepModel(run.flowSnapshot, step);
  const override = step.participantId
    ? run.modelOverrides?.[step.participantId]
    : undefined;
  return override ? { ...base, model: override } : base;
}

/// Resolve the FlowParticipant a step is assigned to. May be undefined
/// for malformed flows; callers should treat that as a validation
/// failure rather than crashing.
export function resolveStepParticipant(
  flow: Flow,
  step: FlowStep,
): FlowParticipant | undefined {
  if (!step.participantId) return undefined;
  return flow.participants?.find((p) => p.id === step.participantId);
}

/// Stable identity for "the user starred this specific flow". Must
/// combine `source` and `id` because the same id can exist in both the
/// user and project layers (`storage.ts:81-89` — project wins).
export function flowStarKey(flow: Pick<Flow, 'source' | 'id'>): string {
  return `${flow.source}:${flow.id}`;
}
