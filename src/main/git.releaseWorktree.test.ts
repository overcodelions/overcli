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
