import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_AFTER_MS, PUSHED_AFTER_MS, STALE_UNPUSHED_MS, checkoutHealth, sweepWorktrees } from './worktreeSweep';
import type { FlowRun } from '../../shared/flows/schema';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, main]);
  git(main, 'config', 'user.email', 'a@acme.example');
  git(main, 'config', 'user.name', 'A');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a');
  git(main, 'add', '.');
  git(main, 'commit', '-qm', 'one');
  git(main, 'push', '-q', 'origin', 'HEAD');
  const base = git(main, 'rev-parse', 'HEAD');
  const wt = (name: string) => {
    const p = path.join(root, name);
    git(main, 'worktree', 'add', '-q', '-b', `run/${name}`, p, base);
    return p;
  };
  return { main, base, wt };
}

const run = (r: ReturnType<typeof repo>, wt: string, name: string, endedMsAgo: number, state: FlowRun['state'] = { kind: 'done', success: true }) =>
  ({ id: name, state, createdAt: 0, attempts: [{ endedAt: Date.now() - endedMsAgo }], workspaceWorktrees: [{ name: 'main', projectPath: r.main, worktreePath: wt, branchName: `run/${name}` }], baselineCommitsByMember: { main: { commit: r.base } } }) as unknown as FlowRun;

describe('cleaning up finished runs’ checkouts', () => {
  it('removes empty and pushed ones when due, and never unpushed work or a live run', async () => {
    const r = repo();
    const empty = r.wt('empty');
    const pushed = r.wt('pushed');
    fs.writeFileSync(path.join(pushed, 'b.txt'), 'b');
    git(pushed, 'add', '.');
    git(pushed, 'commit', '-qm', 'two');
    git(pushed, 'push', '-q', 'origin', 'HEAD:refs/heads/run/pushed');
    git(pushed, 'fetch', '-q', 'origin');
    const unpushed = r.wt('unpushed');
    fs.writeFileSync(path.join(unpushed, 'c.txt'), 'c');
    const paused = r.wt('paused');
    const fresh = r.wt('fresh');
    const runs = [
      run(r, empty, 'empty', EMPTY_AFTER_MS + 1000),
      run(r, pushed, 'pushed', PUSHED_AFTER_MS + 1000),
      run(r, unpushed, 'unpushed', PUSHED_AFTER_MS * 10),
      run(r, paused, 'paused', PUSHED_AFTER_MS * 10, { kind: 'paused' } as never),
      run(r, fresh, 'fresh', 1000),
    ];
    const res = await sweepWorktrees(runs, () => undefined);
    expect(res).toEqual({ removed: 2, kept: 1 });
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.existsSync(pushed)).toBe(false);
    expect(fs.existsSync(unpushed)).toBe(true);
    expect(fs.existsSync(paused)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  }, 30_000);

  it("leaves a checkout alone when a newer run has taken over its folder", async () => {
    const r = repo();
    // The old run pushed long ago and its checkout went; a new run on the
    // same ticket checked out into the same path and is still working.
    const wt = r.wt('ACME-9');
    const old = { ...run(r, wt, 'old', PUSHED_AFTER_MS * 3), createdAt: 1 } as FlowRun;
    const live = { ...run(r, wt, 'live', 0, { kind: 'running' } as never), createdAt: 2 } as FlowRun;
    const res = await sweepWorktrees([old, live], () => undefined);
    expect(res.removed).toBe(0);
    expect(fs.existsSync(wt)).toBe(true);
  }, 30_000);

  it('says in Readiness how many checkouts there are, and flags old unpushed work', async () => {
    const r = repo();
    const wt = r.wt('old');
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c');
    await sweepWorktrees([run(r, wt, 'old', STALE_UNPUSHED_MS + 60_000)], () => undefined);
    const root = path.dirname(path.dirname(wt));
    const h = checkoutHealth(Date.now(), root);
    expect(h.ok).toBe(false);
    expect(h.detail).toContain('never pushed');
  }, 30_000);
});
