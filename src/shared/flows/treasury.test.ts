import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TREASURY_USD,
  allocateTreasury,
  describeFundingBlock,
  distributeRemainingFunds,
  fundingFor,
  seedTreasury,
  starvedWorkers,
  validateTreasury,
} from './treasury';
import type { Worker } from './worker';

type Seed = Pick<Worker, 'id' | 'name' | 'order' | 'createdAt' | 'enabled' | 'budgetUSDPerMonth'>;

function w(id: string, cap: number, over: Partial<Seed> = {}): Seed {
  return {
    id,
    name: id.toUpperCase(),
    order: undefined,
    createdAt: 1,
    enabled: true,
    budgetUSDPerMonth: cap,
    ...over,
  };
}

/// Roster order is the funding order, so most cases here set `order`
/// explicitly rather than leaning on hire dates.
function roster(...caps: Array<[string, number, Partial<Seed>?]>): Seed[] {
  return caps.map(([id, cap, over], i) => w(id, cap, { order: i, ...over }));
}

const noSpend = () => 0;

describe('allocateTreasury', () => {
  it('funds everyone to their cap when the pot covers the roster', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['b', 10], ['c', 10]), noSpend, 30);
    expect(alloc.byWorker.map((f) => f.availableUSD)).toEqual([10, 10, 10]);
    expect(alloc.byWorker.map((f) => f.blocked)).toEqual(['none', 'none', 'none']);
    expect(alloc.remainingUSD).toBe(30);
  });

  it('squeezes the BOTTOM of the roster when the pot is short, not the top', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['b', 10], ['c', 10]), noSpend, 15);
    expect(alloc.byWorker.map((f) => f.availableUSD)).toEqual([10, 5, 0]);
    expect(alloc.byWorker.map((f) => f.blocked)).toEqual(['none', 'none', 'pool']);
    expect(starvedWorkers(alloc).map((f) => f.name)).toEqual(['C']);
  });

  it('holds a top worker its unspent cap rather than letting the one below eat it', () => {
    // The whole promise of the waterfall: `b` is hungry and `a` is idle, but
    // `a` is above it, so `a`'s reserve survives the month.
    const spent = new Map([['b', 8]]);
    const alloc = allocateTreasury(roster(['a', 10], ['b', 20]), (id) => spent.get(id) ?? 0, 20);
    expect(fundingFor(alloc, 'a')?.availableUSD).toBe(10);
    // 20 pot − 8 spent = 12 left, 10 of which is a's reserve.
    expect(fundingFor(alloc, 'b')?.availableUSD).toBe(2);
  });

  it('releases a reserve as its owner spends it, so money trickles down', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['b', 20]), (id) => (id === 'a' ? 10 : 0), 20);
    // `a` is done; its claim is gone, and the remaining $10 all reaches `b`.
    expect(fundingFor(alloc, 'a')).toMatchObject({
      availableUSD: 0,
      blocked: 'cap',
    });
    expect(fundingFor(alloc, 'b')?.availableUSD).toBe(10);
  });

  it('frees a paused worker’s reserve to everyone below it', () => {
    const paused = allocateTreasury(roster(['a', 10, { enabled: false }], ['b', 10]), noSpend, 10);
    expect(fundingFor(paused, 'a')).toMatchObject({
      availableUSD: 0,
      blocked: 'paused',
    });
    expect(fundingFor(paused, 'b')?.availableUSD).toBe(10);

    // ...but pausing does NOT refund what it already spent.
    const spentThenPaused = allocateTreasury(
      roster(['a', 10, { enabled: false }], ['b', 10]),
      (id) => (id === 'a' ? 6 : 0),
      10,
    );
    expect(spentThenPaused.remainingUSD).toBe(4);
    expect(fundingFor(spentThenPaused, 'b')?.availableUSD).toBe(4);
  });

  it('reordering is the funding decision — the same roster, moved, pays differently', () => {
    const before = allocateTreasury(roster(['a', 10], ['b', 10]), noSpend, 10);
    expect(before.byWorker.map((f) => f.availableUSD)).toEqual([10, 0]);

    const after = allocateTreasury([w('a', 10, { order: 1 }), w('b', 10, { order: 0 })], noSpend, 10);
    expect(after.byWorker.map((f) => f.name)).toEqual(['B', 'A']);
    expect(after.byWorker.map((f) => f.availableUSD)).toEqual([10, 0]);
  });

  it('stops a worker at its own cap even when the pot is deep', () => {
    const alloc = allocateTreasury(roster(['a', 5]), (id) => (id === 'a' ? 5 : 0), 500);
    expect(fundingFor(alloc, 'a')).toMatchObject({
      availableUSD: 0,
      blocked: 'cap',
    });
    expect(alloc.remainingUSD).toBe(495);
  });

  it('spend from a worker no longer on the roster still counts against the pot', () => {
    const alloc = allocateTreasury(roster(['b', 50]), () => 0, 50, 30);
    expect(alloc.spentUSD).toBe(30);
    expect(alloc.remainingUSD).toBe(20);
    expect(fundingFor(alloc, 'b')!.availableUSD).toBe(20);
  });

  it('counts spend from workers who are no longer funded, and never goes negative', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['b', 10]), () => 30, 20);
    expect(alloc.spentUSD).toBe(60);
    expect(alloc.remainingUSD).toBe(0);
    expect(alloc.byWorker.every((f) => f.availableUSD === 0)).toBe(true);
  });

  it('treats sub-cent funding as no funding', () => {
    const alloc = allocateTreasury(roster(['a', 10]), () => 9.999, 10);
    const a = fundingFor(alloc, 'a')!;
    expect(a.availableUSD).toBeLessThan(0.01);
    expect(a.funded).toBe(false);
    expect(a.blocked).toBe('cap');
  });

  it('numbers priorities from one, in roster order, falling back to newest hire first', () => {
    const alloc = allocateTreasury([w('old', 5, { createdAt: 1 }), w('new', 5, { createdAt: 2 })], noSpend, 10);
    expect(alloc.byWorker.map((f) => [f.name, f.priority])).toEqual([
      ['NEW', 1],
      ['OLD', 2],
    ]);
  });

  it('numbers the QUEUE over enabled workers only, so a paused row takes no place in it', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['paused', 10, { enabled: false }], ['b', 10]), noSpend, 30);
    expect(alloc.byWorker.map((f) => [f.name, f.priority, f.queuePosition])).toEqual([
      ['A', 1, 1],
      ['PAUSED', 2, 0],
      ['B', 3, 2],
    ]);
  });
});

describe('describeFundingBlock', () => {
  it('tells a starved worker what to do about it, and a capped one that it is over', () => {
    const alloc = allocateTreasury(roster(['a', 10], ['b', 10]), noSpend, 10);
    const starved = describeFundingBlock(fundingFor(alloc, 'b')!, alloc);
    expect(starved).toContain('pool');
    expect(starved).toMatch(/move it up|pause/i);

    const capped = allocateTreasury(roster(['a', 10]), () => 10, 100);
    expect(describeFundingBlock(fundingFor(capped, 'a')!, capped)).toContain('budget');
  });

  it('counts the workers ahead of a starved one over the queue, not the roster', () => {
    // `paused` sits above `c` in the roster but claims nothing, so blaming the
    // empty pot on "2 workers ahead" would name a row that is not touching it.
    const alloc = allocateTreasury(roster(['a', 10], ['paused', 10, { enabled: false }], ['c', 10]), noSpend, 10);
    const starved = fundingFor(alloc, 'c')!;
    expect(starved.blocked).toBe('pool');
    expect(describeFundingBlock(starved, alloc)).toContain('1 worker ahead');
  });
});

describe('validateTreasury / seedTreasury', () => {
  it('rejects a pot of zero or less', () => {
    expect(validateTreasury(25)).toBeNull();
    expect(validateTreasury(0)).toBeTruthy();
    expect(validateTreasury(-5)).toBeTruthy();
    expect(validateTreasury(Number.NaN)).toBeTruthy();
  });

  it('seeds an upgrade with the sum of the caps it already had', () => {
    expect(seedTreasury([{ budgetUSDPerMonth: 10 }, { budgetUSDPerMonth: 25 }])).toEqual({
      monthlyUSD: 35,
    });
    expect(seedTreasury([])).toEqual({ monthlyUSD: DEFAULT_TREASURY_USD });
  });
});

describe('distributeRemainingFunds', () => {
  it('gives higher-priority workers more while preserving spend and paused caps', () => {
    const workers = roster(['a', 10], ['paused', 99, { enabled: false }], ['b', 20]);
    const allocation = allocateTreasury(workers, (id) => (id === 'a' ? 4 : id === 'b' ? 10 : 2), 30);
    expect(distributeRemainingFunds(allocation)).toEqual([
      { workerId: 'a', budgetUSDPerMonth: 13.33 },
      { workerId: 'b', budgetUSDPerMonth: 14.67 },
    ]);
  });

  it('uses weighted shares and remainder cents that total exactly', () => {
    const allocation = allocateTreasury(roster(['a', 1], ['b', 1], ['c', 1]), noSpend, 10);
    const caps = distributeRemainingFunds(allocation);
    expect(caps.map((cap) => cap.budgetUSDPerMonth)).toEqual([5, 3.33, 1.67]);
    expect(caps.reduce((sum, cap) => sum + cap.budgetUSDPerMonth, 0)).toBe(10);
  });
});
