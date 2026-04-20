// Git worktree / branch operations for agent conversations. Shells out to
// the `git` binary. When the app is launched from Finder its inherited
// PATH is minimal (/usr/bin:/bin only), so we resolve git explicitly from
// common install locations and extend PATH on every spawn.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { RemoteKind, WorktreeStatus } from '../shared/types';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function resolveGitBinary(): string {
  const home = os.homedir();
  const candidates =
    process.platform === 'win32'
      ? [
          process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Git', 'cmd', 'git.exe') : '',
          process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Git', 'bin', 'git.exe') : '',
          process.env['ProgramFiles(x86)']
            ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd', 'git.exe')
            : '',
          process.env['LOCALAPPDATA']
            ? path.join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'cmd', 'git.exe')
            : '',
          path.join(home, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
          path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
          'C:\\ProgramData\\chocolatey\\bin\\git.exe',
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Program Files\\Git\\bin\\git.exe',
        ]
      : [
          '/opt/homebrew/bin/git',
          '/usr/local/bin/git',
          '/usr/bin/git',
          `${home}/.local/bin/git`,
        ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return 'git';
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const home = os.homedir();
  const extras =
    process.platform === 'win32'
      ? [
          process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Git', 'cmd') : '',
          process.env['ProgramFiles'] ? path.join(process.env['ProgramFiles'], 'Git', 'bin') : '',
          process.env['ProgramFiles(x86)']
            ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'cmd')
            : '',
          process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Programs', 'Git', 'cmd') : '',
          'C:\\ProgramData\\chocolatey\\bin',
          path.join(home, 'scoop', 'shims'),
          path.join(home, 'AppData', 'Roaming', 'npm'),
        ]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          `${home}/.local/bin`,
        ];
  const current = env.PATH ?? '';
  env.PATH = [...extras, ...current.split(path.delimiter)].filter(Boolean).join(path.delimiter);
  return env;
}

/// Best-guess "base branch" for new agents. Prefers the currently
/// checked-out local branch (so agents inherit the user's WIP branch),
/// falls back to origin/HEAD → main → master. Mirrors the Swift
/// preferredAgentBaseBranch + defaultBranch pair.
export function detectBaseBranch(projectPath: string): string {
  const current = runGit(['branch', '--show-current'], projectPath);
  if (current.exitCode === 0) {
    const trimmed = current.stdout.trim();
    if (trimmed) return trimmed;
  }
  const head = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], projectPath);
  if (head.exitCode === 0) {
    const parts = head.stdout.trim().split('/');
    const short = parts[parts.length - 1];
    if (short) return short;
  }
  if (runGit(['rev-parse', '--verify', 'main'], projectPath).exitCode === 0) return 'main';
  if (runGit(['rev-parse', '--verify', 'master'], projectPath).exitCode === 0) return 'master';
  return 'main';
}

export function listBaseBranches(projectPath: string): string[] {
  const branches: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    branches.push(trimmed);
  };

  const local = runGit(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'],
    projectPath,
  );
  if (local.exitCode === 0) {
    local.stdout.split(/\r?\n/).forEach(push);
  }

  const remote = runGit(
    ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes'],
    projectPath,
  );
  if (remote.exitCode === 0) {
    for (const ref of remote.stdout.split(/\r?\n/)) {
      const trimmed = ref.trim();
      if (!trimmed || trimmed === 'origin' || trimmed.endsWith('/HEAD')) continue;
      push(trimmed);
      if (trimmed.startsWith('origin/')) push(trimmed.slice('origin/'.length));
    }
  }

  const detected = detectBaseBranch(projectPath);
  if (resolveBaseBranchStartPoint(projectPath, detected)) {
    branches.unshift(detected);
    return branches.filter((branch, index, list) => list.indexOf(branch) === index);
  }

  return branches;
}

function resolveBaseBranchStartPoint(projectPath: string, baseBranch: string): string | null {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  push(baseBranch);
  push(`refs/heads/${baseBranch}`);
  push(`origin/${baseBranch}`);
  push(`refs/remotes/${baseBranch}`);
  push(`refs/remotes/origin/${baseBranch}`);

  for (const candidate of candidates) {
    const ref = runGit(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], projectPath);
    if (ref.exitCode === 0) return candidate;
  }
  return null;
}

export function runGit(args: string[], cwd: string): GitResult {
  const bin = resolveGitBinary();
  const res = spawnSync(bin, args, { cwd, encoding: 'utf-8', env: gitEnv() });
  if (res.error) {
    return { stdout: '', stderr: res.error.message, exitCode: -1 };
  }
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    exitCode: res.status ?? -1,
  };
}

function runGitNoPrompt(args: string[], cwd: string): GitResult {
  const bin = resolveGitBinary();
  const res = spawnSync(bin, args, {
    cwd,
    encoding: 'utf-8',
    env: { ...gitEnv(), GIT_TERMINAL_PROMPT: '0' },
  });
  if (res.error) {
    return { stdout: '', stderr: res.error.message, exitCode: -1 };
  }
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    exitCode: res.status ?? -1,
  };
}

function gitPathExists(cwd: string, relPath: string): boolean {
  const res = runGit(['rev-parse', '--git-path', relPath], cwd);
  return res.exitCode === 0 && !!res.stdout.trim() && fs.existsSync(res.stdout.trim());
}

export interface CreateWorktreeArgs {
  projectPath: string;
  agentName: string;
  baseBranch: string;
  branchPrefix: string;
}

/// Creates `~/.overcli/worktrees/<project-slug>/<agent-name>/` with a new
/// branch off `baseBranch`. Matches the layout the Swift app used so a
/// user migrating between builds reuses the same on-disk worktrees.
export function createWorktree(
  args: CreateWorktreeArgs,
): { ok: true; worktreePath: string; branchName: string } | { ok: false; error: string } {
  // Sanity: the project dir must itself be a git repo.
  const repoCheck = runGit(['rev-parse', '--is-inside-work-tree'], args.projectPath);
  if (repoCheck.exitCode !== 0) {
    return {
      ok: false,
      error: `${args.projectPath} isn't a git repo. Initialize one (\`git init\`) or pick a different project.`,
    };
  }
  // Verify the base branch exists so we give a clear error instead of
  // git's cryptic "invalid reference" output.
  const startPoint = resolveBaseBranchStartPoint(args.projectPath, args.baseBranch);
  if (!startPoint) {
    return {
      ok: false,
      error: `Base branch "${args.baseBranch}" doesn't exist in ${args.projectPath}. Pick one that does (e.g. main).`,
    };
  }

  const slug = path.basename(args.projectPath);
  const root = path.join(os.homedir(), '.overcli', 'worktrees', slug);
  fs.mkdirSync(root, { recursive: true });
  const worktreePath = path.join(root, args.agentName);
  const branchName = `${args.branchPrefix}${args.agentName}`;

  // If the destination already has a worktree, fail loudly instead of
  // silently reusing — the conversation it's attached to is gone by the
  // time the user hits this code path.
  if (fs.existsSync(worktreePath)) {
    return {
      ok: false,
      error: `A worktree already exists at ${worktreePath}. Remove it first or pick a different name.`,
    };
  }

  const existsBranch = runGit(['rev-parse', '--verify', branchName], args.projectPath);
  const gitArgs =
    existsBranch.exitCode === 0
      ? ['worktree', 'add', worktreePath, branchName]
      : ['worktree', 'add', '-b', branchName, worktreePath, startPoint];
  const res = runGit(gitArgs, args.projectPath);
  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: res.stderr.trim() || res.stdout.trim() || `git exited with ${res.exitCode}`,
    };
  }
  return { ok: true, worktreePath, branchName };
}

/// Create a detached-HEAD worktree pointing at `targetBranch` — used by
/// the review agent so the user can examine someone else's branch
/// without disturbing their main checkout. We don't create a new branch
/// here; the worktree lives at the same commit the target points to and
/// will show as detached in `git status`. Resolves local refs first,
/// then `origin/<branch>`. Fetches from origin before resolving so newly
/// pushed branches show up without the user having to `git fetch` first.
export function createReviewWorktree(args: {
  projectPath: string;
  agentName: string;
  targetBranch: string;
}): { ok: true; worktreePath: string; resolvedTarget: string } | { ok: false; error: string } {
  const repoCheck = runGit(['rev-parse', '--is-inside-work-tree'], args.projectPath);
  if (repoCheck.exitCode !== 0) {
    return { ok: false, error: `${args.projectPath} isn't a git repo.` };
  }
  // Best-effort fetch so a remote branch that exists on origin but
  // hasn't been mirrored locally is resolvable.
  const hasOrigin = runGit(['remote', 'get-url', 'origin'], args.projectPath).exitCode === 0;
  if (hasOrigin) runGitNoPrompt(['fetch', 'origin', '--prune'], args.projectPath);
  const resolved = resolveBaseBranchStartPoint(args.projectPath, args.targetBranch);
  if (!resolved) {
    return {
      ok: false,
      error: `Branch "${args.targetBranch}" doesn't exist locally or on origin.`,
    };
  }
  const slug = path.basename(args.projectPath);
  const root = path.join(os.homedir(), '.overcli', 'worktrees', slug);
  fs.mkdirSync(root, { recursive: true });
  const worktreePath = path.join(root, `review-${args.agentName}`);
  if (fs.existsSync(worktreePath)) {
    return {
      ok: false,
      error: `A worktree already exists at ${worktreePath}. Dismiss the existing review first.`,
    };
  }
  const res = runGit(['worktree', 'add', '--detach', worktreePath, resolved], args.projectPath);
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git exited with ${res.exitCode}` };
  }
  return { ok: true, worktreePath, resolvedTarget: resolved };
}

/// Turn a detached review worktree into a regular branch-owning worktree
/// by creating `<branchPrefix><agentName>` at HEAD and switching onto it.
/// No-op if the worktree is already on a branch.
export function promoteReviewWorktree(args: {
  projectPath: string;
  worktreePath: string;
  agentName: string;
  branchPrefix: string;
}): { ok: true; branchName: string } | { ok: false; error: string } {
  const currentBranch = runGit(['branch', '--show-current'], args.worktreePath);
  if (currentBranch.exitCode === 0 && currentBranch.stdout.trim()) {
    return { ok: true, branchName: currentBranch.stdout.trim() };
  }
  const branchName = `${args.branchPrefix}${args.agentName}`;
  // If the branch already exists (user promoted, dismissed, then
  // re-created with the same name) switch to it instead of re-creating.
  const existing = runGit(['rev-parse', '--verify', branchName], args.projectPath);
  const switchRes =
    existing.exitCode === 0
      ? runGit(['switch', branchName], args.worktreePath)
      : runGit(['switch', '-c', branchName], args.worktreePath);
  if (switchRes.exitCode !== 0) {
    return { ok: false, error: switchRes.stderr.trim() || switchRes.stdout.trim() };
  }
  return { ok: true, branchName };
}

/// "Check out locally" for a review worktree: switch the main project
/// repo onto the same branch the review was inspecting, auto-stashing
/// any WIP in the project tree, then remove the worktree. The review
/// worktree itself is detached so there's no auto-commit step — any
/// accidental edits in the worktree are discarded on removal.
export function switchProjectToBranch(args: {
  projectPath: string;
  worktreePath: string;
  targetBranch: string;
}): { ok: true; message: string; stashed: boolean } | { ok: false; error: string } {
  const projectStatus = runGit(['status', '--porcelain'], args.projectPath);
  if (projectStatus.exitCode !== 0) {
    return {
      ok: false,
      error: `git status failed in project repo: ${projectStatus.stderr || projectStatus.stdout}`,
    };
  }
  let stashed = false;
  if (projectStatus.stdout.trim()) {
    const stash = runGit(
      ['stash', 'push', '-u', '-m', `overcli: auto-stash before reviewing ${args.targetBranch}`],
      args.projectPath,
    );
    if (stash.exitCode !== 0) {
      return { ok: false, error: `git stash failed: ${stash.stderr || stash.stdout}` };
    }
    stashed = true;
  }
  // Remove the worktree before we move the project onto the target
  // branch — git won't allow the same branch in two worktrees.
  const remove = runGit(['worktree', 'remove', '--force', args.worktreePath], args.projectPath);
  if (remove.exitCode !== 0) {
    return { ok: false, error: `git worktree remove failed: ${remove.stderr || remove.stdout}` };
  }
  // `git switch <branch>` handles both local-tracking and remote-only
  // branches (creates a local tracking branch automatically in the
  // latter case). Strip a leading `origin/` so the local branch name
  // matches what the user expects.
  const short = args.targetBranch.startsWith('origin/')
    ? args.targetBranch.slice('origin/'.length)
    : args.targetBranch;
  const switchRes = runGit(['switch', short], args.projectPath);
  if (switchRes.exitCode !== 0) {
    return { ok: false, error: `git switch failed: ${switchRes.stderr || switchRes.stdout}` };
  }
  const parts = [`Checked out ${short} in ${args.projectPath}.`];
  if (stashed) parts.push('Your previous changes are in `git stash` — run `git stash pop` to restore.');
  return { ok: true, message: parts.join(' '), stashed };
}

export function removeWorktree(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
}): { ok: boolean; error?: string } {
  const res = runGit(['worktree', 'remove', '--force', args.worktreePath], args.projectPath);
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() };
  }
  // Prune the branch too. If it still has commits we want, users can
  // recover via reflog; this matches the Swift app's behavior. Review
  // worktrees are detached so branchName may be empty — skip in that case.
  if (args.branchName) {
    runGit(['branch', '-D', args.branchName], args.projectPath);
  }
  return { ok: true };
}

/// Auto-commit dirty worktree state, stash any uncommitted changes in the
/// project repo, remove the worktree (keeping the branch), then
/// `git switch` the project repo onto it — so the user can keep working on
/// the agent's branch in their normal IDE / GitHub Desktop. The project-side
/// stash is left on the stack (not popped) since those changes belong to
/// the previous branch, not this one; the user can `git stash pop` later
/// when they switch back.
export function checkoutAgentLocally(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  commitSubject: string;
  commitBody?: string;
}): {
  ok: true;
  message: string;
  stashed: boolean;
  autoCommitted: boolean;
} | { ok: false; error: string } {
  const projectStatus = runGit(['status', '--porcelain'], args.projectPath);
  if (projectStatus.exitCode !== 0) {
    return {
      ok: false,
      error: `git status failed in project repo: ${projectStatus.stderr || projectStatus.stdout}`,
    };
  }

  const commit = autoCommitIfDirty(args.worktreePath, args.commitSubject, args.commitBody);
  if (!commit.ok) return commit;

  let stashed = false;
  if (projectStatus.stdout.trim()) {
    // `-u` so untracked files come along too — otherwise `git switch` can
    // still fail on an untracked file that would be overwritten.
    const stashMessage = `overcli: auto-stash before checking out ${args.branchName}`;
    const stash = runGit(['stash', 'push', '-u', '-m', stashMessage], args.projectPath);
    if (stash.exitCode !== 0) {
      return {
        ok: false,
        error: `git stash failed in project repo: ${stash.stderr || stash.stdout}`,
      };
    }
    stashed = true;
  }

  const remove = runGit(['worktree', 'remove', '--force', args.worktreePath], args.projectPath);
  if (remove.exitCode !== 0) {
    return {
      ok: false,
      error: `git worktree remove failed: ${remove.stderr || remove.stdout}`,
    };
  }

  const switchRes = runGit(['switch', args.branchName], args.projectPath);
  if (switchRes.exitCode !== 0) {
    return {
      ok: false,
      error: `git switch failed: ${switchRes.stderr || switchRes.stdout}`,
    };
  }

  const parts = [`Checked out ${args.branchName} in ${args.projectPath}.`];
  if (commit.committed) parts.push('Auto-committed uncommitted worktree changes first.');
  if (stashed) parts.push('Your previous branch changes are saved in `git stash` — run `git stash pop` to restore them.');
  return {
    ok: true,
    message: parts.join(' '),
    stashed,
    autoCommitted: commit.committed,
  };
}

/// Cached `gh --version` probe — checking every worktree row is wasteful
/// and `gh` isn't getting installed mid-session.
let ghAvailableCache: boolean | null = null;
function ghAvailable(): boolean {
  if (ghAvailableCache != null) return ghAvailableCache;
  const res =
    process.platform === 'win32'
      ? spawnSync('gh', ['--version'], { encoding: 'utf-8', env: gitEnv() })
      : spawnSync('/usr/bin/env', ['gh', '--version'], { encoding: 'utf-8', env: gitEnv() });
  ghAvailableCache = res.status === 0;
  return ghAvailableCache;
}

/// Classify the worktree's `origin` so the UI can decide between Push and
/// Open PR. Returns 'github' only if `gh` is on PATH — so the Open PR
/// action doesn't dead-end at a missing CLI.
export function detectRemoteKind(cwd: string): RemoteKind {
  const res = runGit(['remote', 'get-url', 'origin'], cwd);
  if (res.exitCode !== 0) return 'none';
  const url = res.stdout.trim();
  if (!url) return 'none';
  if (url.includes('github.com') && ghAvailable()) return 'github';
  return 'other';
}

/// Pull the first `remote:` pack-protocol URL out of push output. GitHub,
/// GitLab and Bitbucket all emit a "create a pull/merge request" URL
/// prefixed with `remote:`. Filtering to that prefix avoids hijacking the
/// match on SSH banners / MOTD URLs (e.g. Bitbucket's post-quantum notice).
export function firstCompareURL(output: string): string | undefined {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('remote:')) continue;
    const m = trimmed.match(/https?:\/\/\S+/);
    if (m) return m[0];
  }
  return undefined;
}

/// Stage and commit any uncommitted changes in `worktreePath`. No-op when
/// the worktree is clean. Returns an error string on failure, otherwise
/// the commit sha (or '' when there was nothing to commit).
function autoCommitIfDirty(
  worktreePath: string,
  subject: string,
  body?: string,
): { ok: true; committed: boolean } | { ok: false; error: string } {
  const status = runGit(['status', '--porcelain'], worktreePath);
  if (status.exitCode !== 0) {
    return { ok: false, error: `git status failed: ${status.stderr || status.stdout}` };
  }
  if (!status.stdout.trim()) return { ok: true, committed: false };
  const add = runGit(['add', '-A'], worktreePath);
  if (add.exitCode !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr || add.stdout}` };
  }
  const args = ['commit', '-m', subject];
  if (body) args.push('-m', body);
  const commit = runGit(args, worktreePath);
  if (commit.exitCode !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }
  return { ok: true, committed: true };
}

/// Auto-commit dirty worktree state, then merge the agent branch into
/// `target` in the *project* checkout. Requires the project to be on
/// `target` and have a clean working tree — we bail loudly rather than
/// trying to stash or switch branches on the user's behalf.
export function mergeAgent(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  target: string;
  commitSubject: string;
  commitBody?: string;
}): { ok: true; message: string } | { ok: false; error: string } {
  const current = runGit(['branch', '--show-current'], args.projectPath);
  const currentBranch = current.stdout.trim();
  if (!currentBranch || currentBranch !== args.target) {
    return {
      ok: false,
      error: `Project repo is on ${currentBranch || '(detached HEAD)'}. Switch it to ${args.target} before merging.`,
    };
  }
  const status = runGit(['status', '--porcelain'], args.projectPath);
  if (status.exitCode !== 0) {
    return { ok: false, error: `git status failed in project repo: ${status.stderr || status.stdout}` };
  }
  if (status.stdout.trim()) {
    return {
      ok: false,
      error: `Project repo has uncommitted changes on ${args.target}. Commit or stash them before merging the agent branch.`,
    };
  }
  const commit = autoCommitIfDirty(args.worktreePath, args.commitSubject, args.commitBody);
  if (!commit.ok) return commit;
  const merge = runGit(
    [
      'merge',
      '--no-ff',
      '-m',
      `Merge agent ${args.branchName} into ${args.target}`,
      args.branchName,
    ],
    args.projectPath,
  );
  if (merge.exitCode !== 0) {
    return {
      ok: false,
      error: `git merge failed:\n${merge.stderr || merge.stdout}\n\nResolve manually in ${args.projectPath} and try again.`,
    };
  }
  return { ok: true, message: `Merged ${args.branchName} into ${args.target}` };
}

/// Auto-commit any dirty worktree state, optionally fetch the latest
/// `origin/<baseBranch>`, then replay the agent branch on top of the
/// updated base. On conflicts we abort the rebase so the branch returns to
/// its pre-action state rather than leaving the worktree half-rebased.
export function rebaseAgent(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  commitSubject: string;
  commitBody?: string;
}): { ok: true; message: string } | { ok: false; error: string } {
  if (gitPathExists(args.worktreePath, 'rebase-merge') || gitPathExists(args.worktreePath, 'rebase-apply')) {
    return {
      ok: false,
      error: `A rebase is already in progress in ${args.worktreePath}. Finish it with \`git rebase --continue\` or abort it with \`git rebase --abort\` first.`,
    };
  }

  const baseStartPoint = resolveBaseBranchStartPoint(args.projectPath, args.baseBranch);
  if (!baseStartPoint) {
    return {
      ok: false,
      error: `Base branch "${args.baseBranch}" doesn't exist in ${args.projectPath}.`,
    };
  }

  const commit = autoCommitIfDirty(args.worktreePath, args.commitSubject, args.commitBody);
  if (!commit.ok) return commit;

  let rebaseTarget = baseStartPoint;
  let fetchWarning: string | null = null;
  const hasOrigin = runGit(['remote', 'get-url', 'origin'], args.projectPath).exitCode === 0;
  if (hasOrigin) {
    const fetch = runGitNoPrompt(['fetch', 'origin', args.baseBranch], args.projectPath);
    if (fetch.exitCode === 0) {
      const remoteRef = `refs/remotes/origin/${args.baseBranch}`;
      if (runGit(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], args.projectPath).exitCode === 0) {
        rebaseTarget = remoteRef;
      }
    } else {
      fetchWarning = `Couldn't fetch origin/${args.baseBranch}; rebased onto ${baseStartPoint} instead.`;
    }
  }

  const rebase = runGitNoPrompt(['rebase', rebaseTarget], args.worktreePath);
  if (rebase.exitCode !== 0) {
    const abort = runGit(['rebase', '--abort'], args.worktreePath);
    const abortMessage =
      abort.exitCode === 0
        ? 'The rebase was aborted and your branch was restored to its previous state.'
        : `The rebase could not be aborted automatically. Check ${args.worktreePath} and run \`git rebase --abort\` manually.`;
    return {
      ok: false,
      error: `git rebase failed:\n${rebase.stderr || rebase.stdout}\n\n${abortMessage}`,
    };
  }

  const parts = [`Rebased ${args.branchName} onto ${rebaseTarget}.`];
  if (commit.committed) parts.push('Auto-committed uncommitted worktree changes first.');
  if (fetchWarning) parts.push(fetchWarning);
  else if (rebaseTarget.startsWith('refs/remotes/origin/')) {
    parts.push(`Fetched the latest origin/${args.baseBranch} before replaying commits.`);
  }
  return { ok: true, message: parts.join(' ') };
}

/// Auto-commit any dirty worktree state, then `git push -u origin <branch>`.
/// Sets `GIT_TERMINAL_PROMPT=0` so a missing credential helper fails fast
/// with a visible error instead of hanging on an invisible stdin prompt.
export function pushBranch(args: {
  worktreePath: string;
  branchName: string;
  commitSubject: string;
  commitBody?: string;
}): { ok: true; message: string; compareUrl?: string } | { ok: false; error: string } {
  const commit = autoCommitIfDirty(args.worktreePath, args.commitSubject, args.commitBody);
  if (!commit.ok) return commit;
  const res = runGitNoPrompt(['push', '-u', 'origin', args.branchName], args.worktreePath);
  const stdout = res.stdout;
  const stderr = res.stderr;
  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: `git push failed:\n${stderr || stdout}`,
    };
  }
  const combined = stderr + '\n' + stdout;
  const compareUrl = firstCompareURL(combined);
  const message = compareUrl
    ? `Pushed ${args.branchName}. Open a request at: ${compareUrl}`
    : `Pushed ${args.branchName} to origin.`;
  return { ok: true, message, compareUrl };
}

/// Push + `gh pr create`. `gh` is invoked from /usr/bin/env so we pick it
/// up on the user's augmented PATH (homebrew, ~/.local/bin) even when the
/// app was launched from Finder with a minimal environment.
export function openPR(args: {
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  commitSubject: string;
  commitBody?: string;
}): { ok: true; message: string; url?: string } | { ok: false; error: string } {
  const push = pushBranch({
    worktreePath: args.worktreePath,
    branchName: args.branchName,
    commitSubject: args.commitSubject,
    commitBody: args.commitBody,
  });
  if (!push.ok) return push;
  const ghArgs = [
    'pr',
    'create',
    '--title',
    args.title,
    '--body',
    args.body,
    '--head',
    args.branchName,
    '--base',
    args.baseBranch,
  ];
  const res =
    process.platform === 'win32'
      ? spawnSync('gh', ghArgs, { cwd: args.worktreePath, encoding: 'utf-8', env: gitEnv() })
      : spawnSync('/usr/bin/env', ['gh', ...ghArgs], {
          cwd: args.worktreePath,
          encoding: 'utf-8',
          env: gitEnv(),
        });
  const stdout = (res.stdout ?? '').trim();
  const stderr = res.stderr ?? '';
  if (res.status !== 0) {
    return { ok: false, error: `gh pr create failed:\n${stderr || stdout}` };
  }
  return {
    ok: true,
    message: stdout ? `PR created: ${stdout}` : 'Pull request created',
    url: stdout || undefined,
  };
}

/// Compute everything the diff/merge sheet needs in one shell-out pass:
/// file counts, commits ahead, dirty state, project branch, remote kind,
/// merged status, and whether the *main* project checkout has dirty files
/// that belong in the worktree. Individual git calls are cheap enough that
/// batching via `--numstat` + a few shortstat queries keeps this sub-100ms.
export function worktreeStatus(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
}): WorktreeStatus {
  // `git diff --numstat <base>` (working-tree-vs-base) rolls committed +
  // uncommitted divergence into a single pass, so every file the agent
  // has touched shows up exactly once — no double-counting.
  const numstat = runGit(['diff', '--numstat', args.baseBranch], args.worktreePath);
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  if (numstat.exitCode === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const add = parseInt(parts[0], 10);
      const del = parseInt(parts[1], 10);
      filesChanged += 1;
      if (!Number.isNaN(add)) insertions += add;
      if (!Number.isNaN(del)) deletions += del;
    }
  }

  const ahead = runGit(
    ['rev-list', '--count', `${args.baseBranch}..HEAD`],
    args.worktreePath,
  );
  const commitsAhead = ahead.exitCode === 0 ? parseInt(ahead.stdout.trim(), 10) || 0 : 0;

  const status = runGit(['status', '--porcelain'], args.worktreePath);
  const hasUncommittedChanges = status.exitCode === 0 && !!status.stdout.trim();

  const isAncestor = runGit(
    ['merge-base', '--is-ancestor', 'HEAD', args.baseBranch],
    args.worktreePath,
  );
  // exit 0 = HEAD is already in base, 1 = diverged. Treat errors (2) as
  // "not merged" so we don't wrongly disable the merge button.
  const isMergedIntoBase = isAncestor.exitCode === 0 && commitsAhead === 0;

  const projectBranch = runGit(['branch', '--show-current'], args.projectPath);
  const currentProjectBranch =
    projectBranch.exitCode === 0 && projectBranch.stdout.trim()
      ? projectBranch.stdout.trim()
      : null;

  const remoteKind = detectRemoteKind(args.worktreePath);

  // "agent wrote to the wrong tree" detector: count dirty files in the
  // main project checkout. This is noisy (the user may have their own
  // WIP) but is the only signal we have without spelunking into the
  // runner's event stream.
  const mainStatus = runGit(['status', '--porcelain'], args.projectPath);
  const mainTreeDirtyFiles =
    mainStatus.exitCode === 0
      ? mainStatus.stdout.split('\n').filter((l) => l.trim()).length
      : 0;

  return {
    filesChanged,
    insertions,
    deletions,
    commitsAhead,
    hasUncommittedChanges,
    isMergedIntoBase,
    currentProjectBranch,
    remoteKind,
    mainTreeDirtyFiles,
  };
}

/// Quick probe for the header commit button. Returns `isRepo: false` when
/// `cwd` isn't a git working tree (missing `.git`, git binary missing, or
/// the path doesn't exist) so the renderer can hide the button entirely.
/// Porcelain v1 status codes are preserved in `.status` (e.g. ` M`, `??`,
/// `A `) so the UI can show staged vs unstaged vs untracked.
export function commitStatus(cwd: string): {
  isRepo: boolean;
  currentBranch: string;
  changes: Array<{ path: string; status: string; additions: number; deletions: number }>;
  insertions: number;
  deletions: number;
} {
  if (!cwd) {
    return { isRepo: false, currentBranch: '', changes: [], insertions: 0, deletions: 0 };
  }
  const check = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  if (check.exitCode !== 0 || check.stdout.trim() !== 'true') {
    return { isRepo: false, currentBranch: '', changes: [], insertions: 0, deletions: 0 };
  }
  const branch = runGit(['branch', '--show-current'], cwd);
  const status = runGit(['status', '--porcelain=v1'], cwd);
  const statusByPath = new Map<string, string>();
  if (status.exitCode === 0) {
    for (const line of status.stdout.split('\n')) {
      if (line.length < 3) continue;
      const code = line.slice(0, 2);
      const p = line.slice(3).trim();
      if (p) statusByPath.set(p, code);
    }
  }

  // `git diff HEAD --numstat` covers staged + unstaged churn on tracked
  // files. Untracked files don't appear here, so we tally their line
  // counts from disk below — keeping the badge honest vs. the working
  // tree the user is about to commit.
  const additionsByPath = new Map<string, number>();
  const deletionsByPath = new Map<string, number>();
  let insertions = 0;
  let deletions = 0;
  const numstat = runGit(['diff', 'HEAD', '--numstat'], cwd);
  if (numstat.exitCode === 0) {
    for (const line of numstat.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      // Binary files show '-' — skip so we don't NaN the total.
      const add = parseInt(parts[0], 10);
      const del = parseInt(parts[1], 10);
      // numstat's 3rd column is the path; for renames it may be
      // "old -> new" which porcelain surfaces as the new path. Take the
      // last whitespace-separated token as the final path.
      const p = parts.slice(2).join(' ');
      if (!p) continue;
      if (!Number.isNaN(add)) {
        insertions += add;
        additionsByPath.set(p, (additionsByPath.get(p) ?? 0) + add);
      }
      if (!Number.isNaN(del)) {
        deletions += del;
        deletionsByPath.set(p, (deletionsByPath.get(p) ?? 0) + del);
      }
    }
  }

  for (const [p, code] of statusByPath) {
    if (code !== '??') continue;
    const lines = countLinesOnDisk(path.join(cwd, p));
    if (lines > 0) {
      insertions += lines;
      additionsByPath.set(p, (additionsByPath.get(p) ?? 0) + lines);
    }
  }

  const changes = Array.from(statusByPath.entries())
    .map(([p, code]) => ({
      path: p,
      status: code,
      additions: additionsByPath.get(p) ?? 0,
      deletions: deletionsByPath.get(p) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    isRepo: true,
    currentBranch: branch.stdout.trim(),
    changes,
    insertions,
    deletions,
  };
}

/// Aggregate `commitStatus` across a workspace's member projects. Each
/// returned path is prefixed with the project's symlink name so it
/// resolves through the workspace root via the on-disk symlinks, and so
/// the ChangesBar shows which project a file belongs to.
export function workspaceCommitStatus(
  members: Array<{ name: string; path: string }>,
): {
  isRepo: boolean;
  currentBranch: string;
  changes: Array<{ path: string; status: string; additions: number; deletions: number }>;
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  const changes: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  let anyRepo = false;
  // Names come pre-assigned by the caller (workspace members use the
  // shared basename-dedup rule; coordinator members use the project
  // name), so `name` is used verbatim as the path prefix.
  for (const { name, path: projPath } of members) {
    if (!name || !projPath) continue;
    const res = commitStatus(projPath);
    if (!res.isRepo) continue;
    anyRepo = true;
    insertions += res.insertions;
    deletions += res.deletions;
    for (const c of res.changes) {
      changes.push({ ...c, path: `${name}/${c.path}` });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { isRepo: anyRepo, currentBranch: '', changes, insertions, deletions };
}

/// Count non-empty lines in a file. Used for untracked-file additions,
/// which `git diff --numstat` doesn't surface. Strips `\r` first so
/// CRLF-terminated files on Windows don't count each line as empty.
function countLinesOnDisk(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    // Skip directories (status shows untracked dirs with a trailing /)
    // and binary blobs >1 MB so we don't freeze reading huge lockfiles.
    if (stat.isDirectory()) return 0;
    if (stat.size > 1024 * 1024) return 0;
    const buf = fs.readFileSync(filePath);
    // Cheap binary sniff: any NUL in the first 8 KB → skip.
    const sniffEnd = Math.min(buf.length, 8192);
    for (let i = 0; i < sniffEnd; i++) if (buf[i] === 0) return 0;
    const text = buf.toString('utf8');
    let n = 0;
    for (const raw of text.split('\n')) {
      if (raw.replace(/\r$/, '').length > 0) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/// `git add -A && git commit -m <msg>` on the conversation's cwd. Kept
/// intentionally simple — no push, no hook bypass. The header popover uses
/// this for the "commit" button; anything fancier (partial staging,
/// signing, amending) is out of scope for a one-click action.
export function commitAll(
  args: { cwd: string; message: string },
): { ok: true; sha: string; subject: string } | { ok: false; error: string } {
  const message = args.message.trim();
  if (!message) return { ok: false, error: 'Commit message is empty.' };
  const repoCheck = runGit(['rev-parse', '--is-inside-work-tree'], args.cwd);
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') {
    return { ok: false, error: `${args.cwd} isn't a git working tree.` };
  }
  const add = runGit(['add', '-A'], args.cwd);
  if (add.exitCode !== 0) {
    return { ok: false, error: `git add failed: ${add.stderr || add.stdout}` };
  }
  const status = runGit(['status', '--porcelain'], args.cwd);
  if (status.exitCode !== 0) {
    return { ok: false, error: `git status failed: ${status.stderr || status.stdout}` };
  }
  if (!status.stdout.trim()) {
    return { ok: false, error: 'Nothing to commit — working tree clean.' };
  }
  const commit = runGit(['commit', '-m', message], args.cwd);
  if (commit.exitCode !== 0) {
    return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
  }
  const sha = runGit(['rev-parse', 'HEAD'], args.cwd);
  return {
    ok: true,
    sha: sha.stdout.trim(),
    subject: message.split('\n')[0],
  };
}

/// Stash any dirty files in the *main* project checkout and pop them into
/// the agent's worktree. Used when the agent wrote to the wrong tree —
/// common when a CLI ignored its spawn-time cwd.
export function rescueMainTree(args: {
  projectPath: string;
  worktreePath: string;
  branchName: string;
}): { ok: true; message: string } | { ok: false; error: string } {
  const status = runGit(['status', '--porcelain'], args.projectPath);
  if (status.exitCode !== 0) {
    return { ok: false, error: `git status failed: ${status.stderr || status.stdout}` };
  }
  if (!status.stdout.trim()) {
    return { ok: true, message: 'Main project tree is already clean — nothing to rescue.' };
  }
  const stashMsg = `overcli-rescue-${args.branchName}-${Date.now()}`;
  const stash = runGit(
    ['stash', 'push', '--include-untracked', '-m', stashMsg],
    args.projectPath,
  );
  if (stash.exitCode !== 0) {
    return { ok: false, error: `git stash failed: ${stash.stderr || stash.stdout}` };
  }
  const pop = runGit(['stash', 'pop'], args.worktreePath);
  if (pop.exitCode !== 0) {
    // Best-effort: try to put the stash back in the project so we don't
    // leave the changes stranded in the stash list.
    return {
      ok: false,
      error:
        `git stash pop into worktree failed: ${pop.stderr || pop.stdout}\n\n` +
        `Your changes are preserved as stash "${stashMsg}" in ${args.projectPath}. Run \`git stash pop\` to restore.`,
    };
  }
  return { ok: true, message: `Moved dirty files into worktree ${args.worktreePath}` };
}

