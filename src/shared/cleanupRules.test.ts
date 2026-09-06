import { describe, expect, it } from 'vitest';
import type { WorktreeSweepEntry } from './types';
import {
  DEFAULT_CLEANUP_RULES,
  describeRules,
  retirable,
  runawayProducers,
} from './cleanupRules';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

function entry(over: Partial<WorktreeSweepEntry> & { worktreePath: string }): WorktreeSweepEntry {
  return {
    projectPath: '/proj',
    projectName: 'overcli',
    branchName: 'b',
    baseBranch: 'master',
    bucket: 'reclaimable',
    referenced: 'run',
    locked: false,
    prunable: false,
    dirtyFiles: 0,
    commitsAhead: 0,
    isMergedIntoBase: true,
    sizeKb: 100,
    ...over,
  };
}

/// Producer key and age come from the caller in the real code; here they read
/// off fields the fixtures set directly.
const keyOf = (e: WorktreeSweepEntry) => e.claim?.workerId ?? 'orphan';
const ageOf = (e: WorktreeSweepEntry) => e.lastCommitAt ?? 0;

function shift(worker: string, daysAgo: number, over: Partial<WorktreeSweepEntry> = {}) {
  return entry({
    worktreePath: `/wt/${worker}-${daysAgo}`,
    lastCommitAt: NOW - daysAgo * DAY,
    claim: {
      worktreePath: `/wt/${worker}-${daysAgo}`,
      kind: 'run',
      title: 'Shift',
      workerId: worker,
    },
    ...over,
  });
}

describe('retirable', () => {
  const rules = { retireAfterDays: 7, keepPerProducer: 3, warnAtCount: 25 };

  it('retires finished work past the age threshold', () => {
    const out = retirable(
      [shift('w1', 30), shift('w1', 20), shift('w1', 15), shift('w1', 10)],
      { ...rules, keepPerProducer: 0 },
      keyOf,
      ageOf,
      NOW,
    );
    expect(out).toHaveLength(4);
  });

  it('holds back the newest few per producer whatever their age', () => {
    const out = retirable(
      [shift('w1', 40), shift('w1', 30), shift('w1', 20), shift('w1', 10)],
      rules,
      keyOf,
      ageOf,
      NOW,
    );
    // Newest three kept; only the 40-day-old one goes.
    expect(out.map((e) => e.worktreePath)).toEqual(['/wt/w1-40']);
  });

  it('counts the hold-back per producer, not across all of them', () => {
    const out = retirable(
      [shift('w1', 40), shift('w1', 39), shift('w2', 38), shift('w2', 37)],
      { ...rules, keepPerProducer: 1 },
      keyOf,
      ageOf,
      NOW,
    );
    // Each producer keeps its own newest one; the older of each pair goes.
    expect(out.map((e) => e.worktreePath).sort()).toEqual(['/wt/w1-40', '/wt/w2-38']);
  });

  it('never retires anything holding work, however old', () => {
    const out = retirable(
      [shift('w1', 400, { bucket: 'has-work', dirtyFiles: 3 })],
      { ...rules, keepPerProducer: 0 },
      keyOf,
      ageOf,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('never retires a live or foreign tree', () => {
    const out = retirable(
      [shift('w1', 400, { bucket: 'live' }), shift('w2', 400, { bucket: 'foreign' })],
      { ...rules, keepPerProducer: 0 },
      keyOf,
      ageOf,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('never retires something it cannot date', () => {
    const undated = entry({ worktreePath: '/wt/undated', lastCommitAt: undefined });
    expect(retirable([undated], { ...rules, keepPerProducer: 0 }, keyOf, ageOf, NOW)).toEqual([]);
  });

  it('retires nothing when the rules are off', () => {
    const out = retirable(
      [shift('w1', 400)],
      { ...rules, retireAfterDays: 0, keepPerProducer: 0 },
      keyOf,
      ageOf,
      NOW,
    );
    expect(out).toEqual([]);
  });

  it('leaves work newer than the threshold alone', () => {
    const out = retirable(
      [shift('w1', 3), shift('w1', 2)],
      { ...rules, keepPerProducer: 0 },
      keyOf,
      ageOf,
      NOW,
    );
    expect(out).toEqual([]);
  });
});

describe('runawayProducers', () => {
  const group = (key: string, count: number, safe = count) => ({
    key,
    name: key,
    entries: Array.from({ length: count }, (_, i) => i),
    safe: Array.from({ length: safe }, (_, i) => i),
    totalKb: count * 100,
  });

  it('reports producers at or past the threshold, worst first', () => {
    const out = runawayProducers([group('a', 42), group('b', 3), group('c', 25)], {
      ...DEFAULT_CLEANUP_RULES,
      warnAtCount: 25,
    });
    expect(out.map((g) => g.key)).toEqual(['a', 'c']);
    expect(out[0].count).toBe(42);
  });

  it('says nothing when warnings are off', () => {
    expect(runawayProducers([group('a', 999)], { ...DEFAULT_CLEANUP_RULES, warnAtCount: 0 })).toEqual(
      [],
    );
  });
});

describe('describeRules', () => {
  it('says plainly when auto-tidy is off', () => {
    expect(describeRules({ ...DEFAULT_CLEANUP_RULES, retireAfterDays: 0 })).toMatch(/off/);
  });

  it('describes the active rule in days', () => {
    expect(describeRules(DEFAULT_CLEANUP_RULES)).toContain('7 days old');
    expect(describeRules({ ...DEFAULT_CLEANUP_RULES, retireAfterDays: 1 })).toContain('a day old');
  });
});
