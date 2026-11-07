/// A conversation whose worktree is gone from disk, pointing at nothing: the
/// row stays (history intact) and runs in the project checkout from now on,
/// as a released chat does. The branch pointer stays, since the branch may.
export function withoutMissingWorktree<C extends { worktreePath?: string; orphaned?: boolean; adoptedWorktree?: boolean }>(c: C): C {
  const { worktreePath: _wt, orphaned: _or, adoptedWorktree: _ad, ...rest } = c;
  return rest as C;
}
