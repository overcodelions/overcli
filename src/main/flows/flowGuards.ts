// Referential guards for flow deletion. A flow on a worker's contract or a
// schedule's target can't be deleted out from under it — the dangling id
// would only fail at the next unattended launch, with nobody watching.
// Deliberately blind to enabled/paused state: a paused worker still holds
// the reference and can be resumed. Pure so the rule is testable without
// engines or IPC; src/main/index.ts wires it into `flows:delete`.

import type { Schedule } from '../../shared/flows/schedule';
import type { Worker } from '../../shared/flows/worker';

/// The human-readable reason deletion must be refused, or null when the
/// flow is unreferenced and free to go.
export function flowDeletionBlocker(
  flowId: string,
  workers: Worker[],
  schedules: Schedule[],
): string | null {
  const worker = workers.find((w) => w.flowIds.includes(flowId));
  if (worker) {
    return `The worker "${worker.name}" runs this flow. Point it at another flow — or fire the worker — first.`;
  }
  const schedule = schedules.find((s) => s.target.flowId === flowId);
  if (schedule) {
    return `The schedule "${schedule.name}" runs this flow. Retarget or delete that schedule first.`;
  }
  return null;
}
