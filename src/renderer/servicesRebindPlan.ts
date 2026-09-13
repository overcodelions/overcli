// Working out what "move everything to this branch" actually means.
//
// A bulk rebind is by REF, not by path: the services in a workspace live in
// different repos, so `feat/cost-ceiling` is a different directory for each
// one — and some of them will not have that branch at all. So the plan is
// computed per service against its own repo's worktrees, and anything that
// cannot move says so rather than silently staying put.
//
// The other half is the handoff. A flow finishing on a branch is the moment
// you want the stack pointed at it, and it is also the moment the app must
// NOT act on its own: five flows running means five offers, and auto-rebinding
// on completion would restart services under a run you were not watching.
// `handoffOffer` decides whether there is something worth offering; a person
// decides whether to take it.

import type { ServiceSpec } from '@shared/services';
import type { WorktreeChoice } from './worktreeChoices';

export interface RebindTarget {
  serviceId: string;
  ref: string;
  path: string;
}

export interface BulkRebindPlan {
  targets: RebindTarget[];
  /// Services that will not move, and why — a pin, or no such branch in their
  /// repo. Shown before the move, not discovered after it.
  skipped: { serviceId: string; reason: 'pinned' | 'no-such-ref' | 'already-there' }[];
}

/// What moving every unpinned service to `ref` would do.
export function planBulkRebind(
  services: readonly ServiceSpec[],
  choicesByService: Readonly<Record<string, WorktreeChoice[]>>,
  currentRefs: Readonly<Record<string, string | undefined>>,
  ref: string,
): BulkRebindPlan {
  const targets: RebindTarget[] = [];
  const skipped: BulkRebindPlan['skipped'] = [];

  for (const spec of services) {
    if (spec.pinnedRef) {
      skipped.push({ serviceId: spec.id, reason: 'pinned' });
      continue;
    }
    if (currentRefs[spec.id] === ref) {
      skipped.push({ serviceId: spec.id, reason: 'already-there' });
      continue;
    }
    const match = (choicesByService[spec.id] ?? []).find((c) => c.ref === ref);
    if (!match) {
      // The branch exists somewhere in the workspace, just not in this repo.
      // Common and unremarkable: one flow usually touches two of six repos.
      skipped.push({ serviceId: spec.id, reason: 'no-such-ref' });
      continue;
    }
    targets.push({ serviceId: spec.id, ref, path: match.path });
  }

  return { targets, skipped };
}

/// Refs a bulk move could go to, most useful first: the ones the most
/// services can actually reach. A ref only one service has is still offered —
/// moving one service is a perfectly ordinary thing to want.
export function bulkRefOptions(
  choicesByService: Readonly<Record<string, WorktreeChoice[]>>,
): { ref: string; reachable: number }[] {
  const counts = new Map<string, number>();
  for (const choices of Object.values(choicesByService)) {
    // A ref appearing twice in one repo's worktree list would double-count.
    for (const ref of new Set(choices.map((c) => c.ref))) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([ref, reachable]) => ({ ref, reachable }))
    .sort((a, b) => b.reachable - a.reachable || a.ref.localeCompare(b.ref));
}

export interface HandoffOffer {
  ref: string;
  /// Services that could move to it and are not there yet.
  serviceIds: string[];
}

/// Whether a finished flow is worth offering a rebind for.
///
/// Returns null unless the branch is one some unpinned service can actually
/// reach and is not already on — an offer you cannot act on is worse than no
/// offer, and an offer to do what is already done is noise.
export function handoffOffer(
  services: readonly ServiceSpec[],
  choicesByService: Readonly<Record<string, WorktreeChoice[]>>,
  currentRefs: Readonly<Record<string, string | undefined>>,
  ref: string | undefined,
): HandoffOffer | null {
  if (!ref) return null;
  const plan = planBulkRebind(services, choicesByService, currentRefs, ref);
  if (plan.targets.length === 0) return null;
  return { ref, serviceIds: plan.targets.map((t) => t.serviceId) };
}
