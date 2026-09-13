// The worktrees a service could be bound to.
//
// `git worktree list --porcelain` is the whole source: it names every checkout
// of a repo, including the main one, with the branch each is on. That is
// exactly the set a rebind can choose between, and it stays true when a flow
// adds or deletes a tree without anyone telling us.
//
// Asked of the MAIN process rather than run from here. The renderer's git
// allowlist covers read-oriented commands for the diff and branch pickers, and
// `worktree` is not among them — so this used to come back refused, and a
// refusal is indistinguishable from a repo that genuinely has one checkout.
// The pane then said "no other checkouts of this repo", politely and wrongly.

export { parseWorktreeList, type WorktreeChoice } from '@shared/worktrees';
export {
  createdLabel,
  rankRefs,
  shortenPath,
  type BranchChoice,
  type RefRows,
} from '@shared/refChoices';
import type { WorktreeChoice } from '@shared/worktrees';
import type { BranchChoice } from '@shared/refChoices';

/// Fetch the choices for a checkout. Returns an empty list rather than
/// throwing when the path is not a repo (or has gone), because a missing
/// worktree is routine here — flows delete their scratch trees mid-session.
export async function worktreeChoices(cwd: string): Promise<WorktreeChoice[]> {
  try {
    return await window.overcli.invoke('services:worktrees', cwd);
  } catch {
    return [];
  }
}

/// Checkouts AND the branches that have none. Same failure mode as above: a
/// repo that cannot be read comes back empty rather than throwing, because a
/// flow deleting its scratch tree mid-session is routine here.
export async function refChoices(
  cwd: string,
): Promise<{ worktrees: WorktreeChoice[]; branches: BranchChoice[]; defaultBranch?: string }> {
  try {
    return await window.overcli.invoke('services:refs', cwd);
  } catch {
    return { worktrees: [], branches: [] };
  }
}
