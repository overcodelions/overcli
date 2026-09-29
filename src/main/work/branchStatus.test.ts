import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchStatus } from './branchStatus';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
}

describe('branchStatus', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-branch-status-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['commit', '--allow-empty', '-m', 'initial']);
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('counts commits ahead of the trunk on an unpushed branch', async () => {
    git(repo, ['checkout', '-b', 'feat/a']);
    git(repo, ['commit', '--allow-empty', '-m', 'one']);
    git(repo, ['commit', '--allow-empty', '-m', 'two']);
    const s = await branchStatus(repo, 'feat/a');
    expect(s).toMatchObject({ local: true, remote: false, trunk: 'main', ahead: 2, inTrunk: false, lastSubject: 'two' });
  });

  it('sees a merged branch as in the trunk', async () => {
    git(repo, ['checkout', '-b', 'feat/b']);
    git(repo, ['commit', '--allow-empty', '-m', 'work']);
    git(repo, ['checkout', 'main']);
    git(repo, ['merge', '--no-ff', 'feat/b', '-m', 'merge']);
    const s = await branchStatus(repo, 'feat/b');
    expect(s).toMatchObject({ inTrunk: true, ahead: 0, cutOnly: false });
  });

  it('tells a branch cut and never committed to from a merged one', async () => {
    git(repo, ['branch', 'feat/empty']);
    git(repo, ['commit', '--allow-empty', '-m', 'trunk moves on']);
    expect(await branchStatus(repo, 'feat/empty')).toMatchObject({ inTrunk: true, cutOnly: true });
  });

  it('counts uncommitted files in the worktree', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    expect((await branchStatus(repo, 'main', repo)).uncommitted).toBe(1);
  });

  it('reports a branch that is gone', async () => {
    expect(await branchStatus(repo, 'feat/gone')).toMatchObject({ local: false, remote: false });
  });
});
