// What a worker's run has changed so far, repo by repo: the files, the lines
// added and removed, and the diff itself when asked for. Read from the run's
// own worktrees against the commit each was forked from, so it is there
// before anything is pushed: the moment someone is asked to Continue a push
// is when they want to see what it would push.

import path from 'node:path';
import fs from 'node:fs';
import { worktreeChanges, worktreeDiff } from '../git';
import type { FlowRun } from '../../shared/flows/schema';

export interface RepoChanges {
  name: string;
  branch?: string;
  insertions: number;
  deletions: number;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  /// The unified diff, when asked for; cut at `DIFF_MAX` with a note.
  diff?: string;
}

export interface RunChanges {
  repos: RepoChanges[];
  /// No worktree left to read: the run ended and its checkout was cleaned up.
  gone?: boolean;
}

/// A diff bigger than this is cut: a page, or a Slack file, has to stay readable.
export const DIFF_MAX = 400_000;

/// The run's worktrees, one per repo, with the commit each started from.
function placesOf(run: FlowRun): Array<{ name: string; worktreePath: string; baseline?: string; branch?: string }> {
  if (run.workspaceWorktrees?.length) {
    return run.workspaceWorktrees.map((m) => ({
      name: m.name,
      worktreePath: m.worktreePath,
      ...(run.baselineCommitsByMember?.[m.name]?.commit ? { baseline: run.baselineCommitsByMember[m.name].commit } : {}),
      ...(m.branchName ? { branch: m.branchName } : {}),
    }));
  }
  if (run.worktreePath) {
    return [{
      name: path.basename(run.sourceProjectPath ?? run.projectPath),
      worktreePath: run.worktreePath,
      ...(run.baselineCommit ? { baseline: run.baselineCommit } : {}),
      ...(run.branchName ? { branch: run.branchName } : {}),
    }];
  }
  return [];
}

export async function changesOfRun(run: FlowRun, opts: { diff?: boolean } = {}): Promise<RunChanges> {
  const places = placesOf(run).filter((p) => p.baseline);
  const here = places.filter((p) => fs.existsSync(p.worktreePath));
  if (places.length && !here.length) return { repos: [], gone: true };
  const repos = await Promise.all(
    here.map(async (p): Promise<RepoChanges | null> => {
      const c = await worktreeChanges({ worktreePath: p.worktreePath, baseBranch: '', baselineCommit: p.baseline });
      if (!c.isRepo || !c.changes.length) return null;
      let diff: string | undefined;
      if (opts.diff) {
        const d = await worktreeDiff({ cwd: p.worktreePath, baseBranch: '', baselineCommit: p.baseline });
        diff = d.exitCode === 0 ? (d.stdout.length > DIFF_MAX ? `${d.stdout.slice(0, DIFF_MAX)}\n… cut here: the diff is ${Math.round(d.stdout.length / 1000)} KB.\n` : d.stdout) : undefined;
      }
      return {
        name: p.name,
        ...(p.branch || c.currentBranch ? { branch: p.branch || c.currentBranch } : {}),
        insertions: c.insertions,
        deletions: c.deletions,
        files: c.changes.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
        ...(diff !== undefined ? { diff } : {}),
      };
    }),
  );
  return { repos: repos.filter((r): r is RepoChanges => !!r) };
}

/// One line for a card: "4 files, +62 −18 in api; 1 file, +3 −0 in web".
export function changesSummary(c: RunChanges): string {
  if (!c.repos.length) return c.gone ? 'Its checkout is gone; the changes are on its branch.' : 'No changes yet.';
  return c.repos.map((r) => `${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}, +${r.insertions} −${r.deletions} in ${r.name}`).join('; ');
}

/// Every repo's diff in one file, headed by repo, for a download or Slack.
export function changesAsDiff(c: RunChanges): string {
  return c.repos.map((r) => `# ${r.name}${r.branch ? ` (${r.branch})` : ''}\n${r.diff ?? ''}`).join('\n');
}
