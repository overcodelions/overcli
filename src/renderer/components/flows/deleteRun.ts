/// Delete a flow run, but stop to confirm first if its worktree(s) still hold
/// work — uncommitted file changes, or commits that were never merged into
/// the run's base branch. The main process refuses an un-forced delete of such
/// a run (`needsConfirm`); here we surface that as a warning and, only
/// on explicit confirmation, re-issue the delete with `force: true` so the
/// worktree teardown proceeds. A clean run deletes in one round-trip.
///
/// The two kinds of loss are named separately on purpose: removing the
/// worktree discards uncommitted files, while the branch delete behind it
/// force-deletes unmerged commits. Saying only "uncommitted changes" told a
/// user whose agent committed its work that nothing was at stake.
export async function deleteFlowRunWithDirtyGuard(
  runId: string,
): Promise<{ deleted: boolean; error?: string }> {
  let result = await window.overcli.invoke('flows:deleteRun', { runId });
  if (!result.ok && 'needsConfirm' in result && result.needsConfirm) {
    const files = result.dirty.reduce((n, d) => n + d.fileCount, 0);
    const commits = result.dirty.reduce((n, d) => n + d.unmergedCommits, 0);
    const what = describeWorkAtRisk(files, commits);
    const lead =
      result.dirty.length > 1
        ? `${result.dirty.length} of this run's worktrees hold ${what}`
        : `This run's worktree holds ${what}`;
    const confirmed = window.confirm(
      `${lead} that will be permanently lost when the worktree is removed.\n\n` +
        `Delete the run anyway?`,
    );
    if (!confirmed) return { deleted: false };
    result = await window.overcli.invoke('flows:deleteRun', { runId, force: true });
  }
  if (!result.ok) {
    return { deleted: false, error: 'error' in result ? result.error : 'Unknown error' };
  }
  return { deleted: true };
}

/// Phrase the work a delete is about to destroy, naming uncommitted files and
/// unmerged commits distinctly and omitting whichever is zero. The main
/// process only reports a worktree when at least one is non-zero, so the
/// both-zero fallback is belt-and-braces rather than a reachable state.
export function describeWorkAtRisk(files: number, commits: number): string {
  const parts: string[] = [];
  if (files > 0) parts.push(`${files} uncommitted file change${files === 1 ? '' : 's'}`);
  if (commits > 0) parts.push(`${commits} unmerged commit${commits === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' and ') : 'unreviewed work';
}
