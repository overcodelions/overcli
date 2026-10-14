// "Update with base" for stranded worker output — bring the base branch into
// a shift's commit instead of asking an agent to redo the work.
//
// A shift usually deletes its own worktree, and sometimes its branch, so the
// only durable handle is the commit (`OrchestrationItem.headSha`). This forks
// a fresh branch + worktree from that commit and merges base into it:
//   - merges cleanly → commit the merge, remove the worktree, keep the branch.
//     The work is now up to date with base and ready for a human to merge.
//   - conflicts      → leave the worktree mid-merge for someone to resolve,
//     and hand back where it is. `finishLandingUpdate` accepts the resolution
//     once the merge is committed; `discardLandingUpdate` puts everything
//     back the way it was.
//
// Never touches base, never touches the original branch, never pushes. The
// three operations only ever write to the branch and worktree they create.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGitAsync, type GitResult } from '../git';
import type { LandingUpdateResult, PendingLandingUpdate } from '../../shared/flows/landingAudit';

export interface LandingUpdateDeps {
  git?: (args: string[], cwd: string) => Promise<GitResult>;
  /// Parent directory for the update worktrees. Defaults to the same
  /// `~/.overcli/worktrees/<project>/` every other overcli worktree uses.
  worktreeRoot?: (projectPath: string) => string;
  now?: () => number;
}

function gitOf(deps: LandingUpdateDeps) {
  return deps.git ?? ((args: string[], cwd: string) => runGitAsync(args, cwd));
}

function message(r: GitResult): string {
  return (r.stderr || r.stdout).trim().split('\n')[0] || `git exited ${r.exitCode}`;
}

async function unmergedFiles(git: ReturnType<typeof gitOf>, cwd: string): Promise<string[]> {
  const r = await git(['diff', '--name-only', '--diff-filter=U'], cwd);
  return r.exitCode === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

/// A branch name that is free, valid, and says what it is: the original
/// branch (or the commit) plus `-on-<base>`.
async function freeBranchName(
  git: ReturnType<typeof gitOf>,
  projectPath: string,
  headSha: string,
  baseBranch: string,
  branchName?: string,
): Promise<string | null> {
  const stem = `${branchName?.trim() || `overcli/stranded-${headSha.slice(0, 8)}`}-on-${baseBranch.replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  for (let i = 1; i <= 50; i += 1) {
    const candidate = i === 1 ? stem : `${stem}-${i}`;
    const valid = await git(['check-ref-format', '--branch', candidate], projectPath);
    if (valid.exitCode !== 0) return null;
    const taken = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], projectPath);
    if (taken.exitCode !== 0) return candidate;
  }
  return null;
}

export async function startLandingUpdate(
  args: { projectPath: string; headSha: string; baseBranch: string; branchName?: string },
  deps: LandingUpdateDeps = {},
): Promise<LandingUpdateResult> {
  const git = gitOf(deps);
  const { projectPath, headSha, baseBranch } = args;

  const commit = await git(['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`], projectPath);
  if (commit.exitCode !== 0) return { ok: false, error: `Commit ${headSha.slice(0, 10)} is no longer in ${projectPath}.` };
  const base = await git(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`], projectPath);
  if (base.exitCode !== 0) return { ok: false, error: `Base branch "${baseBranch}" doesn't exist in ${projectPath}.` };

  const branch = await freeBranchName(git, projectPath, headSha, baseBranch, args.branchName);
  if (!branch) return { ok: false, error: 'Could not pick a free branch name for the update.' };

  const root = deps.worktreeRoot?.(projectPath) ?? path.join(os.homedir(), '.overcli', 'worktrees', path.basename(projectPath));
  fs.mkdirSync(root, { recursive: true });
  let worktreePath = path.join(root, branch.replace(/\//g, '-'));
  for (let i = 2; fs.existsSync(worktreePath); i += 1) worktreePath = path.join(root, `${branch.replace(/\//g, '-')}-${i}`);

  const add = await git(['worktree', 'add', '-b', branch, worktreePath, headSha], projectPath);
  if (add.exitCode !== 0) return { ok: false, error: message(add) };

  const merge = await git(
    ['merge', '--no-ff', '--no-edit', '-m', `Merge ${baseBranch} into ${branch}`, baseBranch],
    worktreePath,
  );
  if (merge.exitCode === 0) {
    const head = await git(['rev-parse', 'HEAD'], worktreePath);
    // The branch holds the result; the worktree was only scaffolding.
    await git(['worktree', 'remove', '--force', worktreePath], projectPath);
    return { ok: true, status: 'merged', branchName: branch, headSha: head.stdout.trim() };
  }

  const conflictFiles = await unmergedFiles(git, worktreePath);
  if (conflictFiles.length === 0) {
    // Failed for some reason other than conflicts (identity not set, a hook,
    // a dirty index). Put everything back and say why.
    await discardLandingUpdate(
      { projectPath, pending: { branchName: branch, worktreePath, conflictFiles: [], startedAt: 0 }, headSha },
      deps,
    );
    return { ok: false, error: message(merge) };
  }
  return {
    ok: true,
    status: 'conflicts',
    pending: { branchName: branch, worktreePath, conflictFiles, startedAt: (deps.now ?? Date.now)() },
  };
}

/// Accept a resolved update. Refuses — rather than guessing — while anything
/// would be lost by removing the worktree: a merge still in progress,
/// unresolved paths, or uncommitted edits.
export async function finishLandingUpdate(
  args: { projectPath: string; pending: PendingLandingUpdate; baseBranch: string },
  deps: LandingUpdateDeps = {},
): Promise<{ ok: true; branchName: string; headSha: string } | { ok: false; error: string }> {
  const git = gitOf(deps);
  const { projectPath, pending, baseBranch } = args;
  if (!fs.existsSync(pending.worktreePath)) {
    return { ok: false, error: `The update worktree is gone (${pending.worktreePath}). Discard it and start again.` };
  }
  const unresolved = await unmergedFiles(git, pending.worktreePath);
  if (unresolved.length > 0) return { ok: false, error: `Still conflicted: ${unresolved.join(', ')}` };
  const inMerge = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], pending.worktreePath);
  if (inMerge.exitCode === 0) return { ok: false, error: 'Conflicts are resolved but the merge is not committed yet — run `git commit` in the worktree.' };
  const dirty = await git(['status', '--porcelain'], pending.worktreePath);
  if (dirty.exitCode !== 0 || dirty.stdout.trim()) return { ok: false, error: 'The worktree has uncommitted changes — commit or discard them first.' };
  const contains = await git(['merge-base', '--is-ancestor', baseBranch, 'HEAD'], pending.worktreePath);
  if (contains.exitCode !== 0) return { ok: false, error: `The branch doesn't contain ${baseBranch} yet — was the merge aborted?` };

  const head = await git(['rev-parse', 'HEAD'], pending.worktreePath);
  const removed = await git(['worktree', 'remove', pending.worktreePath], projectPath);
  if (removed.exitCode !== 0) return { ok: false, error: message(removed) };
  return { ok: true, branchName: pending.branchName, headSha: head.stdout.trim() };
}

/// Back out an update: abort the merge, remove the worktree, and delete the
/// branch IF it still points at the original commit (nothing was committed
/// on it). A branch someone did commit to is kept and reported.
export async function discardLandingUpdate(
  args: { projectPath: string; pending: PendingLandingUpdate; headSha: string },
  deps: LandingUpdateDeps = {},
): Promise<{ ok: true; keptBranch?: string } | { ok: false; error: string }> {
  const git = gitOf(deps);
  const { projectPath, pending, headSha } = args;
  if (fs.existsSync(pending.worktreePath)) {
    await git(['merge', '--abort'], pending.worktreePath);
    const removed = await git(['worktree', 'remove', '--force', pending.worktreePath], projectPath);
    if (removed.exitCode !== 0) return { ok: false, error: message(removed) };
  } else {
    await git(['worktree', 'prune'], projectPath);
  }
  const tip = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${pending.branchName}`], projectPath);
  if (tip.exitCode !== 0) return { ok: true };
  if (tip.stdout.trim() !== headSha) return { ok: true, keptBranch: pending.branchName };
  await git(['branch', '-D', pending.branchName], projectPath);
  return { ok: true };
}
