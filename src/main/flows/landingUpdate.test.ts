// Real-git test for "update with base". No git mock: what is under test is
// what git does to real branches and worktrees — that base and the original
// branch are never touched, that a conflicted merge is left resolvable, and
// that discarding puts the repository back exactly as it was.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discardLandingUpdate, finishLandingUpdate, startLandingUpdate } from './landingUpdate';

let root: string;
let repo: string;
let clean: string;
let conflicting: string;
const deps = () => ({ worktreeRoot: () => join(root, 'worktrees'), now: () => 42 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitFile(cwd: string, name: string, body: string, msg: string): string {
  writeFileSync(join(cwd, name), body);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overcli-landing-update-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  commitFile(repo, 'shared.txt', 'line one\n', 'base');

  git(repo, 'checkout', '-qb', 'prometheus/clean');
  clean = commitFile(repo, 'clean.txt', 'clean\n', 'shift: clean');
  git(repo, 'checkout', '-q', 'master');
  git(repo, 'checkout', '-qb', 'prometheus/conflict');
  conflicting = commitFile(repo, 'shared.txt', 'line one, shift\n', 'shift: conflict');
  git(repo, 'checkout', '-q', 'master');
  commitFile(repo, 'shared.txt', 'line one, base\n', 'base moves on');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('startLandingUpdate', () => {
  it('merges base into work that still merges, commits it, and leaves base and the original branch alone', async () => {
    const master = git(repo, 'rev-parse', 'master');
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: clean, baseBranch: 'master', branchName: 'prometheus/clean' },
      deps(),
    );
    expect(res).toMatchObject({ ok: true, status: 'merged', branchName: 'prometheus/clean-on-master' });
    if (!res.ok || res.status !== 'merged') throw new Error('unreachable');
    expect(git(repo, 'rev-parse', 'prometheus/clean-on-master')).toBe(res.headSha);
    // Up to date with base, still carrying the shift's commit.
    git(repo, 'merge-base', '--is-ancestor', 'master', res.headSha);
    git(repo, 'merge-base', '--is-ancestor', clean, res.headSha);
    expect(git(repo, 'rev-parse', 'master')).toBe(master);
    expect(git(repo, 'rev-parse', 'prometheus/clean')).toBe(clean);
    // Scaffolding gone.
    expect(git(repo, 'worktree', 'list')).not.toContain('clean-on-master');
  });

  it('parks a conflicting merge in its own worktree with the conflicted paths', async () => {
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: conflicting, baseBranch: 'master', branchName: 'prometheus/conflict' },
      deps(),
    );
    expect(res).toMatchObject({
      ok: true,
      status: 'conflicts',
      pending: { branchName: 'prometheus/conflict-on-master', conflictFiles: ['shared.txt'], startedAt: 42 },
    });
    if (!res.ok || res.status !== 'conflicts') throw new Error('unreachable');
    expect(existsSync(res.pending.worktreePath)).toBe(true);
    expect(git(res.pending.worktreePath, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
  });

  it('picks a fresh branch name when the obvious one is taken', async () => {
    git(repo, 'branch', 'prometheus/clean-on-master', 'master');
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: clean, baseBranch: 'master', branchName: 'prometheus/clean' },
      deps(),
    );
    expect(res).toMatchObject({ ok: true, branchName: 'prometheus/clean-on-master-2' });
  });

  it('names the branch after the commit when the original branch is unknown', async () => {
    const res = await startLandingUpdate({ projectPath: repo, headSha: clean, baseBranch: 'master' }, deps());
    expect(res).toMatchObject({ ok: true, branchName: `overcli/stranded-${clean.slice(0, 8)}-on-master` });
  });

  it('refuses a commit that is gone', async () => {
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: 'deadbeef'.repeat(5), baseBranch: 'master' },
      deps(),
    );
    expect(res.ok).toBe(false);
  });
});

describe('finishLandingUpdate', () => {
  async function parked() {
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: conflicting, baseBranch: 'master', branchName: 'prometheus/conflict' },
      deps(),
    );
    if (!res.ok || res.status !== 'conflicts') throw new Error('expected conflicts');
    return res.pending;
  }

  it('refuses while paths are still conflicted, and while the merge is uncommitted', async () => {
    const pending = await parked();
    const still = await finishLandingUpdate({ projectPath: repo, pending, baseBranch: 'master' }, deps());
    expect(still).toEqual({ ok: false, error: 'Still conflicted: shared.txt' });

    writeFileSync(join(pending.worktreePath, 'shared.txt'), 'line one, both\n');
    git(pending.worktreePath, 'add', 'shared.txt');
    const uncommitted = await finishLandingUpdate({ projectPath: repo, pending, baseBranch: 'master' }, deps());
    expect(uncommitted.ok).toBe(false);
    if (!uncommitted.ok) expect(uncommitted.error).toMatch(/not committed/);
    expect(existsSync(pending.worktreePath)).toBe(true);
  });

  it('accepts a committed resolution and removes the worktree, keeping the branch', async () => {
    const pending = await parked();
    writeFileSync(join(pending.worktreePath, 'shared.txt'), 'line one, both\n');
    git(pending.worktreePath, 'add', 'shared.txt');
    git(pending.worktreePath, 'commit', '-q', '--no-edit');

    const res = await finishLandingUpdate({ projectPath: repo, pending, baseBranch: 'master' }, deps());
    expect(res).toMatchObject({ ok: true, branchName: 'prometheus/conflict-on-master' });
    expect(existsSync(pending.worktreePath)).toBe(false);
    git(repo, 'merge-base', '--is-ancestor', 'master', 'prometheus/conflict-on-master');
  });
});

describe('discardLandingUpdate', () => {
  it('puts the repository back: no worktree, no new branch, base and original untouched', async () => {
    const master = git(repo, 'rev-parse', 'master');
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: conflicting, baseBranch: 'master', branchName: 'prometheus/conflict' },
      deps(),
    );
    if (!res.ok || res.status !== 'conflicts') throw new Error('expected conflicts');

    expect(await discardLandingUpdate({ projectPath: repo, pending: res.pending, headSha: conflicting }, deps())).toEqual({ ok: true });
    expect(existsSync(res.pending.worktreePath)).toBe(false);
    expect(git(repo, 'branch', '--list', 'prometheus/conflict-on-master')).toBe('');
    expect(git(repo, 'rev-parse', 'master')).toBe(master);
    expect(git(repo, 'rev-parse', 'prometheus/conflict')).toBe(conflicting);
  });

  it('keeps a branch somebody already committed a resolution to', async () => {
    const res = await startLandingUpdate(
      { projectPath: repo, headSha: conflicting, baseBranch: 'master', branchName: 'prometheus/conflict' },
      deps(),
    );
    if (!res.ok || res.status !== 'conflicts') throw new Error('expected conflicts');
    writeFileSync(join(res.pending.worktreePath, 'shared.txt'), 'resolved\n');
    git(res.pending.worktreePath, 'add', 'shared.txt');
    git(res.pending.worktreePath, 'commit', '-q', '--no-edit');

    expect(await discardLandingUpdate({ projectPath: repo, pending: res.pending, headSha: conflicting }, deps())).toEqual({
      ok: true,
      keptBranch: 'prometheus/conflict-on-master',
    });
  });
});
