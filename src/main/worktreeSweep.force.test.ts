import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepWorktrees } from './worktreeSweep';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

let root: string;
let home: string | undefined;
let projectPath: string;
const tree = (name: string) => {
  const p = join(root, '.overcli/worktrees/acme', name);
  git(projectPath, 'worktree', 'add', '-q', '-b', `agent/${name}`, p);
  return p;
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'overcli-sweep-force-')));
  home = process.env.HOME;
  process.env.HOME = root;
  projectPath = join(root, 'repo');
  mkdirSync(projectPath);
  git(projectPath, 'init', '-q', '-b', 'main');
  git(projectPath, '-c', 'user.name=A', '-c', 'user.email=a@acme.example', 'commit', '-q', '--allow-empty', '-m', 'one');
});
afterEach(() => {
  process.env.HOME = home;
  rmSync(root, { recursive: true, force: true });
});

describe('sweepWorktrees and changes made after the scan', () => {
  it('keeps an orphan that gained changes after a scan that saw it clean', async () => {
    const wt = tree('later');
    writeFileSync(join(wt, 'notes.md'), 'written after the scan');
    const res = await sweepWorktrees({ entries: [{ projectPath, worktreePath: wt, branchName: 'agent/later', dirtyAtScan: 0 }] });
    expect(res.removed).toBe(0);
    expect(res.failures).toEqual([{ worktreePath: wt, error: 'kept: it has changes that were not there when you were asked' }]);
    expect(existsSync(join(wt, 'notes.md'))).toBe(true);
  });

  it('removes an orphan whose changes the person was shown and still chose', async () => {
    const wt = tree('shown');
    writeFileSync(join(wt, 'notes.md'), 'seen in the sheet');
    const res = await sweepWorktrees({ entries: [{ projectPath, worktreePath: wt, branchName: 'agent/shown', dirtyAtScan: 1 }] });
    expect(res.removed).toBe(1);
    expect(existsSync(wt)).toBe(false);
  });

  it('removes a clean orphan', async () => {
    const wt = tree('clean');
    const res = await sweepWorktrees({ entries: [{ projectPath, worktreePath: wt, branchName: 'agent/clean' }] });
    expect(res.removed).toBe(1);
    expect(existsSync(wt)).toBe(false);
  });
});
