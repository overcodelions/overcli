// Cleanup: what the scan found, arranged the way the mess was made.
//
// The old bulk modal listed conversations flat — 1,354 rows, no idea that
// forty of them were one worker doing its job forty times, and no idea what
// any of them cost on disk. Everything here exists to turn that flat list
// into a handful of decisions: group by the WORKER, FLOW or CHAT that made
// each worktree, and act on whole units (tree + branch + conversation + run
// row) rather than on halves that leave the other half stranded.
//
// Deliberately pure. The sheet does the scanning and the removing; this
// module only decides what goes in which group and what a selection would
// actually do, which is the part worth testing.

import type {
  Conversation,
  UUID,
  WorktreeClaim,
  WorktreeSweepBucket,
  WorktreeSweepEntry,
} from '@shared/types';

/// Producer kinds, in the order the list shows them. Workers first because
/// they are the runaway producer this surface was built for; `foreign` last
/// because nothing can be done with it and it exists only so the totals add
/// up honestly.
export const GROUP_ORDER: CleanupGroupKind[] = ['worker', 'flow', 'chat', 'orphan', 'foreign'];

export type CleanupGroupKind = 'worker' | 'flow' | 'chat' | 'orphan' | 'foreign';

export interface CleanupGroup {
  /// Stable across rescans, so an expanded group stays expanded.
  key: string;
  kind: CleanupGroupKind;
  name: string;
  /// One line of context under the name — project, cadence, what it is.
  subtitle: string;
  entries: WorktreeSweepEntry[];
  safe: WorktreeSweepEntry[];
  hasWork: WorktreeSweepEntry[];
  live: WorktreeSweepEntry[];
  /// Disk across the whole group. Only inspected entries carry a size, so
  /// this is really "what we could measure" — busy and foreign trees report 0.
  totalKb: number;
  safeKb: number;
}

/// Everything a conversation says about the tree it owns. Mirrors what main
/// contributes for runs (`flowRunClaims`), so the scan sees one shape.
///
/// A conversation that BORROWED a run's tree (`adoptedWorktree`) still claims
/// it here — `indexClaims` in main folds it into the run's claim, which is
/// what makes removal take the borrowed row with it instead of stranding it.
export function conversationClaims(
  owners: Array<{ conversations: Conversation[] }>,
  isRunningById: Record<UUID, boolean>,
): WorktreeClaim[] {
  const out: WorktreeClaim[] = [];
  for (const owner of owners) {
    for (const conv of owner.conversations ?? []) {
      if (!conv.worktreePath) continue;
      out.push({
        worktreePath: conv.worktreePath,
        kind: 'conversation',
        convId: conv.id,
        title: conv.name,
        busy: isRunningById[conv.id] ?? false,
        finished: !!conv.hidden,
        activeAt: conv.lastActiveAt ?? conv.createdAt,
        adoptedConvIds: conv.adoptedWorktree ? [conv.id] : undefined,
      });
    }
  }
  return out;
}

/// Which group an entry belongs to. Precedence is worker over flow because a
/// worker's shift IS a flow run — grouping it under the flow would scatter
/// one worker's output across every flow it happens to use, which is the
/// opposite of the point.
export function groupKeyFor(entry: WorktreeSweepEntry): { key: string; kind: CleanupGroupKind } {
  if (entry.bucket === 'foreign') return { key: 'foreign', kind: 'foreign' };
  const claim = entry.claim;
  if (!claim) return { key: 'orphan', kind: 'orphan' };
  if (claim.workerId) return { key: `worker:${claim.workerId}`, kind: 'worker' };
  if (claim.flowId) return { key: `flow:${claim.flowId}`, kind: 'flow' };
  return { key: 'chat', kind: 'chat' };
}

function groupNameFor(kind: CleanupGroupKind, claim: WorktreeClaim | undefined): string {
  switch (kind) {
    case 'worker':
      return claim?.workerName ?? 'Worker';
    case 'flow':
      return claim?.flowName ?? claim?.flowId ?? 'Flow';
    case 'chat':
      return 'Your agent chats';
    case 'orphan':
      return 'Nobody owns these';
    case 'foreign':
      return 'Made outside Overcli';
  }
}

function subtitleFor(kind: CleanupGroupKind, entries: WorktreeSweepEntry[]): string {
  const projects = [...new Set(entries.map((e) => e.projectName))];
  const where = projects.length === 1 ? projects[0] : `${projects.length} projects`;
  switch (kind) {
    case 'worker':
      return `${where} · ${entries.length} shift${entries.length === 1 ? '' : 's'}`;
    case 'flow': {
      const schedule = entries.find((e) => e.claim?.scheduleName)?.claim?.scheduleName;
      return schedule ? `${where} · runs on ${schedule}` : where;
    }
    case 'chat':
      return `${where} · chats you started yourself`;
    case 'orphan':
      return 'the chat or run that made them is already gone';
    case 'foreign':
      return 'outside ~/.overcli/worktrees — reported, never touched';
  }
}

/// How the list is carved up. `producer` is the default and the point of the
/// surface; `project` is for the other question people actually ask — "what
/// is this repo costing me?" — and is the one grouping where a worker's
/// shifts SHOULD be split apart.
export type CleanupGroupMode = 'producer' | 'project';

/// Build the group list. Groups are ordered by kind, then by how much safe
/// disk each is holding: the worker sitting on a gigabyte of finished shifts
/// should be the first thing you see.
export function groupEntries(
  entries: WorktreeSweepEntry[],
  mode: CleanupGroupMode = 'producer',
): CleanupGroup[] {
  if (mode === 'project') return groupByProject(entries);
  const byKey = new Map<string, WorktreeSweepEntry[]>();
  const kinds = new Map<string, CleanupGroupKind>();
  for (const entry of entries) {
    const { key, kind } = groupKeyFor(entry);
    kinds.set(key, kind);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }

  const groups: CleanupGroup[] = [];
  for (const [key, list] of byKey) {
    const kind = kinds.get(key)!;
    const safe = list.filter((e) => e.bucket === 'reclaimable');
    groups.push({
      key,
      kind,
      name: groupNameFor(kind, list.find((e) => e.claim)?.claim),
      subtitle: subtitleFor(kind, list),
      entries: [...list].sort(sortEntries),
      safe,
      hasWork: list.filter((e) => e.bucket === 'has-work'),
      live: list.filter((e) => e.bucket === 'live'),
      totalKb: list.reduce((sum, e) => sum + e.sizeKb, 0),
      safeKb: safe.reduce((sum, e) => sum + e.sizeKb, 0),
    });
  }

  groups.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind) ||
      b.safeKb - a.safeKb ||
      b.entries.length - a.entries.length ||
      a.name.localeCompare(b.name),
  );
  return groups;
}

/// One group per project, biggest reclaimable pile first. Kind is carried
/// only so the row chrome has something to colour by; there is no producer
/// distinction inside a project group by design.
function groupByProject(entries: WorktreeSweepEntry[]): CleanupGroup[] {
  const byPath = new Map<string, WorktreeSweepEntry[]>();
  for (const entry of entries) {
    const list = byPath.get(entry.projectPath);
    if (list) list.push(entry);
    else byPath.set(entry.projectPath, [entry]);
  }
  const groups: CleanupGroup[] = [];
  for (const [projectPath, list] of byPath) {
    const safe = list.filter((e) => e.bucket === 'reclaimable');
    const producers = new Set(list.map((e) => groupKeyFor(e).key));
    groups.push({
      key: `project:${projectPath}`,
      kind: 'chat',
      name: list[0].projectName,
      subtitle: `${list.length} worktree${list.length === 1 ? '' : 's'} from ${producers.size} producer${producers.size === 1 ? '' : 's'}`,
      entries: [...list].sort(sortEntries),
      safe,
      hasWork: list.filter((e) => e.bucket === 'has-work'),
      live: list.filter((e) => e.bucket === 'live'),
      totalKb: list.reduce((sum, e) => sum + e.sizeKb, 0),
      safeKb: safe.reduce((sum, e) => sum + e.sizeKb, 0),
    });
  }
  groups.sort((a, b) => b.safeKb - a.safeKb || a.name.localeCompare(b.name));
  return groups;
}

/// Within a group: safest first (that's what you're here to tick), then
/// oldest, so the pre-selected block is contiguous and the rows that need a
/// decision sit together below it.
const BUCKET_RANK: Record<WorktreeSweepBucket, number> = {
  reclaimable: 0,
  'has-work': 1,
  live: 2,
  foreign: 3,
};

function sortEntries(a: WorktreeSweepEntry, b: WorktreeSweepEntry): number {
  return (
    BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket] ||
    entryAgeAt(a) - entryAgeAt(b) ||
    b.sizeKb - a.sizeKb
  );
}

/// When this worktree last saw activity. The claim knows when its
/// conversation or run last did anything; an orphan has only its last commit.
/// 0 when neither can date it — an undated row sorts oldest and, like the old
/// Storage pane, is never hidden by an age filter.
export function entryAgeAt(entry: WorktreeSweepEntry): number {
  return entry.claim?.activeAt ?? entry.lastCommitAt ?? 0;
}

export interface CleanupFilter {
  query: string;
  /// 0 means no filter.
  minAgeDays: number;
  /// Show only this bucket, or everything.
  bucket: WorktreeSweepBucket | 'all';
  now: number;
}

export function filterEntries(
  entries: WorktreeSweepEntry[],
  filter: CleanupFilter,
): WorktreeSweepEntry[] {
  const q = filter.query.trim().toLowerCase();
  const cutoff =
    filter.minAgeDays > 0 ? filter.now - filter.minAgeDays * 24 * 60 * 60 * 1000 : null;
  return entries.filter((e) => {
    if (filter.bucket !== 'all' && e.bucket !== filter.bucket) return false;
    if (cutoff !== null) {
      const at = entryAgeAt(e);
      // An undated row stays visible: hiding something we simply couldn't
      // date would shrink the list without the user knowing why.
      if (at !== 0 && at >= cutoff) return false;
    }
    if (!q) return true;
    return (
      (e.claim?.title ?? '').toLowerCase().includes(q) ||
      (e.claim?.workerName ?? '').toLowerCase().includes(q) ||
      (e.claim?.flowName ?? '').toLowerCase().includes(q) ||
      (e.branchName ?? '').toLowerCase().includes(q) ||
      e.projectName.toLowerCase().includes(q) ||
      e.worktreePath.toLowerCase().includes(q)
    );
  });
}

export interface CleanupTotals {
  safe: number;
  safeKb: number;
  hasWork: number;
  live: number;
  foreign: number;
  totalKb: number;
}

export function totalsFor(entries: WorktreeSweepEntry[]): CleanupTotals {
  const totals: CleanupTotals = { safe: 0, safeKb: 0, hasWork: 0, live: 0, foreign: 0, totalKb: 0 };
  for (const e of entries) {
    totals.totalKb += e.sizeKb;
    if (e.bucket === 'reclaimable') {
      totals.safe++;
      totals.safeKb += e.sizeKb;
    } else if (e.bucket === 'has-work') totals.hasWork++;
    else if (e.bucket === 'live') totals.live++;
    else totals.foreign++;
  }
  return totals;
}

/// Whether an entry can be acted on at all. Busy trees are refused for the
/// obvious reason; foreign ones because they are not ours to delete.
export function isActionable(entry: WorktreeSweepEntry): boolean {
  return entry.bucket === 'reclaimable' || entry.bucket === 'has-work';
}

export interface CleanupPlan {
  /// Runs to delete — takes the run row, its tree and its participant
  /// conversations with it.
  removeRunIds: UUID[];
  /// Agent conversations to delete — `removeAgent` removes the tree and the
  /// conversation as one unit.
  removeAgentIds: UUID[];
  /// Conversation rows that only BORROWED a tree we're removing. They own
  /// nothing on disk, but they point at a directory that is about to stop
  /// existing, so they go with it.
  removeAdoptedIds: UUID[];
  /// Orphans: no row anywhere, so this is pure git.
  sweepEntries: Array<{
    projectPath: string;
    worktreePath: string;
    branchName: string | null;
    baseBranch: string;
  }>;
  /// Selected but refused, with the reason to show.
  skipped: Array<{ entry: WorktreeSweepEntry; reason: 'busy' | 'foreign' }>;
  /// Runs it is NOT safe to force-delete: they own worktrees beyond the ones
  /// selected here, so deleting the run would take trees the user never saw
  /// (a workspace run holds one per member repo). These go to the flow
  /// runtime WITHOUT `force`, letting its own unreviewed-work guard have the
  /// final say instead of being bypassed.
  runsHoldingMore: UUID[];
  worktreeCount: number;
  freedKb: number;
  conversationCount: number;
  runCount: number;
  /// How many of the selected trees hold work that removal would destroy.
  withWorkCount: number;
}

/// Turn a selection into the exact set of calls the sheet will make.
///
/// The split matters: each producer has its own teardown, and using the wrong
/// one leaves half a unit behind. A run must go through the flow runtime (it
/// owns participant conversations and run metadata); an agent conversation
/// through `removeAgent` (tree and row together, and it knows how to keep the
/// row when git refuses); an orphan through the git sweep, because there is no
/// row to keep in step.
export function planCleanup(
  selected: WorktreeSweepEntry[],
  /// Every entry the scan found. Needed because a run's OTHER worktrees are
  /// separate rows: without them there is no way to tell that deleting this
  /// run would also remove a tree holding work somewhere else. Defaults to
  /// the selection, which is the conservative reading for callers that only
  /// want the counts.
  all: WorktreeSweepEntry[] = selected,
): CleanupPlan {
  const plan: CleanupPlan = {
    removeRunIds: [],
    removeAgentIds: [],
    removeAdoptedIds: [],
    sweepEntries: [],
    skipped: [],
    runsHoldingMore: [],
    worktreeCount: 0,
    freedKb: 0,
    conversationCount: 0,
    runCount: 0,
    withWorkCount: 0,
  };
  const seenRuns = new Set<UUID>();
  for (const entry of selected) {
    if (entry.bucket === 'live') {
      plan.skipped.push({ entry, reason: 'busy' });
      continue;
    }
    if (entry.bucket === 'foreign') {
      plan.skipped.push({ entry, reason: 'foreign' });
      continue;
    }
    plan.worktreeCount++;
    plan.freedKb += entry.sizeKb;
    if (entry.bucket === 'has-work') plan.withWorkCount++;

    const claim = entry.claim;
    // Borrowed rows go whichever way the tree goes.
    for (const id of claim?.adoptedConvIds ?? []) {
      if (id !== claim?.convId && !plan.removeAdoptedIds.includes(id)) {
        plan.removeAdoptedIds.push(id);
        plan.conversationCount++;
      }
    }
    if (claim?.runId) {
      // A workspace run holds several trees. Selecting two of them must not
      // delete the run twice — and deleting the run takes every tree it owns,
      // which the sheet says out loud in the confirm step.
      if (!seenRuns.has(claim.runId)) {
        seenRuns.add(claim.runId);
        plan.removeRunIds.push(claim.runId);
        plan.runCount++;
        // Does this run own trees outside the selection? If so we cannot
        // vouch for them — the user was never shown them — so the delete
        // must go through the runtime's guard rather than around it.
        const owned = all.filter((e) => e.claim?.runId === claim.runId);
        const selectedPaths = new Set(selected.map((e) => e.worktreePath));
        if (owned.some((e) => !selectedPaths.has(e.worktreePath))) {
          plan.runsHoldingMore.push(claim.runId);
        }
      }
      continue;
    }
    if (claim?.convId) {
      plan.removeAgentIds.push(claim.convId);
      plan.conversationCount++;
      continue;
    }
    plan.sweepEntries.push({
      projectPath: entry.projectPath,
      worktreePath: entry.worktreePath,
      branchName: entry.branchName,
      baseBranch: entry.baseBranch,
    });
  }
  return plan;
}

/// The subset of a selection that can be RELEASED rather than deleted: drop
/// the worktree, keep the conversation and its transcript.
///
/// Only conversation-owned trees qualify. A flow run needs its tree for
/// Review & merge, and an orphan has no conversation left to keep — for those
/// two, releasing and deleting are the same act, so the sheet offers only
/// delete and says how many rows it could not release.
export function planRelease(selected: WorktreeSweepEntry[]): {
  releaseIds: UUID[];
  freedKb: number;
  notReleasable: WorktreeSweepEntry[];
} {
  const releaseIds: UUID[] = [];
  const notReleasable: WorktreeSweepEntry[] = [];
  let freedKb = 0;
  for (const entry of selected) {
    if (!isActionable(entry)) continue;
    const convId = entry.claim?.kind === 'conversation' ? entry.claim.convId : undefined;
    if (!convId) {
      notReleasable.push(entry);
      continue;
    }
    releaseIds.push(convId);
    freedKb += entry.sizeKb;
  }
  return { releaseIds, freedKb, notReleasable };
}

export function formatSize(kb: number): string {
  if (kb <= 0) return '—';
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

export function formatAge(at: number, now: number): string | null {
  if (!at) return null;
  const days = Math.floor((now - at) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}
