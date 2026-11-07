// Has this branch's work reached the base, whatever git's history says?
//
// A host that squash-merges records no link from the base back to the branch,
// so ancestry checks read the branch as unmerged forever. A local base can also
// simply be behind origin. Reads local refs only; nothing is fetched.

import { runGitAsync } from './git';

/// Answers keyed on (branch tip, trunk tip): the same pair always gives the
/// same answer, and each check writes one dangling commit object, so it's
/// worth never asking twice.
const squashCache = new Map<string, boolean>();
const SQUASH_CACHE_MAX = 2000;

// commit-tree needs an identity; the object is never referenced, so any will do.
const SQUASH_ENV = {
  GIT_AUTHOR_NAME: 'overcli',
  GIT_AUTHOR_EMAIL: 'overcli@localhost',
  GIT_COMMITTER_NAME: 'overcli',
  GIT_COMMITTER_EMAIL: 'overcli@localhost',
};

/// Squash- (or rebase-) merged: squash the whole branch onto its fork point as
/// one unreferenced commit and ask `git cherry` whether the trunk already has a
/// commit with the same patch. Misses a squash whose content was changed while
/// merging (conflicts resolved, edits in the host's merge UI): that one keeps
/// reading as ahead, the safe way to be wrong.
export async function squashMergedInto(repo: string, ref: string, trunk: string): Promise<boolean> {
  const tips = await runGitAsync(['rev-parse', ref, trunk], repo);
  if (tips.exitCode !== 0) return false;
  const key = tips.stdout.trim().split('\n').join('::');
  const hit = squashCache.get(key);
  if (hit !== undefined) return hit;
  let merged = false;
  const base = await runGitAsync(['merge-base', trunk, ref], repo);
  if (base.exitCode === 0 && base.stdout.trim()) {
    const squash = await runGitAsync(
      ['commit-tree', `${ref}^{tree}`, '-p', base.stdout.trim(), '-m', 'squash check'],
      repo,
      SQUASH_ENV,
    );
    if (squash.exitCode === 0 && squash.stdout.trim()) {
      const cherry = await runGitAsync(['cherry', trunk, squash.stdout.trim()], repo);
      merged = cherry.exitCode === 0 && cherry.stdout.trim().startsWith('-');
    }
  }
  squashCache.set(key, merged);
  if (squashCache.size > SQUASH_CACHE_MAX) {
    const oldest = squashCache.keys().next().value;
    if (oldest !== undefined) squashCache.delete(oldest);
  }
  return merged;
}

export type LandedHow = 'ancestor' | 'squash';

/// How `ref`'s commits reached `base`, or null if they haven't. Origin's copy
/// is asked first: it's where a pull request lands, and the local branch may
/// be behind it. `repo` may be the project or any of its worktrees.
export async function landedOnBase(repo: string, ref: string, base: string): Promise<LandedHow | null> {
  const name = base.replace(/^origin\//, '');
  for (const trunk of [`refs/remotes/origin/${name}`, base]) {
    const ancestor = await runGitAsync(['merge-base', '--is-ancestor', ref, trunk], repo);
    if (ancestor.exitCode === 0) return 'ancestor';
    if (await squashMergedInto(repo, ref, trunk)) return 'squash';
  }
  return null;
}
