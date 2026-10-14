import { describe, expect, it } from 'vitest';

import type { StrandedLanding } from '../../../shared/flows/landingAudit';
import { conflictSummary, landabilityLabel, notMergedRows, rebuildInstruction } from './notMerged';

function landing(over: Partial<StrandedLanding>): StrandedLanding {
  return {
    workerId: 'w1',
    workerName: 'Prometheus',
    orchestrationId: 'o1',
    batchCreatedAt: 0,
    batchTitle: 'Shift',
    itemTitle: 'Work',
    headSha: 'a'.repeat(40),
    projectPath: '/repo',
    baseBranch: 'master',
    landability: 'clean',
    conflictFiles: [],
    baseAdvance: 2,
    branchResolves: true,
    ...over,
  };
}

describe('notMergedRows', () => {
  it('lists mergeable work first, then conflicts, then unchecked, newest first within each', () => {
    const rows = notMergedRows(
      [
        landing({ itemTitle: 'old conflict', landability: 'conflicts', finishedAt: 1 }),
        landing({ itemTitle: 'unknown', landability: 'unknown', finishedAt: 9 }),
        landing({ itemTitle: 'old clean', finishedAt: 2 }),
        landing({ itemTitle: 'new conflict', landability: 'conflicts', finishedAt: 5 }),
        landing({ itemTitle: 'new clean', finishedAt: 3 }),
      ],
      null,
    );
    expect(rows.map((r) => r.itemTitle)).toEqual(['new clean', 'old clean', 'new conflict', 'old conflict', 'unknown']);
  });

  it("narrows to one worker's inbox", () => {
    const rows = notMergedRows([landing({ workerId: 'w1' }), landing({ workerId: 'w2', itemTitle: 'other' })], 'w2');
    expect(rows.map((r) => r.itemTitle)).toEqual(['other']);
  });
  it('fills in conflict files an older main process did not send', () => {
    const stale = { ...landing({}), conflictFiles: undefined } as unknown as StrandedLanding;
    expect(notMergedRows([stale], null)[0].conflictFiles).toEqual([]);
  });
});

describe('landabilityLabel', () => {
  it('names the verdict and how far base has moved', () => {
    expect(landabilityLabel(landing({})).text).toBe('merges cleanly');
    expect(landabilityLabel(landing({ landability: 'conflicts', baseAdvance: 1 })).hint).toContain('master has moved 1 commit since');
    expect(landabilityLabel(landing({ landability: 'unknown', baseAdvance: null })).hint).not.toContain('moved');
  });
});

describe('rebuildInstruction', () => {
  it('names the commit, base and branch, and forbids merging or pushing', () => {
    const text = rebuildInstruction(
      landing({ itemTitle: 'Add audit', landability: 'conflicts', branchName: 'prometheus/x', baseAdvance: 4 }),
    );
    expect(text).toContain('"Add audit"');
    expect(text).toContain('a'.repeat(40));
    expect(text).toContain('`prometheus/x`');
    expect(text).toContain('gained 4 commits');
    expect(text).toMatch(/Do not merge into `master` and do not push/);
  });

  it('leaves out a branch that no longer resolves', () => {
    expect(rebuildInstruction(landing({ branchName: 'gone', branchResolves: false }))).not.toContain('`gone`');
  });
});

describe('conflict files', () => {
  it('names them in the rebuild brief', () => {
    expect(rebuildInstruction(landing({ landability: 'conflicts', conflictFiles: ['a.ts', 'b.ts'] }))).toContain(
      'It conflicts in: `a.ts`, `b.ts`.',
    );
  });

  it('summarises a long list', () => {
    expect(conflictSummary(['a', 'b'])).toBe('a, b');
    expect(conflictSummary(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, +2 more');
  });
});
