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

  it('sees a squash-merged branch as in the trunk', async () => {
    git(repo, ['checkout', '-b', 'feat/squashed']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', 'a.txt']);
    git(repo, ['commit', '-m', 'one']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['commit', '-am', 'two']);
    git(repo, ['checkout', 'main']);
    git(repo, ['commit', '--allow-empty', '-m', 'trunk moves on']);
    git(repo, ['merge', '--squash', 'feat/squashed']);
    git(repo, ['commit', '-m', 'squashed']);
    const s = await branchStatus(repo, 'feat/squashed');
    expect(s).toMatchObject({ inTrunk: true, ahead: 0, cutOnly: false, squashMerged: true });
  });

  it('does not call a branch squash-merged when the trunk has only part of it', async () => {
    git(repo, ['checkout', '-b', 'feat/partial']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    git(repo, ['add', 'b.txt']);
    git(repo, ['commit', '-m', 'b']);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    git(repo, ['add', 'c.txt']);
    git(repo, ['commit', '-m', 'c']);
    git(repo, ['checkout', 'main']);
    git(repo, ['commit', '--allow-empty', '-m', 'trunk moves on']);
    git(repo, ['cherry-pick', 'feat/partial~1']);
    const s = await branchStatus(repo, 'feat/partial');
    expect(s).toMatchObject({ inTrunk: false, ahead: 2 });
    expect(s.squashMerged).toBeUndefined();
  });

  it('counts uncommitted files in the worktree', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
    expect((await branchStatus(repo, 'main', repo)).uncommitted).toBe(1);
  });

  it('marks a branch whose upstream was deleted on the remote', async () => {
    git(repo, ['checkout', '-b', 'feat/pushed']);
    git(repo, ['commit', '--allow-empty', '-m', 'work']);
    git(repo, ['remote', 'add', 'origin', path.join(repo, 'no-such-remote')]);
    git(repo, ['config', 'branch.feat/pushed.remote', 'origin']);
    git(repo, ['config', 'branch.feat/pushed.merge', 'refs/heads/feat/pushed']);
    expect(await branchStatus(repo, 'feat/pushed')).toMatchObject({ local: true, remote: false, remoteGone: true });
  });

  it('reports a branch that is gone', async () => {
    expect(await branchStatus(repo, 'feat/gone')).toMatchObject({ local: false, remote: false });
  });
});
