import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeWorktreeAsync } from './git';

let root: string;
let repo: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tree = (name: string, work: boolean) => {
  const wt = join(root, name);
  git(repo, 'worktree', 'add', '-q', '-b', `agent/${name}`, wt, 'master');
  if (work) {
    writeFileSync(join(wt, 'f.txt'), 'work\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'work');
  }
  return wt;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'overcli-keep-')));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.email', 't@overcli.test');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('removeWorktreeAsync keepUnmerged', () => {
  it('keeps a branch with commits git calls unmerged', async () => {
    const wt = tree('a', true);
    const res = await removeWorktreeAsync({ projectPath: repo, worktreePath: wt, branchName: 'agent/a', keepUnmerged: true });
    expect(res).toEqual({ ok: true, branchKept: true });
    expect(git(repo, 'branch', '--list', 'agent/a')).toContain('agent/a');
  });

  it('deletes an empty branch', async () => {
    const wt = tree('b', false);
    const res = await removeWorktreeAsync({ projectPath: repo, worktreePath: wt, branchName: 'agent/b', keepUnmerged: true });
    expect(res).toEqual({ ok: true });
    expect(git(repo, 'branch', '--list', 'agent/b')).toBe('');
  });

  it('still force-deletes without it, as before', async () => {
    const wt = tree('c', true);
    const res = await removeWorktreeAsync({ projectPath: repo, worktreePath: wt, branchName: 'agent/c' });
    expect(res.warning).toMatch(/force-deleted/);
    expect(git(repo, 'branch', '--list', 'agent/c')).toBe('');
  });
});
