// What the primary sidebar has to show, independent of how it's arranged.
//
// Both layouts render the same things — chats, agents, flow runs, live worker
// runs — and differ only in how they group them: Stream by time, Projects by
// where they live. Collecting the rows once, here, is what keeps that true.
// It also keeps the row-level rules (what's hidden, what counts as the user's
// own action, what a row's owner is) in one place instead of drifting apart
// in two renderers.

import type { Colosseum, Conversation, Project, UUID, Workspace } from '@shared/types';
import { flowRunActivityAt, flowRunOwnerPath, isWorkerRun, type FlowRun } from '@shared/flows/schema';
import { pathBasename } from '@shared/workspaceNames';

import type { ActiveCandidate } from '../activeSection';
import {
  ACTIVE_CONVERSATION_WINDOW_MS,
  conversationActivityAt,
  conversationPromptAt,
  isActiveConversation,
} from '../conversationLookup';
import { actionMomentum, momentumScore } from '../sidebarMomentum';
import {
  resolveOwner as resolveFlowOwner,
  runIsActive as flowRunIsActive,
  WAITING_RUN_WINDOW_MS,
  runIsLive as flowRunIsLive,
  workerRunIsActive,
} from './flows/FlowRunSidebarRow';

/// How many worker runs the Working-on section will show at once. Three of
/// seven slots: enough to see a roster waking up, few enough that your own
/// work keeps the rest.
export const ACTIVE_WORKER_RUN_LIMIT = 3;

export function projectLabel(project: Project): string {
  const fromPath = pathBasename(project.path).trim();
  if (fromPath) return fromPath;
  return project.name;
}

/// Conversations in the store are plain objects, so we use a helper
/// rather than extending the type with methods. `continuedLocally`
/// coordinators still carry `workspaceAgentMemberIds` (we keep the
/// historical link), but the coordinator is no longer operating as an
/// agent so the sidebar should list it with the workspace's plain
/// chats, not under Agents.
export function isAgentConversation(c: Conversation): boolean {
  if (c.continuedLocally) return false;
  return !!c.worktreePath || (c.workspaceAgentMemberIds?.length ?? 0) > 0;
}

export interface RecentConversationItem {
  kind: 'conversation';
  conv: Conversation;
  ownerName: string;
  ownerKind: 'project' | 'workspace';
}

export interface ActiveFlowItem {
  kind: 'flow';
  run: FlowRun;
  ownerName: string;
  ownerKind: 'project' | 'workspace' | 'unknown' | 'worker';
  /// Drives the row's live indicator only. Liveness deliberately has no say
  /// in where the row sits — see selectActiveEntries.
  isLive: boolean;
}

export type ActiveItem = RecentConversationItem | ActiveFlowItem;

/// What the user is currently looking at, and when they last looked at
/// everything else. This is what holds a row's slot while a long turn runs —
/// you aren't typing, but that chat is still what you're working on. It only
/// feeds `touchedAt`, never `promptedAt`: opening something keeps it on
/// screen, it doesn't move it (see selectActiveEntries).
export interface ActiveSelection {
  openedConversationId: UUID | null;
  lastSelectedAt: Record<UUID, number>;
  openedRunId: string | null;
  lastOpenedAtByRun: Record<string, number>;
}

/// When the user last drove this run: launching it, or clicking Continue on
/// a paused step. Deliberately NOT flowRunActivityAt — attempts are pushed by
/// the runtime for every step it takes, so keying off those would let a flow
/// walking itself through ten steps outrank a chat the user just typed in.
export function flowRunPromptedAt(run: FlowRun): number {
  return Math.max(run.createdAt ?? 0, run.pendingContinue?.startedAt ?? 0);
}

/// Turns per hour, decayed. `turnCount` is the whole history and
/// `createdAt`→`lastPromptAt` is the window it's spread over, which is
/// exactly the ratio we want: forty turns this morning and forty turns across
/// a fortnight should not rank the same.
export function conversationMomentum(conv: Conversation, now: number = Date.now()): number {
  return momentumScore(
    {
      turns: conv.turnCount ?? 0,
      firstAt: conv.createdAt ?? conversationPromptAt(conv),
      lastAt: conversationPromptAt(conv),
    },
    now,
  );
}

/// A run's momentum is its launch, plus a Continue if the user pressed one.
///
/// Deliberately not derived from `attempts`: the runtime pushes one per step
/// it takes, so a flow walking itself through ten steps would outrank
/// everything the user actually typed — the same trap `flowRunPromptedAt`
/// avoids. One user action, decaying, is what a run honestly is.
export function flowMomentum(run: FlowRun, now: number = Date.now()): number {
  const actions = 1 + (run.pendingContinue ? 1 : 0);
  return actionMomentum(actions, flowRunPromptedAt(run), now);
}

/// Every chat, agent and flow run eligible for the Working-on section, whether
/// or not it's still active — selectActiveEntries ranks them and decides which
/// make the cut. Hidden conversations and archived runs are left out: the user
/// has explicitly put those away, so they shouldn't be dragged back in by the
/// section's floor.
///
/// Worker runs are the one entry here nobody started by hand, and they follow
/// their own rule — see the comment on `liveWorkerRuns`.
export function collectActiveCandidates(
  projects: Project[],
  workspaces: Workspace[],
  flowRuns: Record<UUID, FlowRun>,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
  selection: ActiveSelection,
  now: number = Date.now(),
  /// The roster, for naming a worker run after its worker. Optional so the
  /// section still builds before the workers store has loaded.
  workers: Record<string, { name: string }> = {},
): ActiveCandidate<ActiveItem>[] {
  const cutoff = now - ACTIVE_CONVERSATION_WINDOW_MS;
  // Runs waiting on the user get a longer leash than runs that merely
  // finished recently — see WAITING_RUN_WINDOW_MS.
  const waitingCutoff = now - WAITING_RUN_WINDOW_MS;
  const out: ActiveCandidate<ActiveItem>[] = [];

  const pushConversation = (
    conv: Conversation,
    ownerName: string,
    ownerKind: 'project' | 'workspace',
  ) => {
    if (conv.hidden) return;
    const running = !!runners[conv.id]?.isRunning;
    const opened = conv.id === selection.openedConversationId;
    out.push({
      entry: { kind: 'conversation', conv, ownerName, ownerKind },
      // The chat on screen always gets a slot. Without this a busy set of
      // backends could fill the cap and evict the one you're reading.
      active: opened || isActiveConversation(conv, running, cutoff),
      promptedAt: conversationPromptAt(conv),
      touchedAt: Math.max(
        conversationPromptAt(conv),
        selection.lastSelectedAt[conv.id] ?? 0,
      ),
      momentum: conversationMomentum(conv, now),
    });
  };

  for (const project of projects) {
    for (const conv of project.conversations) {
      pushConversation(conv, projectLabel(project), 'project');
    }
  }
  for (const workspace of workspaces) {
    for (const conv of workspace.conversations ?? []) {
      pushConversation(conv, workspace.name, 'workspace');
    }
  }

  for (const run of liveWorkerRuns(flowRuns, runners, selection)) {
    out.push({
      entry: {
        kind: 'flow',
        run,
        ownerName: workers[run.workerId!]?.name ?? 'a worker',
        ownerKind: 'worker',
        isLive: flowRunIsLive(run, runners),
      },
      active: true,
      promptedAt: flowRunPromptedAt(run),
      // Never held by a past touch: a worker run leaves this section when it
      // stops, however recently you looked at it.
      touchedAt: flowRunPromptedAt(run),
      momentum: flowMomentum(run, now),
    });
  }

  for (const run of Object.values(flowRuns)) {
    if (run.state.kind === 'archived') continue;
    if (isWorkerRun(run)) continue;
    const owner = resolveFlowOwner(flowRunOwnerPath(run), projects, workspaces);
    out.push({
      entry: {
        kind: 'flow',
        run,
        ownerName: owner.name,
        ownerKind: owner.kind,
        isLive: flowRunIsLive(run, runners),
      },
      active:
        run.id === selection.openedRunId ||
        flowRunIsActive(run, runners, cutoff, waitingCutoff),
      promptedAt: flowRunPromptedAt(run),
      touchedAt: Math.max(
        flowRunPromptedAt(run),
        selection.lastOpenedAtByRun[run.id] ?? 0,
      ),
      momentum: flowMomentum(run, now),
    });
  }

  return out;
}

/// A worker's runs are shown at its desk, not in the project's flow list — a
/// worker on an hourly clock would bury the runs you started yourself. The
/// exception is the sidebar's own sections, and only while the run is
/// happening: they answer "what is going on right now", and an unattended run
/// spending money is exactly that. Capped, newest first, so a roster firing at
/// once cannot evict the chat you are reading; the Workers tab has them all.
function liveWorkerRuns(
  flowRuns: Record<UUID, FlowRun>,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
  selection: ActiveSelection,
): FlowRun[] {
  return Object.values(flowRuns)
    .filter((run) => isWorkerRun(run) && workerRunIsActive(run, runners))
    // The run you have open sorts first, then newest: a roster waking up
    // together must not push out the run you're reading (and possibly
    // hijack-chatting) just because it started earlier.
    .sort(
      (a, b) =>
        Number(b.id === selection.openedRunId) - Number(a.id === selection.openedRunId) ||
        flowRunPromptedAt(b) - flowRunPromptedAt(a),
    )
    .slice(0, ACTIVE_WORKER_RUN_LIMIT);
}

/// Where a run sits on the Stream timeline: the later of the user's own last
/// action and the last step the run actually took. See `StreamEntry.at` for
/// why this differs from the Working-on section's `promptedAt`.
function streamAt(run: FlowRun): number {
  return Math.max(flowRunPromptedAt(run), flowRunActivityAt(run));
}

export interface SidebarOwner {
  id: string;
  name: string;
  kind: 'project' | 'workspace' | 'worker' | 'unknown';
}

export interface StreamEntry {
  /// Unique across the whole stream, so React keys survive a row moving
  /// between buckets.
  key: string;
  item: ActiveItem;
  owner: SidebarOwner;
  /// Where the row sits on the timeline: when work last happened here.
  ///
  /// Stream keys off this rather than `createdAt` — which is what the tree
  /// uses — because a timeline of what you were doing, ordered by when things
  /// were first made, would not be a timeline.
  ///
  /// For a RUN this deliberately includes the steps it took, unlike the
  /// Working-on section's `promptedAt`. The two want different things. A
  /// small live list you are clicking in must not reshuffle because a backend
  /// advanced; a historical timeline must put a flow that ran seven steps
  /// yesterday under yesterday. Keying the timeline off `promptedAt` meant a
  /// run's position was frozen at its creation date forever — `pendingContinue`
  /// is explicitly not persisted, so it is almost always just `createdAt` —
  /// and a run you had driven to step seven and left paused for you filed
  /// itself under "Earlier" while simultaneously sitting in Working on.
  at: number;
  touchedAt: number;
  momentum: number;
  /// Live, or the row on screen. Never sleeps.
  pinned: boolean;
}

/// The flat, newest-first list behind the Stream layout.
export function collectStreamItems(
  projects: Project[],
  workspaces: Workspace[],
  flowRuns: Record<UUID, FlowRun>,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
  selection: ActiveSelection,
  now: number = Date.now(),
  workers: Record<string, { name: string }> = {},
): StreamEntry[] {
  const out: StreamEntry[] = [];

  const pushConversation = (conv: Conversation, owner: SidebarOwner) => {
    if (conv.hidden) return;
    const running = !!runners[conv.id]?.isRunning;
    out.push({
      key: `c:${conv.id}`,
      item: {
        kind: 'conversation',
        conv,
        ownerName: owner.name,
        ownerKind: owner.kind === 'workspace' ? 'workspace' : 'project',
      },
      owner,
      at: conversationPromptAt(conv),
      touchedAt: Math.max(
        conversationPromptAt(conv),
        selection.lastSelectedAt[conv.id] ?? 0,
      ),
      momentum: conversationMomentum(conv, now),
      pinned: running || conv.id === selection.openedConversationId,
    });
  };

  for (const project of projects) {
    const owner: SidebarOwner = { id: project.id, name: projectLabel(project), kind: 'project' };
    for (const conv of project.conversations) pushConversation(conv, owner);
  }
  for (const workspace of workspaces) {
    const owner: SidebarOwner = { id: workspace.id, name: workspace.name, kind: 'workspace' };
    for (const conv of workspace.conversations ?? []) pushConversation(conv, owner);
  }

  for (const run of liveWorkerRuns(flowRuns, runners, selection)) {
    const name = workers[run.workerId!]?.name ?? 'a worker';
    out.push({
      key: `f:${run.id}`,
      item: { kind: 'flow', run, ownerName: name, ownerKind: 'worker', isLive: true },
      owner: { id: `worker:${run.workerId}`, name, kind: 'worker' },
      at: streamAt(run),
      touchedAt: flowRunPromptedAt(run),
      momentum: flowMomentum(run, now),
      pinned: true,
    });
  }

  for (const run of Object.values(flowRuns)) {
    if (run.state.kind === 'archived') continue;
    if (isWorkerRun(run)) continue;
    const path = flowRunOwnerPath(run);
    const resolved = resolveFlowOwner(path, projects, workspaces);
    const isLive = flowRunIsLive(run, runners);
    out.push({
      key: `f:${run.id}`,
      item: { kind: 'flow', run, ownerName: resolved.name, ownerKind: resolved.kind, isLive },
      // Keyed on the owner PATH, not the resolved name: two projects can
      // share a basename, and a lane that silently merged them would claim
      // work happened somewhere it didn't.
      owner: { id: `path:${path}`, name: resolved.name, kind: resolved.kind },
      at: streamAt(run),
      touchedAt: Math.max(flowRunPromptedAt(run), selection.lastOpenedAtByRun[run.id] ?? 0),
      momentum: flowMomentum(run, now),
      pinned: isLive || run.id === selection.openedRunId,
    });
  }

  return out.sort((a, b) => b.at - a.at);
}

/// Newest first, keyed on creation.
///
/// This is the fix for the sidebar's oldest inconsistency: flow runs sorted
/// newest-first while conversations rendered in raw append order, so the
/// newest chat landed at the BOTTOM of the same list the newest run headed.
///
/// `createdAt` rather than last activity on purpose. An activity key would
/// put the freshest thing on top but re-sort the list every time anything
/// moved, so rows slide out from under the pointer as you aim at them. A
/// creation key never changes after the row exists — which is precisely why
/// the flows list already felt right.
export function byNewestFirst<T extends { createdAt?: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/// When a project last saw anything happen, for ordering and for deciding
/// whether it's warm enough to stay out of the sleeping roll-up.
export function projectActivityAt(
  project: Project,
  colosseums: Colosseum[],
  runners: Record<UUID, { isRunning: boolean } | undefined>,
  flowRuns: Record<UUID, FlowRun>,
  now: number = Date.now(),
): number {
  if (project.conversations.some((c) => runners[c.id]?.isRunning)) return now;
  const projectRuns = Object.values(flowRuns).filter(
    (r) => flowRunOwnerPath(r) === project.path,
  );
  // A live (running or paused) flow pins the project to the top, just like a
  // running conversation does.
  if (projectRuns.some((r) => r.state.kind === 'running' || r.state.kind === 'paused')) {
    return now;
  }
  const newestConversation = project.conversations.reduce(
    (max, c) => (c.hidden ? max : Math.max(max, conversationActivityAt(c))),
    0,
  );
  const newestColosseum = colosseums
    .filter((c) => c.projectId === project.id)
    .reduce((max, c) => Math.max(max, c.createdAt), 0);
  const newestFlowRun = projectRuns.reduce((max, r) => Math.max(max, flowRunActivityAt(r)), 0);
  return Math.max(project.lastOpenedAt ?? 0, newestConversation, newestColosseum, newestFlowRun);
}

/// Same question for a workspace. Workspaces used to have no activity notion
/// at all — they rendered in store order, uncapped and never rolled up, while
/// projects were sorted, capped at five and overflowed into "More projects".
/// Two lists of the same kind of thing obeying different rules is most of why
/// the sidebar read as busy.
export function workspaceActivityAt(
  workspace: Workspace,
  runners: Record<UUID, { isRunning: boolean } | undefined>,
  flowRuns: Record<UUID, FlowRun>,
  now: number = Date.now(),
): number {
  const convs = workspace.conversations ?? [];
  if (convs.some((c) => runners[c.id]?.isRunning)) return now;
  const runs = Object.values(flowRuns).filter(
    (r) => flowRunOwnerPath(r) === workspace.rootPath,
  );
  if (runs.some((r) => r.state.kind === 'running' || r.state.kind === 'paused')) return now;
  const newestConversation = convs.reduce(
    (max, c) => (c.hidden ? max : Math.max(max, conversationActivityAt(c))),
    0,
  );
  const newestRun = runs.reduce((max, r) => Math.max(max, flowRunActivityAt(r)), 0);
  return Math.max(workspace.createdAt ?? 0, newestConversation, newestRun);
}
