// Per-conversation runtime state lives in its own Zustand store, kept
// separate from the main projects/workspaces/settings store. This is
// the "hot transient" state — events stream in continuously and
// per-conversation flags toggle on every send/stop. Pulling it out of
// the main store means:
//
// 1. Components that subscribe to runner state stop re-evaluating their
//    selectors on every UI/sheet/sidebar mutation, and vice versa.
// 2. The two stores can evolve independently (devtools, persistence
//    policy, replacement of one without the other).
// 3. Mental model: persistent data and ephemeral runtime are different
//    things; the type system + import path now reflects that.
//
// Mutators are called from useStore methods (send/stop/ingestMainEvent)
// and read by components via the selector hooks below. Components that
// need many fields should use `useRunner(id)` and shallow-compare on
// the result rather than calling each selector independently.

import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ModelUsage, StreamEvent, TaskProgressInfo, UUID } from '@shared/types';

/// Per-conversation runtime state. Keyed off conversation id.
export interface RunnerState {
  events: StreamEvent[];
  /// Nested events emitted by Task/Agent subagents, bucketed by the
  /// parent Task tool_use id. The main `events` array no longer
  /// contains them — the inline ToolUseCard reads the bucket length
  /// for a live event count and the SubagentDrawer renders the full
  /// nested stream from here. Insertion order in each bucket matches
  /// arrival order, just like `events`.
  subagentEvents: Record<string, StreamEvent[]>;
  /// Live progress for background Workflow/Task tool runs, keyed by the
  /// `Workflow`/`Task` tool_use id. Folded from `taskProgress` stream
  /// events (which arrive out-of-band, not inline in the transcript) so
  /// the inline WorkflowCard can show phases/agents resolving instead of
  /// a dead generic tool card. Merged in place — each tick carries the
  /// full agent snapshot; see `mergeTaskProgress`.
  taskProgressByToolUse: Record<string, TaskProgressInfo>;
  isRunning: boolean;
  /// Timestamp (ms) this runner last flipped from idle to running, set
  /// both by the optimistic flip on send and by main's `running` event.
  /// `staleRunningIds` uses it to leave a just-started turn alone — main
  /// hasn't necessarily registered it by the time the next poll lands.
  runningSince?: number | null;
  activityLabel?: string;
  errorMessage?: string;
  pendingLocalUserIds: Set<UUID>;
  /// Current model as reported by system:init events. May diverge from
  /// conv.currentModel if the user switched mid-session.
  currentModel: string;
  /// Context-window occupancy as of the most recent request, and the
  /// window it's measured against. Both folded from per-turn usage by
  /// `foldContextUsage` — see there for what counts as "occupancy".
  /// Undefined until the conversation's first turn reports usage.
  contextTokens?: number;
  contextWindow?: number;
  /// History load state — prevents double-loading and drives the
  /// loading indicator in ChatView.
  historyLoaded: boolean;
  historyLoading: boolean;
  /// Timestamp (ms) the most recent history-load read started, cleared
  /// once it settles. Lets `loadHistoryIfNeeded` tell a load that's still
  /// in flight (skip) from one that never settled (retry after a window),
  /// so a stranded flag can't block the transcript from ever loading.
  historyLoadStartedAt?: number | null;
  /// Timestamp (ms) of the most recent run that finished without the
  /// user having acknowledged it yet. Drives the green checkmark in the
  /// sidebar — cleared once the user views the conversation (or after a
  /// short flash if they were already viewing it when it finished).
  completedAt: number | null;
  /// Codex runtime mode/flags for the currently running subprocess.
  codexRuntimeMode?: 'proto' | 'exec' | 'app-server';
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
}

export function newRunnerState(): RunnerState {
  return {
    events: [],
    subagentEvents: {},
    taskProgressByToolUse: {},
    isRunning: false,
    runningSince: null,
    pendingLocalUserIds: new Set(),
    currentModel: '',
    historyLoaded: false,
    historyLoading: false,
    historyLoadStartedAt: null,
    completedAt: null,
    codexRuntimeMode: undefined,
    codexSandboxMode: undefined,
    codexApprovalPolicy: undefined,
  };
}

interface RunnersStoreState {
  runners: Record<UUID, RunnerState>;
  /// Apply a partial update or a functional patch to a single runner.
  /// Auto-initializes when the runner doesn't exist yet — useful for
  /// the first event or first running flip on a new conversation.
  patchRunner(
    id: UUID,
    patch: Partial<RunnerState> | ((prev: RunnerState) => Partial<RunnerState>),
  ): void;
  /// Replace a runner wholesale.
  setRunner(id: UUID, runner: RunnerState): void;
  /// Drop a runner entirely (conversation removed, new-conversation reset).
  removeRunner(id: UUID): void;
  /// Reset to a fresh runner state (history reload, restart).
  resetRunner(id: UUID): void;
}

export const useRunnersStore = create<RunnersStoreState>((set) => ({
  runners: {},
  patchRunner(id, patch) {
    set((s) => {
      const prev = s.runners[id] ?? newRunnerState();
      const next = typeof patch === 'function' ? patch(prev) : patch;
      return { runners: { ...s.runners, [id]: { ...prev, ...next } } };
    });
  },
  setRunner(id, runner) {
    set((s) => ({ runners: { ...s.runners, [id]: runner } }));
  },
  removeRunner(id) {
    set((s) => {
      const { [id]: _drop, ...rest } = s.runners;
      return { runners: rest };
    });
  },
  resetRunner(id) {
    set((s) => ({ runners: { ...s.runners, [id]: newRunnerState() } }));
  },
}));

/// How long a locally-flipped running flag is left alone before the
/// reconcile is willing to retract it. Covers the window between the
/// renderer's optimistic flip on send and main registering the turn.
export const RUNNING_RECONCILE_GRACE_MS = 15_000;

/// Conversations this store thinks are running that main doesn't. The
/// running indicator is edge-triggered, so a `running: false` that never
/// arrives (or arrives while the window is reloading) pins a spinner —
/// and, via `runIsLive`, makes a finished flow run look busy — until the
/// app restarts. Comparing against main's authoritative snapshot lets it
/// self-heal instead.
export function staleRunningIds(
  runners: Record<UUID, { isRunning: boolean; runningSince?: number | null }>,
  runningIds: Iterable<UUID>,
  now: number,
  graceMs = RUNNING_RECONCILE_GRACE_MS,
): UUID[] {
  const live = runningIds instanceof Set ? runningIds : new Set(runningIds);
  const stale: UUID[] = [];
  for (const [id, runner] of Object.entries(runners)) {
    if (!runner.isRunning) continue;
    if (live.has(id)) continue;
    // A turn that started moments ago may not be in main's map yet.
    if (runner.runningSince != null && now - runner.runningSince < graceMs) continue;
    stale.push(id);
  }
  return stale;
}

// ---- Selector hooks ---------------------------------------------------

/// Subscribe to a single runner. Returns undefined if the runner has
/// not been initialized yet (no events received, no send invoked).
export function useRunner(id: UUID | null | undefined): RunnerState | undefined {
  return useRunnersStore((s) => (id ? s.runners[id] : undefined));
}

export function useRunnerEvents(id: UUID | null | undefined): StreamEvent[] | null {
  return useRunnersStore((s) => (id ? s.runners[id]?.events ?? null : null));
}

/// Events emitted by a specific Task/Agent subagent. Returns an empty
/// array (stable identity) when the subagent has not produced anything
/// yet so consumers don't fight referential-equality churn.
const EMPTY_SUBAGENT_EVENTS: StreamEvent[] = [];
export function useSubagentEvents(
  id: UUID | null | undefined,
  parentToolUseId: string | null | undefined,
): StreamEvent[] {
  return useRunnersStore((s) => {
    if (!id || !parentToolUseId) return EMPTY_SUBAGENT_EVENTS;
    return s.runners[id]?.subagentEvents[parentToolUseId] ?? EMPTY_SUBAGENT_EVENTS;
  });
}

/// Live workflow/task progress for a specific `Workflow`/`Task` tool_use
/// block. Returns undefined until the first task event for it lands.
export function useTaskProgress(
  id: UUID | null | undefined,
  toolUseId: string | null | undefined,
): TaskProgressInfo | undefined {
  return useRunnersStore((s) => {
    if (!id || !toolUseId) return undefined;
    return s.runners[id]?.taskProgressByToolUse[toolUseId];
  });
}

/// Fold one task event's info into the accumulated state for its tool_use
/// id. Each `task_progress` tick carries the full agent snapshot, but the
/// `started`/`completed` bookends don't — so we overlay scalar fields
/// when present and merge agents by index (incoming wins) rather than
/// clobbering a populated agent list with an empty one.
export function mergeTaskProgress(
  prev: TaskProgressInfo | undefined,
  next: TaskProgressInfo,
): TaskProgressInfo {
  if (!prev) return next;
  const agents = mergeAgentsByIndex(prev.agents, next.agents);
  return {
    ...prev,
    ...next,
    // A later 'progress' tick must not downgrade a 'completed' phase.
    phase: prev.phase === 'completed' ? 'completed' : next.phase,
    status: next.status ?? prev.status,
    taskType: next.taskType ?? prev.taskType,
    workflowName: next.workflowName ?? prev.workflowName,
    description: next.description ?? prev.description,
    totalTokens: next.totalTokens ?? prev.totalTokens,
    toolUses: next.toolUses ?? prev.toolUses,
    durationMs: next.durationMs ?? prev.durationMs,
    agents,
  };
}

function mergeAgentsByIndex(
  prev: TaskProgressInfo['agents'],
  next: TaskProgressInfo['agents'],
): TaskProgressInfo['agents'] {
  if (!next || next.length === 0) return prev;
  if (!prev || prev.length === 0) return next;
  const byIndex = new Map(prev.map((a) => [a.index, a]));
  for (const a of next) byIndex.set(a.index, a);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/// Context-window occupancy, as folded off the event stream.
export interface ContextOccupancy {
  tokens?: number;
  window?: number;
}

/// Fold a batch of main-agent events into the running context estimate.
///
/// "Occupancy" is `input + cache_read + cache_creation` from the most
/// recent request — i.e. what the model actually had in its window when
/// it last spoke. That's the number worth acting on: it's the floor for
/// what the NEXT request will resend. It deliberately excludes output
/// tokens, so the estimate lags by one response (a few hundred to a few
/// thousand tokens); the next turn's input folds them in anyway.
///
/// We can't ask the CLI directly on this transport — `getContextUsage()`
/// is an SDK control request and Overcli's default path is
/// `claude -p --input-format stream-json`. Per-turn usage is the same
/// data the CLI's own meter is built on, so the estimate tracks it.
///
/// Events carrying a `parentToolUseId` are skipped: a Task subagent runs
/// its own window and its usage would otherwise stomp the parent's
/// number. (The live path has already split those out; the history path
/// hands us one merged array, so the guard lives here.)
export function foldContextUsage(
  prev: ContextOccupancy,
  events: StreamEvent[],
  currentModel: string,
): ContextOccupancy {
  let tokens = prev.tokens;
  let window = prev.window;
  for (const e of events) {
    if (e.parentToolUseId) continue;
    if (e.kind.type === 'assistant') {
      // Streaming snapshots carry no usage; only the consolidated
      // assistant line does.
      const u = e.kind.info.usage;
      if (u) tokens = occupancyOf(u);
    } else if (e.kind.type === 'result') {
      const u = pickModelUsage(e.kind.info.modelUsage, currentModel);
      if (u) {
        tokens = occupancyOf(u);
        if (u.contextWindow) window = u.contextWindow;
      }
    }
  }
  if (tokens === prev.tokens && window === prev.window) return prev;
  return { tokens, window };
}

/// Sum the fields that make up window occupancy. Coerces missing fields
/// to 0: five backends build these objects and not all of them populate
/// every field, so a hole here would otherwise poison the total as NaN.
function occupancyOf(u: ModelUsage): number {
  return (
    (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
  );
}

/// A result line's `modelUsage` is keyed by model and can hold several
/// entries — the main model plus whatever subagents ran (a Task on Haiku,
/// a reviewer on Sonnet). Prefer the entry for the conversation's own
/// model, matching the CLI's `claude-opus-5[1m]`-style suffixed keys
/// against the bare id from system:init. Fall back to the largest entry
/// so an unrecognized key still yields a number rather than nothing.
function pickModelUsage(
  byModel: Record<string, ModelUsage>,
  currentModel: string,
): ModelUsage | null {
  const entries = Object.entries(byModel);
  if (entries.length === 0) return null;
  if (currentModel) {
    const exact = entries.find(
      ([model]) => model === currentModel || model.startsWith(`${currentModel}[`),
    );
    if (exact) return exact[1];
  }
  let best: ModelUsage | null = null;
  let bestTotal = -1;
  for (const [, u] of entries) {
    const total = occupancyOf(u);
    if (total > bestTotal) {
      bestTotal = total;
      best = u;
    }
  }
  return bestTotal > 0 ? best : null;
}

/// Context occupancy for one conversation, plus the fraction of the
/// window it fills (undefined when the window isn't known yet).
export function useContextOccupancy(
  id: UUID | null | undefined,
): ContextOccupancy & { fraction?: number } {
  return useRunnersStore(
    useShallow((s) => {
      const r = id ? s.runners[id] : undefined;
      const tokens = r?.contextTokens;
      const window = r?.contextWindow;
      return {
        tokens,
        window,
        fraction: tokens != null && window ? tokens / window : undefined,
      };
    }),
  );
}

/// Parent tool-use ids of every subagent that has emitted at least one
/// event in this conversation. Used by SubagentDrawer to render tabs.
export function useSubagentKeys(id: UUID | null | undefined): string[] {
  return useRunnersStore(
    useShallow((s) => (id ? Object.keys(s.runners[id]?.subagentEvents ?? {}) : [])),
  );
}

export function useRunnerIsRunning(id: UUID | null | undefined): boolean {
  return useRunnersStore((s) => (id ? s.runners[id]?.isRunning ?? false : false));
}

export function useRunnerCompletedAt(id: UUID | null | undefined): number | null {
  return useRunnersStore((s) => (id ? s.runners[id]?.completedAt ?? null : null));
}

export function useRunnerCurrentModel(id: UUID | null | undefined): string {
  return useRunnersStore((s) => (id ? s.runners[id]?.currentModel ?? '' : ''));
}

export function useRunnerActivityLabel(id: UUID | null | undefined): string | undefined {
  return useRunnersStore((s) => (id ? s.runners[id]?.activityLabel : undefined));
}

export function useRunnerErrorMessage(id: UUID | null | undefined): string | undefined {
  return useRunnersStore((s) => (id ? s.runners[id]?.errorMessage : undefined));
}

export function useRunnerCodexFlags(id: UUID | null | undefined) {
  return useRunnersStore(
    useShallow((s) => ({
      runtimeMode: id ? s.runners[id]?.codexRuntimeMode : undefined,
      sandboxMode: id ? s.runners[id]?.codexSandboxMode ?? '' : '',
      approvalPolicy: id ? s.runners[id]?.codexApprovalPolicy ?? '' : '',
    })),
  );
}

/// Subscribe to the full runners map. Heavy — use sparingly.
///
/// The map's identity changes on every ingested event, so a component
/// subscribing here re-renders at the full streaming rate (~60Hz while any
/// agent is working) no matter how little of the map it reads. That is fine
/// for sheets, which are mounted only while open and walk every runner
/// anyway (BulkConversationActionsSheet, QuickSwitcher's "running" filter).
/// It is NOT fine for always-mounted chrome like the sidebar — use
/// `useRunningMap` there instead.
export function useAllRunners(): Record<UUID, RunnerState> {
  return useRunnersStore((s) => s.runners);
}

/// Activity labels for running conversations, keyed by id.
///
/// Values are deliberately plain strings: `useShallow` then compares them by
/// value, so the projection is referentially stable across the flood of
/// event-only updates and only differs when a conversation actually starts,
/// stops, or changes its label.
export function runningLabelsOf(
  runners: Record<UUID, Pick<RunnerState, 'isRunning' | 'activityLabel'>>,
): Record<UUID, string> {
  const out: Record<UUID, string> = {};
  for (const [id, r] of Object.entries(runners)) {
    if (r.isRunning) out[id] = r.activityLabel ?? '';
  }
  return out;
}

/// Unacknowledged-completion timestamps, keyed by id. Same value-compare
/// property as `runningLabelsOf`.
export function completedAtOf(
  runners: Record<UUID, Pick<RunnerState, 'completedAt'>>,
): Record<UUID, number> {
  const out: Record<UUID, number> = {};
  for (const [id, r] of Object.entries(runners)) {
    if (r.completedAt != null) out[id] = r.completedAt;
  }
  return out;
}

function useRunningLabels(): Record<UUID, string> {
  return useRunnersStore(useShallow((s) => runningLabelsOf(s.runners)));
}

function useCompletedAtMap(): Record<UUID, number> {
  return useRunnersStore(useShallow((s) => completedAtOf(s.runners)));
}

/// The slice of runner state the sidebar and other always-mounted chrome
/// actually read, shaped so it drops straight into the existing
/// `runners[id]?.isRunning` call sites.
///
/// This exists because those components used `useAllRunners()`, which
/// re-renders on every streamed delta. With a real project list that meant
/// the entire sidebar tree — plus its unmemoized per-group filters over
/// every conversation — re-running ~60 times a second for the whole
/// duration of every turn. Here the underlying selectors are value-compared,
/// so the result is referentially stable between actual transitions.
export interface RunningSummary {
  isRunning: boolean;
  activityLabel?: string;
  completedAt?: number;
}

const EMPTY_RUNNING_MAP: Record<UUID, RunningSummary> = {};

export function useRunningMap(): Record<UUID, RunningSummary | undefined> {
  const labels = useRunningLabels();
  const completed = useCompletedAtMap();
  return useMemo(() => {
    const ids = new Set([...Object.keys(labels), ...Object.keys(completed)]);
    if (ids.size === 0) return EMPTY_RUNNING_MAP;
    const out: Record<UUID, RunningSummary> = {};
    for (const id of ids) {
      const label = labels[id];
      out[id] = {
        isRunning: label !== undefined,
        activityLabel: label ? label : undefined,
        completedAt: completed[id],
      };
    }
    return out;
  }, [labels, completed]);
}

/// Imperative read for code outside of React (store methods, IPC
/// handlers). Does not subscribe.
export function getRunner(id: UUID): RunnerState | undefined {
  return useRunnersStore.getState().runners[id];
}

export function getAllRunners(): Record<UUID, RunnerState> {
  return useRunnersStore.getState().runners;
}
