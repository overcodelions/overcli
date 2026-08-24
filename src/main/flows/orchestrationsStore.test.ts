// The boot rules, tested directly. `loadAllOrchestrations` around them is
// electron paths and fs — which is exactly why these three rules had no
// coverage until an item that could never be continued sat in the Workers
// work queue for a week asking to be dealt with.

import { describe, expect, it, vi } from 'vitest';

// The module reaches for electron's `app.getPath` at import time via its
// helpers; nothing under test calls them, but the import has to resolve.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/overcli-test' } }));
vi.mock('../diagnostics', () => ({ log: () => {} }));

import { settleItemOnLoad } from './orchestrationsStore';

import type { OrchestrationItem } from '../../shared/flows/orchestration';

const NOW = 1_000_000;
const ALIVE = () => true;
const GONE = () => false;

function item(overrides: Partial<OrchestrationItem> = {}): OrchestrationItem {
  return {
    candidate: { id: 'c1', title: 'Fix the flaky spec', prompt: 'p' },
    flowId: 'flow',
    status: 'running',
    ...overrides,
  } as OrchestrationItem;
}

describe('settleItemOnLoad', () => {
  it('fails a running item — its subprocess died with the app', () => {
    const it_ = item({ status: 'running' });
    expect(settleItemOnLoad(it_, ALIVE, NOW)).toBe(true);
    expect(it_.status).toBe('failed');
    expect(it_.note).toBe('Interrupted by app restart.');
    expect(it_.finishedAt).toBe(NOW);
  });

  it('cancels a queued item rather than spending tokens with nobody present', () => {
    const it_ = item({ status: 'queued' });
    expect(settleItemOnLoad(it_, ALIVE, NOW)).toBe(true);
    expect(it_.status).toBe('cancelled');
  });

  it('marks the restart-cancelled item so the journal cannot read it as a rejection', () => {
    const it_ = item({ status: 'queued' });
    settleItemOnLoad(it_, ALIVE, NOW);
    expect(it_.settledByRestart).toBe(true);
  });

  it('never marks a cancellation a person made', () => {
    // Only the boot path sets it. A user declining work leaves it unset, and
    // that cancellation still counts toward the worker's streak.
    const it_ = item({ status: 'cancelled' });
    settleItemOnLoad(it_, ALIVE, NOW);
    expect(it_.settledByRestart).toBeUndefined();
  });

  it('leaves a paused item alone while its run is still there to continue', () => {
    const it_ = item({ status: 'paused', runId: 'r1' });
    expect(settleItemOnLoad(it_, ALIVE, NOW)).toBe(false);
    expect(it_.status).toBe('paused');
  });

  it('settles a paused item whose run has been deleted', () => {
    const it_ = item({ status: 'paused', runId: 'r1' });
    expect(settleItemOnLoad(it_, GONE, NOW)).toBe(true);
    expect(it_.status).toBe('failed');
    expect(it_.note).toBe('Run no longer exists.');
  });

  it('settles it to failed and NOT cancelled — losing a run file is not a rejection', () => {
    // `cancelled` is journaled as a rejection and feeds the worker's demotion
    // streak. A worker must not lose trust because the app dropped a file.
    const it_ = item({ status: 'paused', runId: 'r1' });
    settleItemOnLoad(it_, GONE, NOW);
    expect(it_.status).not.toBe('cancelled');
  });

  it('never re-stamps an item that already carries its own note and time', () => {
    const it_ = item({ status: 'running', note: 'Reviewer rejected it.', finishedAt: 42 });
    settleItemOnLoad(it_, ALIVE, NOW);
    expect(it_.note).toBe('Reviewer rejected it.');
    expect(it_.finishedAt).toBe(42);
  });

  it('leaves terminal and proposed items untouched', () => {
    // A schedule can park a proposal at 8am for an afternoon the user is not
    // there for; settling it on boot throws away the point of scheduling it.
    for (const status of ['done', 'failed', 'cancelled', 'proposed'] as const) {
      const it_ = item({ status });
      expect(settleItemOnLoad(it_, GONE, NOW)).toBe(false);
      expect(it_.status).toBe(status);
    }
  });
});
