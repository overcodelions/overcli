import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

vi.mock('../diagnostics', () => ({
  log: vi.fn(),
}));

import type { FlowRun } from '../../shared/flows/schema';

// Re-imported fresh per test (resetModules) so the module-level id cache
// doesn't bleed state between cases.
type Store = typeof import('./runSummaryLog');

async function freshStore(): Promise<Store> {
  vi.resetModules();
  return import('./runSummaryLog');
}

function makeRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    flowId: 'flow-1',
    flowSnapshot: { name: 'Review flow' },
    state: { kind: 'done', success: true },
    createdAt: 1,
    attempts: [
      { stepId: 's1', costUSD: 2, startedAt: 1, endedAt: 10 },
    ],
    ...overrides,
  } as unknown as FlowRun;
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-run-summaries-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('summarizeRun', () => {
  it('carries worker attribution into a terminal summary', async () => {
    const store = await freshStore();
    expect(
      store.summarizeRun(makeRun({ workerId: 'worker-1', workerName: 'Scout' })),
    ).toMatchObject({
      id: 'run-1',
      workerId: 'worker-1',
    });
  });
});

describe('summarizeRun · aborted runs', () => {
  it('summarizes an aborted run as not completed — its spend was real', async () => {
    const store = await freshStore();
    const summary = store.summarizeRun(
      makeRun({ state: { kind: 'aborted' }, workerId: 'w1' }),
    );
    expect(summary).toMatchObject({ id: 'run-1', completed: false, costUSD: 2, workerId: 'w1' });
  });

  it('counts aborted spend in the worker budget rollup', async () => {
    const store = await freshStore();
    store.appendRunSummary(
      makeRun({
        id: 'ok-run',
        workerId: 'w1',
        attempts: [{ stepId: 's', costUSD: 3, startedAt: 1, endedAt: 100 }] as never,
      }),
    );
    store.appendRunSummary(
      makeRun({
        id: 'dead-run',
        workerId: 'w1',
        state: { kind: 'aborted' },
        attempts: [{ stepId: 's', costUSD: 4, startedAt: 1, endedAt: 100 }] as never,
      }),
    );
    expect(store.workerSpendSince('w1', 0)).toBe(7);
  });
});

describe('workerSpendSince', () => {
  it('sums only the named worker’s runs at or after the cutoff', async () => {
    const store = await freshStore();
    // Two Scout runs in-window, one before the cutoff, one for another
    // worker, one untagged — only the first two may count.
    const runs: Array<[string, Partial<FlowRun>]> = [
      ['a', { workerId: 'w1', attempts: [{ stepId: 's', costUSD: 2, startedAt: 1, endedAt: 100 }] as never }],
      ['b', { workerId: 'w1', attempts: [{ stepId: 's', costUSD: 3, startedAt: 1, endedAt: 200 }] as never }],
      ['c', { workerId: 'w1', attempts: [{ stepId: 's', costUSD: 5, startedAt: 1, endedAt: 40 }] as never }],
      ['d', { workerId: 'w2', attempts: [{ stepId: 's', costUSD: 7, startedAt: 1, endedAt: 150 }] as never }],
      ['e', { attempts: [{ stepId: 's', costUSD: 11, startedAt: 1, endedAt: 150 }] as never }],
    ];
    for (const [id, over] of runs) store.appendRunSummary(makeRun({ id, ...over }));

    expect(store.workerSpendSince('w1', 50)).toBe(5);
    expect(store.workerSpendSince('w1', 0)).toBe(10);
    expect(store.workerSpendSince('w2', 0)).toBe(7);
    expect(store.workerSpendSince('missing', 0)).toBe(0);
  });
});
