// Picking a branch for each service, then moving them all at once.
//
// The per-row menu moves one service the moment you click, and the bulk
// switch moves every service to ONE ref. Neither fits "the REST services on
// one ticket, the front end on another, the rest on master": that took a
// click, a wait for the relaunch, and another click, service by service.
//
// The sheet collects picks first and moves on Apply. What makes that more
// than a loop over the single-service move is the folder: a pick of a branch
// with no checkout moves the bound FOLDER, and every other service bound to
// that folder moves with it whether it was picked or not. So the plan says
// so before the click — who follows, and which two picks want the same
// folder on different branches — rather than letting the last one win.
//
// Pure, so the ordering rules are testable without a sheet around them.

import type { BranchChoice, WorktreeChoice } from './worktreeChoices';

/// Where one service is headed.
export type BranchPick =
  /// An existing checkout. Pointing a service at it touches no folder.
  | { kind: 'checkout'; ref: string; path: string }
  /// A branch with no checkout: the service's own folder is checked out to it.
  | { kind: 'branch'; ref: string; remote?: boolean };

/// What git will call it once there: a tracked `origin/feature/x` is checked
/// out as `feature/x`.
export function landsAs(pick: BranchPick): string {
  return pick.kind === 'branch' && pick.remote ? pick.ref.replace(/^[^/]+\//, '') : pick.ref;
}

/// The same ref as `ref`, found among another repo's checkouts and branches —
/// how one pick reaches services that do not share the picked one's list.
/// A checkout wins over a branch of the same name, and the main checkout over
/// a scratch one, because neither moves a folder.
export function resolveRef(
  ref: string,
  refs: { worktrees: readonly WorktreeChoice[]; branches: readonly BranchChoice[] },
): BranchPick | undefined {
  const trees = refs.worktrees.filter((w) => w.ref === ref);
  const tree = trees.find((w) => w.primary) ?? trees[0];
  if (tree) return { kind: 'checkout', ref: tree.ref, path: tree.path };
  const local = refs.branches.find((b) => !b.remote && b.ref === ref);
  if (local) return { kind: 'branch', ref: local.ref };
  const remote = refs.branches.find((b) => b.remote && landsAs({ kind: 'branch', ref: b.ref, remote: true }) === ref);
  if (remote) return { kind: 'branch', ref: remote.ref, remote: true };
  return undefined;
}

/// A service as the plan needs it: where it is now.
export interface PickService {
  key: string;
  ref: string;
  path: string;
}

export type PickStep =
  | { key: string; kind: 'rebind'; ref: string; path: string }
  /// `ref` is what to check out, `to` what git will call it after.
  | { key: string; kind: 'checkout'; ref: string; to: string }
  /// Bound to a folder another step checks out. `picked` is false for a
  /// service nobody chose — it moves only because it shares the folder.
  | { key: string; kind: 'follow'; ref: string; path: string; after: string; picked: boolean };

export interface PicksPlan {
  /// In the order to run them: services leaving a shared folder go first, so
  /// a checkout of that folder does not drag them along on the way out.
  steps: PickStep[];
  /// Picks that want a folder on a different branch than an earlier pick of
  /// the same folder. They are not run.
  conflicts: { key: string; with: string }[];
}

/// Where a step leaves its service.
export function stepTarget(step: PickStep): string {
  return step.kind === 'checkout' ? step.to : step.ref;
}

export function planPicks(
  services: readonly PickService[],
  picks: Readonly<Record<string, BranchPick>>,
): PicksPlan {
  const rebinds: PickStep[] = [];
  const checkouts: PickStep[] = [];
  const follows: PickStep[] = [];
  const conflicts: PicksPlan['conflicts'] = [];

  // The first branch pick of a folder decides where it goes.
  const folderOwner = new Map<string, { key: string; ref: string }>();
  for (const service of services) {
    const pick = picks[service.key];
    if (!pick) continue;
    const ref = landsAs(pick);
    if (pick.kind === 'checkout') {
      if (pick.path !== service.path || pick.ref !== service.ref) {
        rebinds.push({ key: service.key, kind: 'rebind', ref: pick.ref, path: pick.path });
      }
      continue;
    }
    const owner = folderOwner.get(service.path);
    if (!owner) {
      if (ref === service.ref) continue;
      folderOwner.set(service.path, { key: service.key, ref });
      checkouts.push({ key: service.key, kind: 'checkout', ref: pick.ref, to: ref });
    } else if (owner.ref !== ref) {
      conflicts.push({ key: service.key, with: owner.key });
    }
  }

  // Everyone else on a folder that moves, unless their own pick takes them
  // somewhere else first.
  for (const service of services) {
    const owner = folderOwner.get(service.path);
    if (!owner || owner.key === service.key) continue;
    const pick = picks[service.key];
    if (pick?.kind === 'checkout') continue;
    if (conflicts.some((c) => c.key === service.key)) continue;
    follows.push({
      key: service.key,
      kind: 'follow',
      ref: owner.ref,
      path: service.path,
      after: owner.key,
      picked: pick !== undefined,
    });
  }

  return { steps: [...rebinds, ...checkouts, ...follows], conflicts };
}
