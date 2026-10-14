// The shape of a stranded-landing audit — worker output that committed but
// never reached its base branch. Shared because both the CLI
// (`overcli workers audit`) and the Workers tab render it; the logic that
// produces it is main/flows/strandedLandings.ts.

export type Landability = 'clean' | 'conflicts' | 'unknown';

/// An "update with base" merge waiting in a worktree for its conflicts to be
/// resolved. Stored on the orchestration item so it survives a restart — a
/// half-merged worktree the app forgot about is exactly the kind of stranded
/// work this feature exists to find.
export interface PendingLandingUpdate {
  branchName: string;
  worktreePath: string;
  conflictFiles: string[];
  startedAt: number;
}

/// What "Update with base" did.
export type LandingUpdateResult =
  | { ok: true; status: 'merged'; branchName: string; headSha: string }
  | { ok: true; status: 'conflicts'; pending: PendingLandingUpdate }
  | { ok: false; error: string };

export interface StrandedLanding {
  workerId: string;
  workerName: string;
  /// The batch the item belongs to, so a UI can link back to its shift.
  orchestrationId: string;
  /// When that batch was created — the day the worker's desk files the turn
  /// under, which is what "go to this shift" has to open on.
  batchCreatedAt: number;
  batchTitle: string;
  itemTitle: string;
  headSha: string;
  branchName?: string;
  finishedAt?: number;
  projectPath: string;
  /// The branch the commit was checked against. Recorded because it is
  /// resolved per item and a reader should not have to guess.
  baseBranch: string;
  landability: Landability;
  /// Paths that collide with base, when `landability` is `conflicts`.
  conflictFiles: string[];
  /// Set while an "update with base" merge is parked mid-conflict in its own
  /// worktree, waiting for someone to resolve it. See main/flows/landingUpdate.
  pendingUpdate?: PendingLandingUpdate;
  /// Commits base has gained since this work forked from it. A rough
  /// staleness measure; null when the merge-base could not be computed.
  baseAdvance: number | null;
  /// Whether `branchName` still names a local branch. The branch is display
  /// only (it is routinely deleted or renamed); the SHA is the real pointer.
  branchResolves: boolean;
}

export interface UnresolvableLanding {
  workerId: string;
  workerName: string;
  batchTitle: string;
  itemTitle: string;
  headSha: string;
  projectPath: string;
  baseBranch: string;
  /// First line of git's complaint — usually a pruned object or a missing
  /// project directory.
  reason: string;
}

export interface LandingRef {
  workerId: string;
  workerName: string;
  itemTitle: string;
  headSha: string;
  projectPath: string;
  baseBranch: string;
}

export interface LandingAudit {
  stranded: StrandedLanding[];
  /// Not ancestors, but their content is already in base (squash merge,
  /// cherry-pick, re-landed). Not a problem; reported so the count adds up.
  absorbed: LandingRef[];
  merged: LandingRef[];
  unresolvable: UnresolvableLanding[];
  /// Done worker items with no `headSha` — finished before the field existed,
  /// or the capture failed. The audit is blind to these, and says so.
  skippedNoSha: number;
}
