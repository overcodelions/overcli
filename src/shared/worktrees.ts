// The checkouts of a repository, and how to read git's list of them.
//
// Shared because both sides need it: the main process runs the command, and
// the renderer renders the answer. The parsing is pure, so the awkward parts —
// a detached tree with no branch line, the main checkout being first — are
// pinned in tests rather than rediscovered.

export interface WorktreeChoice {
  /// Absolute path to the checkout.
  path: string;
  /// Short ref name, or the abbreviated sha for a detached head.
  ref: string;
  /// True for the repository's main checkout, which git always lists first.
  primary: boolean;
  detached: boolean;
  /// When a linked worktree was created — the birth time of the `.git` file
  /// `git worktree add` writes. Filled in by the main process, which can stat;
  /// absent for the main checkout, which is pinned to the top regardless.
  /// Newest first is how a person finds the tree they are working in among a
  /// hundred, and it is how their Tiltfile already sorts them.
  createdAt?: number;
}

/// Parse `git worktree list --porcelain`. Entries are separated by a blank
/// line; the first is always the main checkout.
export function parseWorktreeList(porcelain: string): WorktreeChoice[] {
  const out: WorktreeChoice[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const pathLine = lines.find((l) => l.startsWith('worktree '));
    if (!pathLine) continue;
    const path = pathLine.slice('worktree '.length);

    const branchLine = lines.find((l) => l.startsWith('branch '));
    const headLine = lines.find((l) => l.startsWith('HEAD '));
    const detached = lines.includes('detached') || !branchLine;

    // A detached tree still has a HEAD, and its short sha is more use in a
    // menu than the word "detached" repeated four times.
    const ref = branchLine
      ? branchLine.slice('branch '.length).replace(/^refs\/heads\//, '')
      : headLine
        ? headLine.slice('HEAD '.length).slice(0, 8)
        : '(unknown)';

    out.push({ path, ref, primary: out.length === 0, detached });
  }
  return out;
}
