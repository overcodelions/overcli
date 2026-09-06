import { describe, expect, it } from 'vitest';
import type { Conversation, WorktreeSweepEntry } from '@shared/types';
import {
  conversationClaims,
  entryAgeAt,
  filterEntries,
  formatSize,
  groupEntries,
  groupKeyFor,
  isActionable,
  planCleanup,
  planRelease,
  totalsFor,
} from './cleanup';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function entry(over: Partial<WorktreeSweepEntry> = {}): WorktreeSweepEntry {
  return {
    worktreePath: '/wt/x',
    projectPath: '/proj',
    projectName: 'overcli',
    branchName: 'feature/x',
    baseBranch: 'master',
    bucket: 'reclaimable',
    referenced: null,
    locked: false,
    prunable: false,
    dirtyFiles: 0,
    commitsAhead: 0,
    isMergedIntoBase: true,
    sizeKb: 1024,
    ...over,
  };
}

function shift(worker: string, over: Partial<WorktreeSweepEntry> = {}): WorktreeSweepEntry {
  return entry({
    worktreePath: `/wt/${worker}-${over.branchName ?? 'a'}`,
    referenced: 'run',
    claim: {
      worktreePath: `/wt/${worker}-${over.branchName ?? 'a'}`,
      kind: 'run',
      runId: `run-${worker}-${over.branchName ?? 'a'}`,
      title: 'Shift',
      workerId: worker,
      workerName: `Worker ${worker}`,
      flowId: 'audit',
      flowName: 'Audit',
      activeAt: NOW - 10 * DAY,
    },
    ...over,
  });
}

describe('conversationClaims', () => {
  const conv = (over: Partial<Conversation>): Conversation =>
    ({
      id: 'c1',
      name: 'Chat',
      createdAt: 100,
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: 'default',
      ...over,
    }) as Conversation;

  it('claims only conversations that own a worktree', () => {
    const claims = conversationClaims(
      [{ conversations: [conv({ id: 'a', worktreePath: '/wt/a' }), conv({ id: 'b' })] }],
      {},
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].convId).toBe('a');
  });

  it('marks a streaming conversation busy', () => {
    const [claim] = conversationClaims(
      [{ conversations: [conv({ id: 'a', worktreePath: '/wt/a' })] }],
      { a: true },
    );
    expect(claim.busy).toBe(true);
  });

  it('flags a borrowed tree so removal takes the borrowing row too', () => {
    const [claim] = conversationClaims(
      [{ conversations: [conv({ id: 'a', worktreePath: '/wt/a', adoptedWorktree: true })] }],
      {},
    );
    expect(claim.adoptedConvIds).toEqual(['a']);
  });
});

describe('groupKeyFor', () => {
  it('files a worker shift under the worker, not the flow it used', () => {
    expect(groupKeyFor(shift('w1'))).toEqual({ key: 'worker:w1', kind: 'worker' });
  });

  it('files an unowned flow run under the flow', () => {
    const e = entry({
      claim: { worktreePath: '/wt/x', kind: 'run', runId: 'r', title: 'Run', flowId: 'audit' },
    });
    expect(groupKeyFor(e)).toEqual({ key: 'flow:audit', kind: 'flow' });
  });

  it('files a plain agent chat under chat', () => {
    const e = entry({
      claim: { worktreePath: '/wt/x', kind: 'conversation', convId: 'c1', title: 'Chat' },
    });
    expect(groupKeyFor(e)).toEqual({ key: 'chat', kind: 'chat' });
  });

  it('files an unclaimed tree under orphan and a foreign one under foreign', () => {
    expect(groupKeyFor(entry()).kind).toBe('orphan');
    expect(groupKeyFor(entry({ bucket: 'foreign' })).kind).toBe('foreign');
  });

  it('keeps a foreign tree out of its producer group', () => {
    // Honest accounting beats tidy grouping: a tree outside the managed root
    // is never ours to delete, whoever appears to have made it.
    expect(groupKeyFor(shift('w1', { bucket: 'foreign' })).kind).toBe('foreign');
  });
});

describe('groupEntries', () => {
  it('collapses one worker’s shifts into a single group', () => {
    const groups = groupEntries([
      shift('w1', { branchName: 'a' }),
      shift('w1', { branchName: 'b' }),
      shift('w1', { branchName: 'c', bucket: 'has-work', dirtyFiles: 3 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Worker w1');
    expect(groups[0].entries).toHaveLength(3);
    expect(groups[0].safe).toHaveLength(2);
    expect(groups[0].hasWork).toHaveLength(1);
    expect(groups[0].safeKb).toBe(2048);
  });

  it('orders workers first and by the safe disk they are sitting on', () => {
    const groups = groupEntries([
      entry({ worktreePath: '/wt/orphan', sizeKb: 99_999 }),
      shift('small', { sizeKb: 10 }),
      shift('big', { sizeKb: 5_000 }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['worker', 'worker', 'orphan']);
    expect(groups[0].name).toBe('Worker big');
  });

  it('sorts safe rows above rows that need a decision', () => {
    const groups = groupEntries([
      shift('w1', { branchName: 'dirty', bucket: 'has-work', dirtyFiles: 2 }),
      shift('w1', { branchName: 'clean' }),
    ]);
    expect(groups[0].entries.map((e) => e.bucket)).toEqual(['reclaimable', 'has-work']);
  });
});

describe('filterEntries', () => {
  const rows = [
    shift('w1', { branchName: 'recent', claim: { ...shift('w1').claim!, activeAt: NOW - 2 * DAY } }),
    shift('w2', { branchName: 'old', claim: { ...shift('w2').claim!, activeAt: NOW - 40 * DAY } }),
    entry({ worktreePath: '/wt/undated', lastCommitAt: undefined }),
  ];
  const base = { query: '', minAgeDays: 0, bucket: 'all' as const, now: NOW };

  it('filters by age and keeps undated rows visible', () => {
    const out = filterEntries(rows, { ...base, minAgeDays: 30 });
    expect(out.map((e) => e.worktreePath)).toEqual(['/wt/w2-old', '/wt/undated']);
  });

  it('searches worker name, branch and path', () => {
    expect(filterEntries(rows, { ...base, query: 'Worker w2' })).toHaveLength(1);
    expect(filterEntries(rows, { ...base, query: 'recent' })).toHaveLength(1);
    expect(filterEntries(rows, { ...base, query: 'undated' })).toHaveLength(1);
  });

  it('filters by bucket', () => {
    const withWork = [...rows, shift('w3', { bucket: 'has-work' })];
    expect(filterEntries(withWork, { ...base, bucket: 'has-work' })).toHaveLength(1);
  });
});

describe('totalsFor', () => {
  it('counts each bucket and only sums disk it could measure', () => {
    const totals = totalsFor([
      entry({ sizeKb: 100 }),
      entry({ bucket: 'has-work', sizeKb: 50 }),
      entry({ bucket: 'live', sizeKb: 0 }),
      entry({ bucket: 'foreign', sizeKb: 0 }),
    ]);
    expect(totals).toEqual({ safe: 1, safeKb: 100, hasWork: 1, live: 1, foreign: 1, totalKb: 150 });
  });
});

describe('planCleanup', () => {
  it('routes each producer to its own teardown', () => {
    const plan = planCleanup([
      shift('w1'),
      entry({
        worktreePath: '/wt/chat',
        claim: { worktreePath: '/wt/chat', kind: 'conversation', convId: 'c1', title: 'Chat' },
      }),
      entry({ worktreePath: '/wt/orphan' }),
    ]);
    expect(plan.removeRunIds).toEqual(['run-w1-a']);
    expect(plan.removeAgentIds).toEqual(['c1']);
    expect(plan.sweepEntries.map((e) => e.worktreePath)).toEqual(['/wt/orphan']);
    expect(plan.worktreeCount).toBe(3);
  });

  it('never deletes a run twice when several of its trees are selected', () => {
    const claim = {
      worktreePath: '/wt/ws',
      kind: 'run' as const,
      runId: 'r1',
      title: 'Workspace run',
    };
    const plan = planCleanup([
      entry({ worktreePath: '/wt/ws/api', claim: { ...claim, worktreePath: '/wt/ws/api' } }),
      entry({ worktreePath: '/wt/ws/web', claim: { ...claim, worktreePath: '/wt/ws/web' } }),
    ]);
    expect(plan.removeRunIds).toEqual(['r1']);
    expect(plan.runCount).toBe(1);
    expect(plan.worktreeCount).toBe(2);
  });

  it('takes borrowed conversation rows with the tree they point at', () => {
    const plan = planCleanup([
      entry({
        worktreePath: '/wt/shared',
        claim: {
          worktreePath: '/wt/shared',
          kind: 'run',
          runId: 'r1',
          title: 'Run',
          adoptedConvIds: ['borrower'],
        },
      }),
    ]);
    expect(plan.removeAdoptedIds).toEqual(['borrower']);
    expect(plan.conversationCount).toBe(1);
  });

  it('flags a run that owns worktrees outside the selection', () => {
    // Deleting a run removes EVERY tree it owns. Ticking one clean member of
    // a workspace run must not authorise force-deleting the others, which the
    // user never saw — the flow runtime's own guard has to decide those.
    const claim = { kind: 'run' as const, runId: 'r1', title: 'Workspace run' };
    const selectedTree = entry({
      worktreePath: '/wt/ws/api',
      claim: { ...claim, worktreePath: '/wt/ws/api' },
    });
    const unselectedTree = entry({
      worktreePath: '/wt/ws/web',
      bucket: 'has-work',
      dirtyFiles: 9,
      claim: { ...claim, worktreePath: '/wt/ws/web' },
    });
    const plan = planCleanup([selectedTree], [selectedTree, unselectedTree]);
    expect(plan.removeRunIds).toEqual(['r1']);
    expect(plan.runsHoldingMore).toEqual(['r1']);
  });

  it('does not flag a run whose every worktree is selected', () => {
    const claim = { kind: 'run' as const, runId: 'r1', title: 'Workspace run' };
    const rows = ['/wt/ws/api', '/wt/ws/web'].map((worktreePath) =>
      entry({ worktreePath, claim: { ...claim, worktreePath } }),
    );
    expect(planCleanup(rows, rows).runsHoldingMore).toEqual([]);
  });

  it('treats an unknown wider list as the selection itself', () => {
    const e = shift('w1');
    expect(planCleanup([e]).runsHoldingMore).toEqual([]);
  });

  it('refuses busy and foreign rows with a reason instead of dropping them', () => {
    const plan = planCleanup([
      entry({ worktreePath: '/wt/busy', bucket: 'live' }),
      entry({ worktreePath: '/wt/theirs', bucket: 'foreign' }),
    ]);
    expect(plan.worktreeCount).toBe(0);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['busy', 'foreign']);
  });

  it('counts what removal would destroy', () => {
    const plan = planCleanup([
      entry({ bucket: 'has-work', dirtyFiles: 4, sizeKb: 200 }),
      entry({ worktreePath: '/wt/clean', sizeKb: 300 }),
    ]);
    expect(plan.withWorkCount).toBe(1);
    expect(plan.freedKb).toBe(500);
  });
});

describe('planRelease', () => {
  it('releases conversation-owned trees and reports what it cannot', () => {
    const res = planRelease([
      entry({
        worktreePath: '/wt/chat',
        sizeKb: 100,
        claim: { worktreePath: '/wt/chat', kind: 'conversation', convId: 'c1', title: 'Chat' },
      }),
      shift('w1'),
      entry({ worktreePath: '/wt/orphan' }),
    ]);
    expect(res.releaseIds).toEqual(['c1']);
    expect(res.freedKb).toBe(100);
    expect(res.notReleasable.map((e) => e.worktreePath)).toEqual(['/wt/w1-a', '/wt/orphan']);
  });

  it('ignores rows that cannot be acted on at all', () => {
    const res = planRelease([entry({ bucket: 'live' }), entry({ bucket: 'foreign' })]);
    expect(res.releaseIds).toEqual([]);
    expect(res.notReleasable).toEqual([]);
  });
});

describe('entryAgeAt', () => {
  it('prefers what the claim knows over the last commit', () => {
    expect(
      entryAgeAt(
        entry({
          lastCommitAt: 500,
          claim: { worktreePath: '/wt/x', kind: 'run', title: 'r', activeAt: 900 },
        }),
      ),
    ).toBe(900);
  });

  it('falls back to the last commit, then to undated', () => {
    expect(entryAgeAt(entry({ lastCommitAt: 500 }))).toBe(500);
    expect(entryAgeAt(entry())).toBe(0);
  });
});

describe('isActionable', () => {
  it('allows safe and has-work, refuses live and foreign', () => {
    expect(isActionable(entry())).toBe(true);
    expect(isActionable(entry({ bucket: 'has-work' }))).toBe(true);
    expect(isActionable(entry({ bucket: 'live' }))).toBe(false);
    expect(isActionable(entry({ bucket: 'foreign' }))).toBe(false);
  });
});

describe('formatSize', () => {
  it('scales units and shows a dash for nothing', () => {
    expect(formatSize(0)).toBe('—');
    expect(formatSize(512)).toBe('512 KB');
    expect(formatSize(2048)).toBe('2 MB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 GB');
  });
});
