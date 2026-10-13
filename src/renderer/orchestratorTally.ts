// Counting batch items by who they wait on — shared by the Orchestrator
// ledger, its rail row, and Today's line for batches you launched yourself.

import type { Orchestration } from '@shared/flows/orchestration';

export interface BatchTally {
  running: number;
  queued: number;
  needsYou: number;
  done: number;
  total: number;
}

/// Count every item on the ledger by who it is waiting on.
///
/// `failed` belongs under "needs you" and at first wasn't: a failed item has
/// stopped dead and nothing moves until someone hits retry, which is the same
/// obligation a paused or proposed one carries. On a ledger with one paused
/// and four failed items, a count that says "1 needs you" is wrong by five.
/// `cancelled` deliberately does NOT count — it is retryable too, but you
/// already decided against it, and a number that says "needs you" has to mean
/// it or it stops being read.
export function tallyOf(batches: Orchestration[]): BatchTally {
  const acc = { running: 0, queued: 0, needsYou: 0, done: 0, total: 0 };
  for (const b of batches) {
    for (const i of b.items) {
      acc.total++;
      if (i.status === 'running') acc.running++;
      else if (i.status === 'queued') acc.queued++;
      else if (i.status === 'done') acc.done++;
      else if (i.status === 'proposed' || i.status === 'paused' || i.status === 'failed') {
        acc.needsYou++;
      }
    }
  }
  return acc;
}

export function isWorkerBatch(b: Orchestration): boolean {
  return b.origin?.kind === 'worker';
}

/// Batches the Workers queue never shows — launched from the Orchestrator
/// (or by a schedule), not by a worker — that are still going, or stopped
/// with something waiting on you. Newest first. A finished batch with only
/// done and cancelled items has nothing left to say.
export function liveOrchestratorBatches(orchestrations: Record<string, Orchestration>): Orchestration[] {
  return Object.values(orchestrations)
    .filter((b) => !isWorkerBatch(b))
    .filter((b) => {
      const t = tallyOf([b]);
      return !b.completedAt || t.needsYou > 0;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/// "1 running · 30 queued" — what is moving, for a rail row or a list line.
export function movingLine(t: BatchTally): string {
  return [t.running > 0 && `${t.running} running`, t.queued > 0 && `${t.queued} queued`]
    .filter(Boolean)
    .join(' · ');
}
