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
import { isSamePath } from '@shared/pathScope';

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

export interface PinRebindPlan extends BulkRebindPlan {
  /// Services that can actually reach the ref and should be pinned after the
  /// move. A missing branch is never turned into a misleading pin.
  pinIds: string[];
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
    // A pin refuses a move somewhere ELSE. Going to the ref it is already
    // pinned to is what the pin asked for, and refusing that stranded any
    // service whose pin had been written without its move landing: the plan
    // said it would move, and the switch it fed silently would not.
    if (spec.pinnedRef && spec.pinnedRef !== ref) {
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

/// A pin click is stronger than a normal bulk move: it deliberately replaces
/// an older pin, moves what is not already there, then pins every reachable
/// service (including ones already on the selected ref).
export function planPinRebind(
  services: readonly ServiceSpec[],
  choicesByService: Readonly<Record<string, WorktreeChoice[]>>,
  currentRefs: Readonly<Record<string, string | undefined>>,
  ref: string,
): PinRebindPlan {
  const plan = planBulkRebind(
    services.map((service) => ({ ...service, pinnedRef: undefined })),
    choicesByService,
    currentRefs,
    ref,
  );
  return {
    ...plan,
    pinIds: services
      .filter((service) =>
        (choicesByService[service.id] ?? []).some((choice) => choice.ref === ref),
      )
      .map((service) => service.id),
  };
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

/// A checkout a conversation changed files in. `prefix` is set for workspace
/// runs, whose change lists name each file `<member>/<path>`.
export interface ChangedCheckout {
  path: string;
  prefix?: string;
}

export interface ChangedFilesPlan {
  /// Services that own a changed file and can move to the checkout it is in.
  targets: RebindTarget[];
  /// Owners that already run from that checkout — nothing to move, but still
  /// worth a restart so they pick the changes up.
  alreadyThere: string[];
  /// Owners pinned to another ref. The supervisor refuses to move them, so
  /// they are shown with the pin that is in the way rather than dropped.
  pinned: { serviceId: string; pinnedRef: string; target: RebindTarget }[];
}

function normalizeSubpath(subpath: string | undefined): string {
  return (subpath ?? '').replace(/\\/g, '/').replace(/^\.\/?/, '').replace(/\/+$/, '');
}

/// Which services the changes in these checkouts belong to, and what it takes
/// to run them there.
///
/// Matched by checkout PATH, not by branch name: git lists every worktree of a
/// service's repo, so the service whose repo has a worktree at the path the
/// conversation edited is the one in that repo — regardless of whether the
/// tree is on a branch or detached. Within a repo, a service owns a change when
/// the file is under its subpath (or it has none: the whole repo is its code).
export function planChangedFilesRebind(
  services: readonly ServiceSpec[],
  currentPaths: Readonly<Record<string, string | undefined>>,
  choicesByService: Readonly<Record<string, WorktreeChoice[]>>,
  checkouts: readonly ChangedCheckout[],
  files: readonly string[],
): ChangedFilesPlan {
  const plan: ChangedFilesPlan = { targets: [], alreadyThere: [], pinned: [] };

  for (const spec of services) {
    const choices = choicesByService[spec.id] ?? [];
    for (const checkout of checkouts) {
      const match = choices.find((c) => isSamePath(c.path, checkout.path));
      if (!match) continue;

      const lead = checkout.prefix ? `${checkout.prefix}/` : '';
      const inCheckout = files
        .map((f) => f.replace(/\\/g, '/'))
        .filter((f) => f.startsWith(lead))
        .map((f) => f.slice(lead.length));
      const sub = normalizeSubpath(spec.subpath);
      const owns = inCheckout.some((f) => !sub || f === sub || f.startsWith(`${sub}/`));
      if (!owns) continue;

      const target = { serviceId: spec.id, ref: match.ref, path: match.path };
      const current = currentPaths[spec.id];
      if (current && isSamePath(current, match.path)) plan.alreadyThere.push(spec.id);
      else if (spec.pinnedRef && spec.pinnedRef !== match.ref) {
        plan.pinned.push({ serviceId: spec.id, pinnedRef: spec.pinnedRef, target });
      } else plan.targets.push(target);
      break;
    }
  }

  return plan;
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
