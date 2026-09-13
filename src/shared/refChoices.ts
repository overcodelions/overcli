// Everywhere a service could run, and the order to offer them in.
//
// A repository presents two different things that both look like "a branch" in
// a menu, and conflating them is what made the old picker unusable:
//
//   A CHECKOUT is a folder that already exists. Pointing a service at one is
//     free, instant, and changes nothing anybody else can see.
//   A BRANCH with no checkout is a request to MOVE a working tree — the same
//     tree a flow may be running in. Same-looking row, entirely different act.
//
// So they are ranked and rendered as two groups, and this module decides what
// goes in each. Pure, because the ordering rules are the whole feature: the
// main checkout and the one you are on must be findable without reading, and
// nothing should appear twice under two names.

import type { WorktreeChoice } from './worktrees';

/// A ref with no checkout of its own.
export interface BranchChoice {
  /// Short name as a user would type it — `master`, `origin/master`,
  /// `feature/XYZ-6814`.
  ref: string;
  remote: boolean;
  /// Relative committer date, when git gave us one.
  when?: string;
}

export interface RefRows {
  checkouts: WorktreeChoice[];
  /// Older checkouts held back until the user types. A repository a flow runner
  /// has been working in for a month has a hundred of them.
  hiddenCheckouts: number;
  branches: BranchChoice[];
  /// Branches matching but not shown, because an unfiltered list of eighty is
  /// what this rework exists to get rid of.
  hiddenBranches: number;
}

/// Parse `git for-each-ref --format '%(refname)\t%(committerdate:relative)'`
/// over `refs/heads` and `refs/remotes`, newest first.
export function parseBranchRefs(stdout: string): BranchChoice[] {
  const out: BranchChoice[] = [];
  for (const line of stdout.split('\n')) {
    const [refname, when] = line.split('\t');
    if (!refname) continue;
    if (refname.startsWith('refs/heads/')) {
      out.push({ ref: refname.slice('refs/heads/'.length), remote: false, when: when || undefined });
      continue;
    }
    if (!refname.startsWith('refs/remotes/')) continue;
    const short = refname.slice('refs/remotes/'.length);
    // `origin/HEAD` is a symref onto whichever branch is default. It is never
    // a thing to check out, and it shows up as a duplicate of the branch it
    // points at.
    if (short.endsWith('/HEAD')) continue;
    out.push({ ref: short, remote: true, when: when || undefined });
  }
  return out;
}

function matches(query: string, ...fields: (string | undefined)[]): boolean {
  if (query === '') return true;
  const needle = query.toLowerCase();
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(needle));
}

/// The checkout list, ranked. The one the service is on and the repository's
/// main checkout lead, because those are the two a person looks for; then the
/// newest, because the tree you want is the one a flow made this afternoon,
/// not whichever sorts first alphabetically; detached trees sink, because a
/// short sha tells you nothing.
function rankCheckouts(
  worktrees: readonly WorktreeChoice[],
  current: string | undefined,
  query: string,
): WorktreeChoice[] {
  const weight = (w: WorktreeChoice): number => {
    if (current !== undefined && w.ref === current) return 0;
    if (w.primary) return 1;
    if (w.detached) return 3;
    return 2;
  };
  return worktrees
    .filter((w) => matches(query, w.ref, w.path))
    .slice()
    .sort(
      (a, b) =>
        weight(a) - weight(b) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        a.ref.localeCompare(b.ref),
    );
}

/// Everything a service could be pointed at, in the order to show it.
export function rankRefs(args: {
  worktrees: readonly WorktreeChoice[];
  branches: readonly BranchChoice[];
  /// The ref the service is bound to now.
  current?: string;
  /// `master` or `main`, pinned to the top of the branch list.
  defaultBranch?: string;
  query: string;
  /// How many branches to show before asking the user to type. Unlimited
  /// while searching — a search that hides matches is worse than a long list.
  limit?: number;
  /// The same, for checkouts. The current and main checkouts rank first, so
  /// they always survive the cut.
  checkoutLimit?: number;
}): RefRows {
  const query = args.query.trim();
  const rankedCheckouts = rankCheckouts(args.worktrees, args.current, query);
  const checkoutLimit = query === '' ? (args.checkoutLimit ?? 8) : rankedCheckouts.length;
  const checkouts = rankedCheckouts.slice(0, checkoutLimit);

  // A branch that already has a checkout is the SAME choice as that checkout,
  // and the old picker's worst habit was offering it twice.
  const checkedOut = new Set(args.worktrees.map((w) => w.ref));
  const localNames = new Set(args.branches.filter((b) => !b.remote).map((b) => b.ref));

  const candidates = args.branches.filter((b) => {
    if (checkedOut.has(b.ref)) return false;
    // `origin/master` next to `master` is one branch wearing two hats. Keep
    // the local one; a remote branch with no local counterpart still shows,
    // because that IS a distinct thing to check out.
    if (b.remote) {
      const bare = b.ref.replace(/^[^/]+\//, '');
      if (localNames.has(bare) || checkedOut.has(bare)) return false;
    }
    return matches(query, b.ref);
  });

  // The default branch first: it is the single most-asked-for ref, and in a
  // repository with eighty branches it otherwise sorts wherever its last
  // commit happened to land.
  const ordered = candidates
    .slice()
    .sort(
      (a, b) =>
        Number(b.ref === args.defaultBranch) - Number(a.ref === args.defaultBranch) ||
        Number(a.remote) - Number(b.remote),
    );

  const limit = query === '' ? (args.limit ?? 6) : ordered.length;
  return {
    checkouts,
    hiddenCheckouts: Math.max(0, rankedCheckouts.length - checkoutLimit),
    branches: ordered.slice(0, limit),
    hiddenBranches: Math.max(0, ordered.length - limit),
  };
}

/// A checkout path short enough for a menu row. The full path is useless at
/// 11px and the basename alone is ambiguous — two worktrees of two repos are
/// both `master`. The last two segments are what tells them apart.
export function shortenPath(full: string): string {
  const parts = full.split('/').filter(Boolean);
  if (parts.length <= 2) return full;
  return `…/${parts.slice(-2).join('/')}`;
}

/// How long ago a worktree was made, in the few characters a menu row has.
export function createdLabel(ms: number | undefined, now: number): string {
  if (ms === undefined) return '';
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
