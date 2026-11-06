// The sidebar's "worktrees are piling up" count.
//
// Deliberately an ESTIMATE read from app state alone: no `git worktree list`,
// no `git status`, no `du`. The real scan takes minutes on a large install and
// startup cost is precious — a badge that made the app slower to open would be
// a worse bug than the pile it was warning about.
//
// So it counts what state can say for free: idle worktrees old enough for the
// auto-tidy rules to be interested in them. Whether each one is actually clean
// and merged is what opening Clean up finds out, which is why this reads as a
// count of worktrees to LOOK at, never a promise of what can be deleted.

import type { Conversation, UUID } from '@shared/types';
import type { FlowRun } from '@shared/flows/schema';
import type { CleanupRules } from '@shared/cleanupRules';

const DAY_MS = 24 * 60 * 60 * 1000;

export function estimateTidyCandidates(args: {
  owners: Array<{ conversations: Conversation[] }>;
  runs: FlowRun[];
  runningById: Record<UUID, boolean>;
  rules: CleanupRules;
  now: number;
}): number {
  const { rules } = args;
  if (rules.retireAfterDays <= 0) return 0;
  const cutoff = args.now - rules.retireAfterDays * DAY_MS;

  // Per producer, so the "keep the newest few" rule is reflected here too —
  // otherwise the badge would nag about worktrees the rules would never touch.
  // A workspace run is one unit however many trees it holds, as in `retirable`.
  const byProducer = new Map<string, Array<{ at: number; trees: number }>>();
  const add = (key: string, at: number, trees = 1) => {
    const list = byProducer.get(key);
    if (list) list.push({ at, trees });
    else byProducer.set(key, [{ at, trees }]);
  };

  const runByWorktree = new Map<string, FlowRun>();
  for (const run of args.runs) {
    if (run.worktreePath) runByWorktree.set(run.worktreePath, run);
    for (const m of run.workspaceWorktrees ?? []) runByWorktree.set(m.worktreePath, run);
  }

  for (const owner of args.owners) {
    for (const conv of owner.conversations ?? []) {
      if (!conv.worktreePath || conv.adoptedWorktree) continue;
      if (args.runningById[conv.id]) continue;
      // A run's own tree is counted through the run below, where the producer
      // is known; counting it here as well would double it.
      if (runByWorktree.has(conv.worktreePath)) continue;
      add('chat', conv.lastActiveAt ?? conv.createdAt ?? 0);
    }
  }

  const treesByRun = new Map<FlowRun, number>();
  for (const run of runByWorktree.values()) treesByRun.set(run, (treesByRun.get(run) ?? 0) + 1);
  for (const [run, trees] of treesByRun) {
    const kind = run.state.kind;
    if (kind === 'running' || kind === 'paused' || kind === 'watching') continue;
    add(run.workerId ? `worker:${run.workerId}` : `flow:${run.flowId}`, run.lastUserTurnAt ?? run.createdAt, trees);
  }

  let count = 0;
  for (const units of byProducer.values()) {
    const ordered = [...units].sort((a, b) => b.at - a.at);
    for (const { at, trees } of ordered.slice(Math.max(0, rules.keepPerProducer))) {
      // An undated row is never nagged about — see `retirable`.
      if (at === 0 || at >= cutoff) continue;
      count += trees;
    }
  }
  return count;
}
