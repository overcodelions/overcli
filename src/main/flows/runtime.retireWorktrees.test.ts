// Against real git: what a run may give up, tree by tree, is decided by what
// git says at the moment of removal.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';
import type { FlowRun } from '../../shared/flows/schema';

const seeded = vi.hoisted(() => ({ runs: [] as FlowRun[] }));

useTestHost('/tmp/overcli-retire-tests');
vi.mock('./runsStore', () => ({
  loadAllRuns: () => seeded.runs,
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./storage', () => ({ loadAllFlows: () => [] }));

import { FlowRuntimeImpl } from './runtime';

const RUN_ID = '11111111-1111-4111-8111-aaaaaaaaaaaa';
let root: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function member(name: string) {
  const repo = join(root, name);
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  const worktreePath = join(root, `wt-${name}`);
  git(repo, 'worktree', 'add', '-q', '-b', 'agent/x', worktreePath, 'master');
  return { name, projectPath: repo, worktreePath, branchName: 'agent/x', commit: git(repo, 'rev-parse', 'HEAD') };
}

function runtimeWith(members: ReturnType<typeof member>[], state: FlowRun['state'], over: Partial<FlowRun> = {}) {
  const run = {
    id: RUN_ID,
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Flow', steps: [], participants: [] },
    projectPath: root,
    sourceProjectPath: root,
    userPrompt: 'go',
    conversationIds: {},
    artifacts: {},
    state,
    createdAt: 1,
    attempts: [],
    workspaceWorktrees: members.map(({ commit: _c, ...m }) => m),
    baselineCommitsByMember: Object.fromEntries(members.map((m) => [m.name, { path: m.worktreePath, commit: m.commit }])),
    ...over,
  } as unknown as FlowRun;
  seeded.runs = [run];
  const runtime = new FlowRuntimeImpl(
    { send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => members.map((m) => ({ id: m.name, name: m.name, path: m.projectPath })) as never,
    () => ({ backends: {}, agentBranchPrefix: 'agent/' }) as never,
    () => [{ rootPath: root, projectIds: members.map((m) => m.name) }] as never,
  );
  return runtime;
}

const memberNames = (runtime: FlowRuntimeImpl) =>
  (runtime.getRun(RUN_ID as never)?.workspaceWorktrees ?? []).map((m) => m.name);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'overcli-retire-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('retireRunWorktrees', () => {
  it('removes the clean tree and keeps the ones holding work, and the run', async () => {
    const clean = member('clean');
    const dirty = member('dirty');
    writeFileSync(join(dirty.worktreePath, 'scratch.txt'), 'half done\n');
    const ahead = member('ahead');
    writeFileSync(join(ahead.worktreePath, 'feature.txt'), 'work\n');
    git(ahead.worktreePath, 'add', '-A');
    git(ahead.worktreePath, 'commit', '-qm', 'work');

    const runtime = runtimeWith([clean, dirty, ahead], { kind: 'done' } as FlowRun['state']);
    const res = await runtime.retireRunWorktrees({
      runId: RUN_ID as never,
      worktreePaths: [clean.worktreePath, dirty.worktreePath, ahead.worktreePath],
    });

    if (!res.ok) throw new Error(res.error);
    expect(res.removed).toEqual([clean.worktreePath]);
    expect(res.kept.map((k) => k.worktreePath)).toEqual([dirty.worktreePath, ahead.worktreePath]);
    expect(existsSync(clean.worktreePath)).toBe(false);
    expect(existsSync(dirty.worktreePath)).toBe(true);
    expect(existsSync(ahead.worktreePath)).toBe(true);
    expect(git(ahead.projectPath, 'branch', '--list', 'agent/x')).toContain('agent/x');
    // A tree that never moved has nothing on its branch: it goes too.
    expect(git(clean.projectPath, 'branch', '--list', 'agent/x')).toBe('');
    expect(memberNames(runtime)).toEqual(['dirty', 'ahead']);
  });

  it('deletes the branch of a clean tree merged into the base', async () => {
    const merged = member('merged');
    const other = member('other');
    writeFileSync(join(merged.worktreePath, 'feature.txt'), 'work\n');
    git(merged.worktreePath, 'add', '-A');
    git(merged.worktreePath, 'commit', '-qm', 'work');
    git(merged.projectPath, 'merge', '-q', 'agent/x');

    const runtime = runtimeWith([merged, other], { kind: 'done' } as FlowRun['state']);
    const res = await runtime.retireRunWorktrees({ runId: RUN_ID as never, worktreePaths: [merged.worktreePath] });

    if (!res.ok) throw new Error(res.error);
    expect(res.removed).toEqual([merged.worktreePath]);
    expect(git(merged.projectPath, 'branch', '--list', 'agent/x')).toBe('');
  });

  it('leaves a paused run one tree to resume from', async () => {
    const a = member('a');
    const b = member('b');
    const runtime = runtimeWith([a, b], { kind: 'paused', nextStepId: 's', reason: 'needsInput' } as FlowRun['state']);
    const res = await runtime.retireRunWorktrees({ runId: RUN_ID as never, worktreePaths: [a.worktreePath, b.worktreePath] });

    if (!res.ok) throw new Error(res.error);
    expect(res.removed).toEqual([a.worktreePath]);
    expect(res.kept[0].worktreePath).toBe(b.worktreePath);
    expect(existsSync(b.worktreePath)).toBe(true);
  });

  it('gets a paused run its tree back on the same branch', async () => {
    const home = process.env.HOME;
    process.env.HOME = root; // Worktrees are minted under the home folder.
    try {
      const a = member('a');
      const b = member('b');
      const runtime = runtimeWith([a, b], { kind: 'paused', nextStepId: 's', reason: 'needsInput' } as FlowRun['state']);
      const res = await runtime.retireRunWorktrees({ runId: RUN_ID as never, worktreePaths: [a.worktreePath] });
      expect(res.ok).toBe(true);
      expect(memberNames(runtime)).toEqual(['b']);

      const back = await runtime.adoptPendingWorkspaceMembers(RUN_ID as never);

      expect(back).toEqual({ ok: true, adopted: ['a'] });
      const restored = runtime.getRun(RUN_ID as never)?.workspaceWorktrees?.find((m) => m.name === 'a');
      expect(restored?.branchName).toBe('agent/x');
      expect(existsSync(restored!.worktreePath)).toBe(true);
    } finally {
      process.env.HOME = home;
    }
  });

  it('refuses a working run and touches nothing', async () => {
    const a = member('a');
    const b = member('b');
    const runtime = runtimeWith([a, b], { kind: 'watching', watch: {} } as unknown as FlowRun['state']);
    const res = await runtime.retireRunWorktrees({ runId: RUN_ID as never, worktreePaths: [a.worktreePath] });
    expect(res.ok).toBe(false);
    expect(existsSync(a.worktreePath)).toBe(true);
  });
});

describe('a squash-merged run', () => {
  /// Two commits on the tree's branch, squashed into the repo's base.
  function squashed(name: string) {
    const m = member(name);
    writeFileSync(join(m.worktreePath, 'feature.txt'), 'one\n');
    git(m.worktreePath, 'add', '-A');
    git(m.worktreePath, 'commit', '-qm', 'one');
    writeFileSync(join(m.worktreePath, 'feature.txt'), 'one\ntwo\n');
    git(m.worktreePath, 'add', '-A');
    git(m.worktreePath, 'commit', '-qm', 'two');
    git(m.projectPath, 'merge', '-q', '--squash', 'agent/x');
    git(m.projectPath, 'commit', '-qm', 'Merged in x');
    return m;
  }
  function ahead(name: string) {
    const m = member(name);
    writeFileSync(join(m.worktreePath, 'feature.txt'), 'real work\n');
    git(m.worktreePath, 'add', '-A');
    git(m.worktreePath, 'commit', '-qm', 'real work');
    return m;
  }
  const done = { kind: 'done' } as FlowRun['state'];
  const base = { baseBranch: 'master' };

  it('is not unreviewed, but a run with unmerged work still is', async () => {
    expect(await runtimeWith([squashed('a')], done, base).unreviewedDoneRunIds()).toEqual([]);
    expect(await runtimeWith([ahead('b')], done, base).unreviewedDoneRunIds()).toEqual([RUN_ID]);
  });

  it('deletes without asking and keeps the landed branch', async () => {
    const a = squashed('a');
    const runtime = runtimeWith([a], done, base);
    expect(await runtime.deleteRunChecked({ runId: RUN_ID as never })).toEqual({ ok: true });
    await vi.waitFor(() => expect(existsSync(a.worktreePath)).toBe(false));
    expect(git(a.projectPath, 'branch', '--list', 'agent/x')).toContain('agent/x');
  });

  it('still asks when one tree in the run holds unmerged work', async () => {
    const a = squashed('a');
    const b = ahead('b');
    const res = await runtimeWith([a, b], done, base).deleteRunChecked({ runId: RUN_ID as never });
    if (res.ok || !('needsConfirm' in res)) throw new Error('expected needsConfirm');
    expect(res.dirty.map((d) => d.name)).toEqual(['b']);
    expect(existsSync(a.worktreePath)).toBe(true);
  });

  it('gives up its landed tree alone, keeping the branch', async () => {
    const a = squashed('a');
    const b = ahead('b');
    const res = await runtimeWith([a, b], done, base).retireRunWorktrees({
      runId: RUN_ID as never,
      worktreePaths: [a.worktreePath, b.worktreePath],
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.removed).toEqual([a.worktreePath]);
    expect(res.kept.map((k) => k.worktreePath)).toEqual([b.worktreePath]);
    expect(git(a.projectPath, 'branch', '--list', 'agent/x')).toContain('agent/x');
  });
});

describe('deleting a run from Clean up', () => {
  const done = { kind: 'done' } as FlowRun['state'];
  function ahead(name: string) {
    const m = member(name);
    writeFileSync(join(m.worktreePath, 'feature.txt'), 'real work\n');
    git(m.worktreePath, 'add', '-A');
    git(m.worktreePath, 'commit', '-qm', 'real work');
    return m;
  }

  it('keeps a branch with commits and deletes an empty one', async () => {
    const a = ahead('a');
    const b = member('b');
    const runtime = runtimeWith([a, b], done, { baseBranch: 'master' });
    const res = await runtime.deleteRunChecked({ runId: RUN_ID as never, force: true, keepUnmergedBranches: true });
    expect(res).toEqual({ ok: true });
    await vi.waitFor(() => expect(existsSync(b.worktreePath)).toBe(false));
    await vi.waitFor(() => expect(git(b.projectPath, 'branch', '--list', 'agent/x')).toBe(''));
    expect(existsSync(a.worktreePath)).toBe(false);
    expect(git(a.projectPath, 'branch', '--list', 'agent/x')).toContain('agent/x');
  });

  it('a delete from elsewhere still deletes them', async () => {
    const a = ahead('a');
    const runtime = runtimeWith([a], done, { baseBranch: 'master' });
    expect(await runtime.deleteRunChecked({ runId: RUN_ID as never, force: true })).toEqual({ ok: true });
    await vi.waitFor(() => expect(git(a.projectPath, 'branch', '--list', 'agent/x')).toBe(''));
  });
});

