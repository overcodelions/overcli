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

function runtimeWith(members: ReturnType<typeof member>[], state: FlowRun['state']) {
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

  it('keeps the branch of a clean tree whose commits reached the base', async () => {
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
    expect(git(merged.projectPath, 'branch', '--list', 'agent/x')).toContain('agent/x');
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
