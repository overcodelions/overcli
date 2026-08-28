// Real-git integration test for the "work at risk" checks that guard a flow
// run's worktree.
//
// `runtime.test.ts` covers the same behaviour with a mocked `../git`, which
// proves the branching logic but NOT that the git commands themselves say what
// the code assumes. That gap matters here: the whole defect was a wrong
// assumption about what `git status --porcelain` reports for a worktree whose
// work has been committed. A mock can only ever repeat the assumption back.
//
// So this file deliberately does NOT mock `../git`. It builds a real
// repository, forks a real worktree, makes a real commit, and lets
// `runDirtyWorktrees` / `runIsDirtyAsync` shell out for real. `src/main/git.ts`
// imports only node built-ins, so nothing but the store/Electron surface needs
// stubbing.
//
// Not covered here: `pruneOldRuns`, which needs 50 seeded runs and would mean
// 50 real worktrees. The mocked suite in `runtime.test.ts` owns that gate.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';
import type { FlowRun } from '../../shared/flows/schema';

const seeded = vi.hoisted(() => ({ runs: [] as FlowRun[] }));

useTestHost('/tmp/overcli-real-git-tests');
vi.mock('./runsStore', () => ({
  loadAllRuns: () => seeded.runs,
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./storage', () => ({ loadAllFlows: () => [] }));

import { FlowRuntimeImpl } from './runtime';

/// A repo plus three worktrees, one per state the guard has to tell apart.
let root: string;
let repo: string;
/// Clean working tree, one commit the base branch has never seen. THE case:
/// `git status` is empty here, so a files-only check waved it through to
/// `git worktree remove` + `git branch -D`.
let committedUnmerged: string;
/// Clean working tree, nothing ahead of base. Nothing is at risk.
let fullyMerged: string;
/// Uncommitted edits, nothing committed. The case that always worked.
let uncommittedOnly: string;
/// Sacrificial copy of the committed-unmerged shape, used by the one test
/// that has to tear a worktree down to observe git's refusal.
let throwaway: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'overcli-real-git-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'master', repo], { cwd: root });
  git(repo, 'config', 'user.email', 'flows@overcli.test');
  git(repo, 'config', 'user.name', 'Overcli Test');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base commit');

  // The well-behaved agent: finishes the work AND commits it.
  committedUnmerged = join(root, 'wt-committed-unmerged');
  git(repo, 'worktree', 'add', '-q', '-b', 'flow/committed-unmerged', committedUnmerged, 'master');
  writeFileSync(join(committedUnmerged, 'feature.txt'), 'the agent shipped this\n');
  git(committedUnmerged, 'add', '-A');
  git(committedUnmerged, 'commit', '-qm', 'agent: implement the feature');

  fullyMerged = join(root, 'wt-fully-merged');
  git(repo, 'worktree', 'add', '-q', '-b', 'flow/fully-merged', fullyMerged, 'master');

  uncommittedOnly = join(root, 'wt-uncommitted');
  git(repo, 'worktree', 'add', '-q', '-b', 'flow/uncommitted', uncommittedOnly, 'master');
  writeFileSync(join(uncommittedOnly, 'scratch.txt'), 'half-finished\n');

  throwaway = join(root, 'wt-throwaway');
  git(repo, 'worktree', 'add', '-q', '-b', 'flow/throwaway', throwaway, 'master');
  writeFileSync(join(throwaway, 'feature.txt'), 'also unmerged\n');
  git(throwaway, 'add', '-A');
  git(throwaway, 'commit', '-qm', 'agent: another unmerged commit');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedRun(over: Partial<FlowRun>): FlowRun {
  return {
    id: 'run-x',
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Flow', steps: [], participants: [] },
    projectPath: repo,
    sourceProjectPath: repo,
    userPrompt: 'do the thing',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done' },
    createdAt: 1,
    attempts: [],
    ...over,
  } as FlowRun;
}

function runtimeWith(runs: FlowRun[]): FlowRuntimeImpl {
  seeded.runs = runs;
  return new FlowRuntimeImpl(
    { send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as never,
  );
}

describe('flow worktree guard — against real git', () => {
  it('confirms the premise: a committed worktree looks spotless to git status', () => {
    // If this ever fails, the bug this guard exists for has changed shape and
    // every assertion below is testing the wrong thing.
    expect(git(committedUnmerged, 'status', '--porcelain')).toBe('');
    expect(git(committedUnmerged, 'rev-list', '--count', 'master..HEAD')).toBe('1');
  });

  it('confirms git itself refuses the branch delete, which the teardown then overrides', () => {
    // `removeWorktreeAsync` catches exactly this refusal and escalates to
    // `branch -D`. Documenting the real stderr here means a future git that
    // reworded it can't silently turn that fallback into a no-op.
    //
    // ORDER MATTERS, and getting it wrong hides the whole thing: with the
    // worktree still present git refuses with "Cannot delete branch …
    // checked out at …" and never mentions merge state at all. The
    // "not fully merged" refusal — the one the fallback keys off — only
    // appears once the worktree is gone, which is exactly the sequence
    // `removeWorktreeAsync` runs.
    git(repo, 'worktree', 'remove', '--force', throwaway);

    let stderr = '';
    try {
      git(repo, 'branch', '-d', 'flow/throwaway');
    } catch (err) {
      stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(stderr).toMatch(/not fully merged/i);
    // The refusal destroyed nothing — the branch, and the commit, survive.
    expect(git(repo, 'branch', '--list', 'flow/throwaway')).toContain('flow/throwaway');
  });

  it('flags a done run whose branch has unmerged commits', async () => {
    const runtime = runtimeWith([
      seedRun({
        id: 'committed-unmerged',
        worktreePath: committedUnmerged,
        branchName: 'flow/committed-unmerged',
        baseBranch: 'master',
      }),
    ]);
    expect(await runtime.unreviewedDoneRunIds()).toEqual(['committed-unmerged']);
  });

  it('does not flag a run whose branch is level with its base', async () => {
    const runtime = runtimeWith([
      seedRun({
        id: 'fully-merged',
        worktreePath: fullyMerged,
        branchName: 'flow/fully-merged',
        baseBranch: 'master',
      }),
    ]);
    expect(await runtime.unreviewedDoneRunIds()).toEqual([]);
  });

  it('still flags plain uncommitted changes, with no commits ahead', () => {
    const runtime = runtimeWith([
      seedRun({
        id: 'uncommitted',
        worktreePath: uncommittedOnly,
        branchName: 'flow/uncommitted',
        baseBranch: 'master',
      }),
    ]);
    const result = runtime.deleteRun({ runId: 'uncommitted' as never });
    if (result.ok || !('needsConfirm' in result)) throw new Error('expected needsConfirm');
    expect(result.dirty[0].fileCount).toBeGreaterThan(0);
    expect(result.dirty[0].unmergedCommits).toBe(0);
  });

  it('makes deleteRun stop and ask, reporting the real commit count', () => {
    const runtime = runtimeWith([
      seedRun({
        id: 'committed-unmerged',
        worktreePath: committedUnmerged,
        branchName: 'flow/committed-unmerged',
        baseBranch: 'master',
      }),
    ]);

    const result = runtime.deleteRun({ runId: 'committed-unmerged' as never });

    expect(result.ok).toBe(false);
    if (result.ok || !('needsConfirm' in result)) throw new Error('expected needsConfirm');
    expect(result.dirty).toHaveLength(1);
    // Counted by real `git rev-list`, not a fixture.
    expect(result.dirty[0].unmergedCommits).toBe(1);
    // ...while the working tree really is clean. This pairing is the bug.
    expect(result.dirty[0].fileCount).toBe(0);
    // The run — and its worktree — survive a declined confirm.
    expect(runtime.getRun('committed-unmerged' as never)).not.toBeNull();
    expect(git(repo, 'branch', '--list', 'flow/committed-unmerged')).toContain(
      'flow/committed-unmerged',
    );
  });
});
