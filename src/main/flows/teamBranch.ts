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

import { credentialGitEnv } from '../org/repos';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autoCommitIfDirty, detectBaseBranch, mergeAgent, pushBranch, removeWorktree, runGit } from '../git';

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
  ahead?: number;
  pushed?: { at: number; url?: string };
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
  /// When the piece's run started (ms), to spot branches it made on the side.
  startedAt?: number;
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

/// Branches that took commits since `since` (ms) which the task branch does
/// not have, and which no checkout has on: work committed on the side. A
/// sibling piece's branch is checked out in its own worktree, and your own
/// branch in your checkout, so neither counts.
export function strayBranches(repo: string, taskBranch: string, since: number, own: string[]): string[] {
  const refs = runGit(
    ['for-each-ref', `--no-merged=refs/heads/${taskBranch}`, '--format=%(refname:short)%09%(committerdate:unix)', 'refs/heads'],
    repo,
  );
  if (refs.exitCode !== 0) return [];
  const checkedOut = new Set(
    runGit(['worktree', 'list', '--porcelain'], repo)
      .stdout.split('\n')
      .filter((l) => l.startsWith('branch refs/heads/'))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  return refs.stdout
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([name, at]) => name && Number(at) * 1000 >= since && !checkedOut.has(name) && !own.includes(name))
    .map(([name]) => name);
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
  /// Fork off this branch where a repo has it (an earlier stage's work), not
  /// the base. It still lands on the base.
  from?: string;
}): Result<{ code: TaskCode | null }> {
  if (args.repos.length === 0) return { ok: true, code: null };
  const stem = `team/${slug(args.title)}`;
  let branch = stem;
  for (let n = 2; args.repos.some((r) => branchExists(r.projectPath, branch)); n++) branch = `${stem}-${n}`;
  const root = path.join(os.homedir(), '.overcli', 'team-worktrees', args.taskId);
  const opened: TaskRepo[] = [];
  const taken = new Set<string>();
  for (const repo of args.repos) {
    const base = detectBaseBranch(repo.projectPath);
    const from = args.from && branchExists(repo.projectPath, args.from) ? args.from : base;
    // Unique per repo: two workspace members named `api` (or `My App` and
    // `my-app`) slug alike, and must not share the task's checkout.
    let dir = slug(repo.name);
    for (let n = 2; taken.has(dir); n++) dir = `${slug(repo.name)}-${n}`;
    taken.add(dir);
    const worktreePath = path.join(root, dir);
    fs.mkdirSync(root, { recursive: true });
    const res = runGit(['worktree', 'add', '-b', branch, worktreePath, from], repo.projectPath);
    if (res.exitCode !== 0) {
      for (const done of opened) removeWorktree({ projectPath: done.projectPath, worktreePath: done.worktreePath, branchName: branch });
      return { ok: false, error: `Could not start the task branch in ${repo.name}: ${(res.stderr || res.stdout).trim()}` };
    }
    opened.push({ name: repo.name, projectPath: repo.projectPath, base, worktreePath });
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
    // Only the branch the piece was given gets merged. A piece that moved its
    // checkout, or committed on a branch of its own, would otherwise be
    // dropped without a word — so stop and say where its work went.
    const on = runGit(['branch', '--show-current'], p.worktreePath).stdout.trim();
    if (on !== p.branchName) {
      return {
        ok: false,
        conflict: true,
        error:
          `${repo.name}: this piece left its branch \`${p.branchName}\` for ${on ? `\`${on}\`` : 'a detached checkout'}, ` +
          `so its work is not where the team merges from. Merge it into \`${args.code.branch}\` yourself in ` +
          `${repo.worktreePath}, then Retry — or Continue without it.`,
      };
    }
    if (p.startedAt) {
      const stray = strayBranches(repo.projectPath, args.code.branch, p.startedAt, [p.branchName]);
      if (stray.length > 0) {
        const named = stray.map((b) => `\`${b}\``).join(', ');
        return {
          ok: false,
          conflict: true,
          error:
            `${repo.name}: while this piece ran, ${named} took commits that are not on the task branch — ` +
            `likely the piece's work, committed on the side. Merge ${stray.length === 1 ? 'it' : 'them'} into ` +
            `\`${args.code.branch}\` yourself in ${repo.worktreePath}, then Retry — or Continue without ${stray.length === 1 ? 'it' : 'them'}.`,
        };
      }
    }
    // The piece's repo may carry hooks a worker wrote; neither the commit nor the merge runs them.
    const commit = autoCommitIfDirty(p.worktreePath, args.message, undefined, { env: credentialGitEnv(), noHooks: true });
    if (!commit.ok) {
      return {
        ok: false,
        error: `${repo.name}: the piece's work could not be committed, so it was not merged. ${commit.error.trim()}`,
      };
    }
    const ahead = runGit(['rev-list', '--count', `${args.code.branch}..${p.branchName}`], repo.projectPath);
    if (ahead.exitCode === 0 && Number(ahead.stdout.trim()) === 0) continue;
    const merge = runGit(['-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-verify', '-m', args.message, p.branchName], repo.worktreePath);
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

/// How many commits the task branch has that each repo's base does not —
/// which repos the task actually changed. Null where git could not say.
export function taskBranchAhead(code: TaskCode): Array<number | null> {
  return code.repos.map((repo) => {
    const res = runGit(['rev-list', '--count', `${repo.base}..${code.branch}`], repo.projectPath);
    return res.exitCode === 0 ? Number(res.stdout.trim()) : null;
  });
}

/// Push the task branch from one repo, for a pull request you open. Work left
/// uncommitted in the task's checkout is committed first, as for any push.
export function pushTaskBranch(
  code: TaskCode,
  repo: TaskRepo,
  subject: string,
): Result<{ message: string; compareUrl?: string }> {
  return pushBranch({ worktreePath: repo.worktreePath, branchName: code.branch, commitSubject: subject, env: credentialGitEnv(), noHooks: true });
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
