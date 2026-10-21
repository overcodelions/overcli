// The org layer over the roster: who reports to whom, and who manages them.
//
// A worker's `reportsTo` names another worker; its `manager` names a person.
// Together they draw an org chart, and they decide where a question goes when
// the worker that owns a run cannot answer it — up the reporting chain first,
// then to the manager. Everything here is pure: the engine walks the chain,
// the renderer draws the tree, and both read the same rules.

import type { UUID } from '../types';
import type { Worker, WorkerManager } from './worker';

/// How many workers above the owner a question may climb before it goes to a
/// person. An org chart deeper than this is rare, and every hop is a paid
/// turn the stuck run is waiting on.
export const ORG_MAX_ESCALATION_HOPS = 4;

type OrgWorker = Pick<Worker, 'id' | 'reportsTo' | 'enabled'>;

/// The workers above `startId`, nearest first, not including it.
///
/// Stops at a loop, a worker that no longer exists, or the hop limit. A
/// paused boss is skipped rather than ending the chain: it holds no desk, but
/// the worker above it can still answer.
export function reportsChain<T extends OrgWorker>(
  workers: readonly T[],
  startId: UUID,
  maxHops: number = ORG_MAX_ESCALATION_HOPS,
): T[] {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const seen = new Set<UUID>([startId]);
  const chain: T[] = [];
  let next = byId.get(startId)?.reportsTo;
  // Count every step, paused or not, so a loop of paused workers still ends.
  let steps = 0;
  while (next && !seen.has(next) && chain.length < maxHops && steps < workers.length) {
    steps++;
    seen.add(next);
    const boss = byId.get(next);
    if (!boss) break;
    if (boss.enabled) chain.push(boss);
    next = boss.reportsTo;
  }
  return chain;
}

/// Whether setting `id`'s boss to `reportsTo` would close a loop.
export function wouldCycle(workers: readonly OrgWorker[], id: UUID, reportsTo: UUID | undefined): boolean {
  if (!reportsTo) return false;
  if (reportsTo === id) return true;
  const byId = new Map(workers.map((w) => [w.id, w]));
  const seen = new Set<UUID>();
  let cur: UUID | undefined = reportsTo;
  while (cur && !seen.has(cur)) {
    if (cur === id) return true;
    seen.add(cur);
    cur = byId.get(cur)?.reportsTo;
  }
  return false;
}

/// The person a question finally lands on: the owner's manager, or failing
/// that the nearest manager up the chain. A worker hired under a boss worker
/// often has no manager of its own, and its questions should not fall back
/// to the app because nobody filled the field in.
export function managerFor<T extends OrgWorker & Pick<Worker, 'manager'>>(
  workers: readonly T[],
  startId: UUID,
): WorkerManager | undefined {
  const start = workers.find((w) => w.id === startId);
  if (start?.manager) return start.manager;
  // Paused bosses still count here: a paused boss's manager is still the
  // person accountable for the branch.
  const byId = new Map(workers.map((w) => [w.id, w]));
  const seen = new Set<UUID>([startId]);
  let next = start?.reportsTo;
  while (next && !seen.has(next)) {
    seen.add(next);
    const boss = byId.get(next);
    if (!boss) return undefined;
    if (boss.manager) return boss.manager;
    next = boss.reportsTo;
  }
  return undefined;
}

export interface OrgNode<T> {
  worker: T;
  reports: OrgNode<T>[];
}

/// One branch of the chart: a person and the top-level workers they manage.
/// `manager` is absent for the workers nobody manages yet.
export interface OrgBranch<T> {
  manager?: WorkerManager;
  roots: OrgNode<T>[];
}

/// The roster as a chart. A worker whose boss is missing — removed, or from
/// a share file that named someone not hired here — is drawn as a root rather
/// than dropped. Roots are grouped by manager name, so one person's workers
/// sit together, with the unmanaged last.
export function buildOrgTree<T extends OrgWorker & Pick<Worker, 'manager' | 'name'>>(
  workers: readonly T[],
): OrgBranch<T>[] {
  const ids = new Set(workers.map((w) => w.id));
  const children = new Map<UUID, T[]>();
  const roots: T[] = [];
  for (const w of workers) {
    // A loop has no top, so a worker on one is promoted to a root. Its boss
    // still lists it as a report only if that would not revisit it.
    if (w.reportsTo && ids.has(w.reportsTo) && !wouldCycle(workers, w.id, w.reportsTo)) {
      const list = children.get(w.reportsTo) ?? [];
      list.push(w);
      children.set(w.reportsTo, list);
    } else {
      roots.push(w);
    }
  }
  const build = (w: T): OrgNode<T> => ({
    worker: w,
    reports: (children.get(w.id) ?? []).map(build),
  });

  const branches = new Map<string, OrgBranch<T>>();
  const unmanaged: OrgNode<T>[] = [];
  for (const root of roots) {
    const node = build(root);
    const name = root.manager?.name.trim();
    if (!name) {
      unmanaged.push(node);
      continue;
    }
    const key = name.toLowerCase();
    const branch = branches.get(key) ?? { manager: root.manager, roots: [] };
    branch.roots.push(node);
    branches.set(key, branch);
  }
  const out = [...branches.values()];
  if (unmanaged.length) out.push({ roots: unmanaged });
  return out;
}

/// Everyone in a branch, for counts.
export function countNodes<T>(nodes: readonly OrgNode<T>[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.reports), 0);
}
