import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { releaseWorktree, removeWorktreeAsync } from './git';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('releaseWorktree', () => {
  let sandbox: string;
  let projectPath: string;
  let worktreePath: string;
  const migrated: string[] = [];
  const deps = (running = false) => ({ turnPending: () => running, migrateSession: (a: { sessionId: string }) => { migrated.push(a.sessionId); } });

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-release-worktree-'));
    projectPath = path.join(sandbox, 'repo');
    fs.mkdirSync(projectPath);
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['-c', 'user.name=Overcli Test', '-c', 'user.email=test@overcli.local', 'commit', '--allow-empty', '-m', 'initial']);
    worktreePath = path.join(sandbox, 'wt');
    git(projectPath, ['worktree', 'add', '-b', 'agent/x', worktreePath, 'main']);
    migrated.length = 0;
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const args = () => ({ projectPath, worktreePath, branchName: 'agent/x', sessionId: 's1', unattended: true, conversationId: 'c1' });

  it('unattended, keeps a tree that gained changes since the scan, and says so', async () => {
    fs.writeFileSync(path.join(worktreePath, 'notes.md'), 'uncommitted');
    const res = await releaseWorktree(args(), deps());
    expect(res).toEqual({ ok: false, error: 'kept: it has changes that were not there when you were asked' });
    expect(fs.existsSync(path.join(worktreePath, 'notes.md'))).toBe(true);
    expect(migrated).toEqual([]);
    // The same tree, asked for by a person: force, as the sheet always did.
    expect(await removeWorktreeAsync({ projectPath, worktreePath, branchName: '' })).toEqual({ ok: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('unattended, keeps a tree whose chat has a turn in flight, before touching git', async () => {
    const res = await releaseWorktree(args(), deps(true));
    expect(res).toEqual({ ok: false, error: 'kept: its chat is running' });
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it('unattended, removes a clean idle tree, keeps its branch, and re-homes the session', async () => {
    expect(await releaseWorktree(args(), deps())).toEqual({ ok: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(git(projectPath, ['branch', '--list', 'agent/x'])).toContain('agent/x');
    expect(migrated).toEqual(['s1']);
  });

  it('attended, removes a tree with changes as before', async () => {
    fs.writeFileSync(path.join(worktreePath, 'notes.md'), 'uncommitted');
    expect(await releaseWorktree({ ...args(), unattended: false }, deps(true))).toEqual({ ok: true });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });
});

describe('releaseWorktree turn hold', () => {
  let sandbox: string;
  let projectPath: string;
  let worktreePath: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-release-hold-'));
    projectPath = path.join(sandbox, 'repo');
    fs.mkdirSync(projectPath);
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['-c', 'user.name=Overcli Test', '-c', 'user.email=test@overcli.local', 'commit', '--allow-empty', '-m', 'initial']);
    worktreePath = path.join(sandbox, 'wt');
    git(projectPath, ['worktree', 'add', '-b', 'agent/x', worktreePath, 'main']);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const args = () => ({ projectPath, worktreePath, branchName: 'agent/x', unattended: true, conversationId: 'c1' });

  it('holds new turns from the turnPending check until the remove is done, then lets them through', async () => {
    const events: string[] = [];
    const deps = {
      turnPending: () => { events.push('check'); return false; },
      holdTurns: () => { events.push('hold'); return () => { events.push('unhold'); }; },
      migrateSession: () => {},
    };
    const pending = releaseWorktree(args(), deps);
    // Taken synchronously with the check: nothing can start in the gap.
    expect(events).toEqual(['check', 'hold']);
    expect(await pending).toEqual({ ok: true });
    expect(events).toEqual(['check', 'hold', 'unhold']);
  });

  it('lets turns through again when git refuses', async () => {
    fs.writeFileSync(path.join(worktreePath, 'notes.md'), 'uncommitted');
    let held = 0;
    const deps = { turnPending: () => false, holdTurns: () => { held++; return () => { held--; }; }, migrateSession: () => {} };
    const res = await releaseWorktree(args(), deps);
    expect(res.ok).toBe(false);
    expect(held).toBe(0);
  });

  it('refuses a second release of a tree already being released', async () => {
    const deps = { turnPending: () => false, migrateSession: () => {} };
    const first = releaseWorktree(args(), deps);
    expect(await releaseWorktree(args(), deps)).toEqual({ ok: false, error: 'kept: it is already being released' });
    expect(await first).toEqual({ ok: true });
  });
});

describe('removeWorktreeAsync branch kept', () => {
  it('says the branch was kept when branch -d fails for a reason other than unmerged commits', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-release-kept-'));
    try {
      const projectPath = path.join(sandbox, 'repo');
      fs.mkdirSync(projectPath);
      git(projectPath, ['init', '-b', 'main']);
      git(projectPath, ['-c', 'user.name=Overcli Test', '-c', 'user.email=test@overcli.local', 'commit', '--allow-empty', '-m', 'initial']);
      const wt = path.join(sandbox, 'wt');
      const other = path.join(sandbox, 'other');
      git(projectPath, ['worktree', 'add', '-b', 'agent/y', wt, 'main']);
      git(projectPath, ['worktree', 'add', '--detach', other, 'main']);
      // The branch is checked out in a second tree, so `branch -d` refuses.
      git(wt, ['checkout', '--detach']);
      git(other, ['checkout', 'agent/y']);
      const res = await removeWorktreeAsync({ projectPath, worktreePath: wt, branchName: 'agent/y' });
      expect(res.ok).toBe(true);
      expect(res.branchKept).toBe(true);
      expect(git(projectPath, ['branch', '--list', 'agent/y'])).toContain('agent/y');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
