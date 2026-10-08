// A team task's code lives on ONE branch: `team/<task>` in every repo the
// task works in — the project itself, or each member of a workspace, under
// the same name so a workspace run can fork all of its members off it.
//
// Each piece still runs in a worktree of its own (parallel members must not
// write into one checkout), but forks off the task branch, so a later stage
// starts from everything earlier stages did. When a piece finishes, its
// commits are merged into the task branch — in a worktree the task keeps for
// itself, never your checkout, which this never switches or touches. At the
// end the task branch merges into each repo's base like any agent branch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoCommitIfDirty, detectBaseBranch, mergeAgent, removeWorktree, runGit } from '../git';

export interface TaskRepo {
  /// The repo's name, for messages ("overgit").
  name: string;
  projectPath: string;
  /// The branch the task branch was cut from, and merges back into.
  base: string;
  /// The task's own checkout of the task branch, where pieces merge.
  worktreePath: string;
  /// Merged into `base` by you.
  landed?: boolean;
}

export interface TaskCode {
  branch: string;
  repos: TaskRepo[];
}

/// A piece's run, as git sees it: one worktree and branch per repo it forked.
export interface PieceRepo {
  projectPath: string;
  worktreePath: string;
  branchName: string;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  );
}

function isRepo(dir: string): boolean {
  return runGit(['rev-parse', '--is-inside-work-tree'], dir).exitCode === 0;
}

function branchExists(repo: string, branch: string): boolean {
  return runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).exitCode === 0;
}

/// The git repos a task in `projectPath` works in: the members of a
/// workspace, or the project itself. Folders that are not repos are left
/// out — a research task in a plain folder has no branch to share.
export function taskRepos(
  projectPath: string,
  workspaces: Array<{ rootPath: string; memberPaths: string[] }>,
): Array<{ name: string; projectPath: string }> {
  const workspace = workspaces.find((w) => w.rootPath === projectPath);
  const dirs = workspace ? workspace.memberPaths : [projectPath];
  return dirs.filter((dir) => fs.existsSync(dir) && isRepo(dir)).map((dir) => ({ name: path.basename(dir), projectPath: dir }));
}

/// Cut the task branch in every repo, each from that repo's own base (a
/// workspace whose members disagree — one `main`, one `master` — still
/// works), with a worktree of its own for merging pieces into. Null when no
/// repo is involved. All or nothing: a repo that fails rolls back the rest.
export function openTaskBranch(args: {
  taskId: string;
  title: string;
  repos: Array<{ name: string; projectPath: string }>;
}): Result<{ code: TaskCode | null }> {
  if (args.repos.length === 0) return { ok: true, code: null };
  const base = `team/${slug(args.title)}`;
  let branch = base;
  for (let n = 2; args.repos.some((r) => branchExists(r.projectPath, branch)); n++) branch = `${base}-${n}`;
  const root = path.join(os.homedir(), '.overcli', 'team-worktrees', args.taskId);
  const opened: TaskRepo[] = [];
  for (const repo of args.repos) {
    const from = detectBaseBranch(repo.projectPath);
    const worktreePath = path.join(root, slug(repo.name));
    fs.mkdirSync(root, { recursive: true });
    const res = runGit(['worktree', 'add', '-b', branch, worktreePath, from], repo.projectPath);
    if (res.exitCode !== 0) {
      for (const done of opened) removeWorktree({ projectPath: done.projectPath, worktreePath: done.worktreePath, branchName: branch });
      return { ok: false, error: `Could not start the task branch in ${repo.name}: ${(res.stderr || res.stdout).trim()}` };
    }
    opened.push({ name: repo.name, projectPath: repo.projectPath, base: from, worktreePath });
  }
  return { ok: true, code: { branch, repos: opened } };
}

/// Merge a finished piece into the task branch, repo by repo. Work the piece
/// left uncommitted is committed first (as "Review & merge" does). A
/// conflict aborts that repo's merge — the task branch is never left
/// half-merged — and says where to resolve it.
export function absorbPiece(args: {
  code: TaskCode;
  piece: PieceRepo[];
  message: string;
}): Result<{ merged: string[] }> | { ok: false; error: string; conflict: true } {
  const merged: string[] = [];
  for (const p of args.piece) {
    const repo = args.code.repos.find((r) => path.resolve(r.projectPath) === path.resolve(p.projectPath));
    if (!repo || !p.branchName) continue;
    const commit = autoCommitIfDirty(p.worktreePath, args.message);
    if (!commit.ok) {
      return {
        ok: false,
        error: `${repo.name}: the piece's work could not be committed, so it was not merged. ${commit.error.trim()}`,
      };
    }
    const ahead = runGit(['rev-list', '--count', `${args.code.branch}..${p.branchName}`], repo.projectPath);
    if (ahead.exitCode === 0 && Number(ahead.stdout.trim()) === 0) continue;
    const merge = runGit(['merge', '--no-ff', '-m', args.message, p.branchName], repo.worktreePath);
    if (merge.exitCode !== 0) {
      runGit(['merge', '--abort'], repo.worktreePath);
      return {
        ok: false,
        conflict: true,
        error:
          `${repo.name}: this piece's changes conflict with the task branch. Merge \`${p.branchName}\` into ` +
          `\`${args.code.branch}\` yourself in ${repo.worktreePath}, then Retry — or Continue without them.`,
      };
    }
    merged.push(repo.name);
  }
  return { ok: true, merged };
}

/// Merge the task branch into one repo's base, in your checkout — which has
/// to be on that base and clean, the same rule as merging any agent branch.
export function landTaskBranch(code: TaskCode, repo: TaskRepo, subject: string): Result<{ message: string }> {
  return mergeAgent({
    projectPath: repo.projectPath,
    worktreePath: repo.worktreePath,
    branchName: code.branch,
    target: repo.base,
    baseBranch: repo.base,
    commitSubject: subject,
  });
}

/// Take the task's worktrees down. The branch goes too once landed; one with
/// work not yet in its base is kept, so deleting a task never loses code.
export function closeTaskBranch(code: TaskCode): void {
  for (const repo of code.repos) {
    if (repo.landed) {
      removeWorktree({ projectPath: repo.projectPath, worktreePath: repo.worktreePath, branchName: code.branch });
    } else {
      runGit(['worktree', 'remove', '--force', repo.worktreePath], repo.projectPath);
    }
  }
}
