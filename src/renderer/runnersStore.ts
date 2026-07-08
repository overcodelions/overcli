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

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { StreamEvent, TaskProgressInfo, UUID } from '@shared/types';

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
  activityLabel?: string;
  errorMessage?: string;
  pendingLocalUserIds: Set<UUID>;
  /// Current model as reported by system:init events. May diverge from
  /// conv.currentModel if the user switched mid-session.
  currentModel: string;
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

/// Subscribe to the full runners map. Heavy — use sparingly. Sheets
/// that need to walk every runner (BulkConversationActionsSheet,
/// QuickSwitcher's "running" filter) are the legitimate consumers.
export function useAllRunners(): Record<UUID, RunnerState> {
  return useRunnersStore((s) => s.runners);
}

/// Imperative read for code outside of React (store methods, IPC
/// handlers). Does not subscribe.
export function getRunner(id: UUID): RunnerState | undefined {
  return useRunnersStore.getState().runners[id];
}

export function getAllRunners(): Record<UUID, RunnerState> {
  return useRunnersStore.getState().runners;
}
