// A run that continues a pushed branch whose pull request no longer merges:
// the server starts the merge of the default branch into it, so the run
// resolves the conflicts where they are and its push makes the pull request
// mergeable again. The model never runs git; it only edits the files.
//
// Only on a real conflict. A branch that is merely behind is left as it is:
// a merge commit nobody needed is noise in someone else's pull request.
// The merge is left uncommitted, so the run's change and its resolution
// land as one merge commit (BranchLander commits it), and that commit sits
// on top of the branch, so the push adds to it and is never forced.

export type MergeGit = (args: string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface MergePlace {
  /// The repo's name, as the run sees it.
  name: string;
  worktreePath: string;
  /// The repo's default branch, without `origin/`.
  defaultBranch: string;
}

/// One line per repo where the merge was started, naming the conflicted files.
export async function mergeDefaultWhereConflicting(places: MergePlace[], git: MergeGit): Promise<string[]> {
  const lines: string[] = [];
  for (const p of places) {
    const theirs = `refs/remotes/origin/${p.defaultBranch}`;
    const run = (args: string[]) => git(args, p.worktreePath);
    if ((await run(['rev-parse', '--verify', '--quiet', `${theirs}^{commit}`])).exitCode !== 0) continue;
    // Already has everything the default branch has: nothing to merge.
    if ((await run(['merge-base', '--is-ancestor', theirs, 'HEAD'])).exitCode === 0) continue;
    // Exit 1 is a conflict; 0 merges cleanly; anything else, we can't tell.
    if ((await run(['merge-tree', '--write-tree', 'HEAD', theirs])).exitCode !== 1) continue;
    await run(['merge', '--no-commit', '--no-ff', theirs]);
    const conflicted = await run(['diff', '--name-only', '--diff-filter=U']);
    const files = conflicted.exitCode === 0 ? conflicted.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
    if (!files.length) {
      // Not the state we expected: put the checkout back as it was.
      await run(['merge', '--abort']);
      continue;
    }
    lines.push(`- ${p.name}: merging origin/${p.defaultBranch} conflicts in ${files.join(', ')}`);
  }
  return lines;
}

/// What the run is told, after its prompt, when a merge was started.
export function conflictNote(lines: string[]): string {
  return [
    '',
    '',
    'CONFLICTS TO RESOLVE',
    'This pull request no longer merges cleanly, so the server started merging the default branch',
    'into your checkout. The conflict markers are in these files:',
    ...lines,
    'Resolve every one: keep what both sides meant, remove every marker, and make sure the code',
    'still builds and its tests still pass. Do not commit or abort the merge: the server commits it',
    'with the rest of your change, and refuses to push if a marker is left. Your diff also shows what',
    'the merge brought in from the default branch; that part is not yours to change.',
  ].join('\n');
}

/// Files whose added lines still carry a conflict marker, from a unified diff.
export function leftoverMarkers(diff: string): string[] {
  const files = new Set<string>();
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (/^\+(<{7}|>{7})( |$)/.test(line) && file) files.add(file);
  }
  return [...files];
}
