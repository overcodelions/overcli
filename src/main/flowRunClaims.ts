// What the flow runtime says about the worktrees it owns.
//
// Runs are the only place a worktree's PRODUCER is recorded. A conversation
// row knows it has a tree; it does not know that a worker's nightly shift
// made it, or that a schedule fires the same flow every morning. Cleanup
// groups by exactly that, so the run list is where the grouping comes from.
//
// Kept pure and apart from `index.ts` so the busy/finished rules — the ones
// that decide whether a tree may be offered for removal — can be tested
// without an Electron main process around them.

import { flowRunTitle } from '../shared/flows/schema';
import type { FlowRun } from '../shared/flows/schema';
import type { WorktreeClaim } from '../shared/types';

/// Whether a run is still working. `running` is obvious; `paused` is the one
/// that matters — a run parked on a question or a failed step still owns its
/// tree and resumes into it, so removing the tree would strand resumable
/// work. `watching` is the post-completion stewardship tail, which can still
/// wake up and act in the tree. Everything else is over.
export function isRunBusy(run: Pick<FlowRun, 'state'>): boolean {
  const kind = run.state.kind;
  return kind === 'running' || kind === 'paused' || kind === 'watching';
}

/// Every worktree a run claims, as cleanup claims. A workspace run holds one
/// tree per member project on top of its own, and each of those is a real
/// directory on disk that the sweep would otherwise call an orphan.
export function flowRunClaims(runs: readonly FlowRun[]): WorktreeClaim[] {
  const out: WorktreeClaim[] = [];
  for (const run of runs) {
    // `checkedOutLocally` clears `worktreePath` after the tree is brought
    // into the main checkout, so a run in that state claims nothing — which
    // is correct: git already removed the tree.
    const paths = [
      ...(run.worktreePath ? [run.worktreePath] : []),
      ...(run.workspaceWorktrees ?? []).map((m) => m.worktreePath),
    ];
    if (paths.length === 0) continue;
    const busy = isRunBusy(run);
    const base: Omit<WorktreeClaim, 'worktreePath'> = {
      kind: 'run',
      runId: run.id,
      title: flowRunTitle(run),
      workerId: run.workerId,
      workerName: run.workerName,
      flowId: run.flowId,
      flowName: run.flowSnapshot?.name,
      scheduleName: run.scheduleName,
      busy,
      finished: !busy,
      // A run that never streamed still has `createdAt`, so every run can be
      // aged even when its tree holds no commits to date it by.
      activeAt: run.lastUserTurnAt ?? run.createdAt,
    };
    for (const worktreePath of paths) out.push({ ...base, worktreePath });
  }
  return out;
}
