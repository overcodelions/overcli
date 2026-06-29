/// Delete a flow run, but stop to confirm first if its worktree(s) have
/// uncommitted changes. The main process refuses an un-forced delete of a
/// dirty run (`needsConfirm`); here we surface that as a warning and, only
/// on explicit confirmation, re-issue the delete with `force: true` so the
/// worktree teardown proceeds. A clean run deletes in one round-trip.
export async function deleteFlowRunWithDirtyGuard(
  runId: string,
): Promise<{ deleted: boolean; error?: string }> {
  let result = await window.overcli.invoke('flows:deleteRun', { runId });
  if (!result.ok && 'needsConfirm' in result && result.needsConfirm) {
    const total = result.dirty.reduce((n, d) => n + d.fileCount, 0);
    const plural = total === 1 ? '' : 's';
    const lead =
      result.dirty.length > 1
        ? `${result.dirty.length} of this run's worktrees have ${total} uncommitted change${plural}`
        : `This run's worktree has ${total} uncommitted change${plural}`;
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
