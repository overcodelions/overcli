import { describe, expect, it } from 'vitest';

import type { StrandedLanding } from '../../../shared/flows/landingAudit';
import { landabilityLabel, notMergedRows } from './notMerged';

function landing(over: Partial<StrandedLanding>): StrandedLanding {
  return {
    workerId: 'w1',
    workerName: 'Prometheus',
    orchestrationId: 'o1',
    batchTitle: 'Shift',
    itemTitle: 'Work',
    headSha: 'a'.repeat(40),
    projectPath: '/repo',
    baseBranch: 'master',
    landability: 'clean',
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
});

describe('landabilityLabel', () => {
  it('names the verdict and how far base has moved', () => {
    expect(landabilityLabel(landing({})).text).toBe('merges cleanly');
    expect(landabilityLabel(landing({ landability: 'conflicts', baseAdvance: 1 })).hint).toContain('master has moved 1 commit since');
    expect(landabilityLabel(landing({ landability: 'unknown', baseAdvance: null })).hint).not.toContain('moved');
  });
});
