import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeForBranch } from './git';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('worktreeForBranch', () => {
  let sandbox: string;
  let projectPath: string;
  let homeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-wt-for-branch-')));
    projectPath = path.join(sandbox, 'repo');
    fs.mkdirSync(projectPath);
    git(projectPath, ['init', '-b', 'main']);
    git(projectPath, ['-c', 'user.name=Overcli Test', '-c', 'user.email=test@overcli.local', 'commit', '--allow-empty', '-m', 'initial']);
    git(projectPath, ['branch', 'feat/developer-mcp']);
    homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(sandbox);
  });

  afterEach(() => {
    homeSpy.mockRestore();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('adds a worktree on the branch itself, not detached', () => {
    const res = worktreeForBranch({ projectPath, branch: 'feat/developer-mcp' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reused).toBe(false);
    expect(res.worktreePath).toBe(path.join(sandbox, '.overcli', 'worktrees', 'repo', 'feat-developer-mcp'));
    expect(git(res.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/developer-mcp');
  });

  it('reuses the worktree that already has the branch', () => {
    const first = worktreeForBranch({ projectPath, branch: 'feat/developer-mcp' });
    const second = worktreeForBranch({ projectPath, branch: 'feat/developer-mcp' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.reused).toBe(true);
    expect(fs.realpathSync(second.worktreePath)).toBe(fs.realpathSync(first.worktreePath));
  });

  it('says so when the main checkout is on the branch', () => {
    const res = worktreeForBranch({ projectPath, branch: 'main' });
    expect(res).toMatchObject({ ok: true, reused: true, mainCheckout: true });
  });

  it('fails plainly for a branch that is gone', () => {
    const res = worktreeForBranch({ projectPath, branch: 'feat/deleted' });
    expect(res).toMatchObject({ ok: false });
  });
});
