// The boot rules, tested directly. `loadAllOrchestrations` around them is
// electron paths and fs — which is exactly why these three rules had no
// coverage until an item that could never be continued sat in the Workers
// work queue for a week asking to be dealt with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module reaches for electron's `app.getPath` at import time via its
// helpers; nothing under test calls them, but the import has to resolve.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/overcli-test' } }));
vi.mock('../diagnostics', () => ({ log: () => {} }));

// The pruned-batch log lives in the data dir; point it at a scratch folder.
const dataDir = vi.hoisted(() => ({ current: '' }));
vi.mock('../host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../host')>()),
  host: () => ({ dataDir: () => dataDir.current }),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendPrunedBatches, loadPrunedBatches, prunePlan, prunedRecord, settleItemOnLoad } from './orchestrationsStore';
import type { PrunedWorkerBatch } from '../../shared/flows/workerReport';
import type { Orchestration } from '../../shared/flows/orchestration';

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
  it('dates a settled item from the work, not from the launch that noticed', () => {
    // The batch is a week old. Stamping boot time on it would file last
    // Tuesday's abandoned job at the top of today's finished list, and count
    // it in "finished today".
    const WEEK_AGO = NOW - 7 * 24 * 3_600_000;
    const started = item({ status: 'paused', runId: 'r1', startedAt: WEEK_AGO + 60_000 });
    settleItemOnLoad(started, GONE, WEEK_AGO);
    expect(started.finishedAt).toBe(WEEK_AGO + 60_000);

    // Nothing ever started it, so the batch's own age is the best answer.
    const never = item({ status: 'queued' });
    settleItemOnLoad(never, GONE, WEEK_AGO);
    expect(never.finishedAt).toBe(WEEK_AGO);
  });

  it('parks a running item whose run survived, so it finishes with its run', () => {
    const it_ = item({ status: 'running', runId: 'r1' });
    expect(settleItemOnLoad(it_, ALIVE, NOW)).toBe(true);
    expect(it_.status).toBe('paused');
    expect(it_.finishedAt).toBeUndefined();
  });

  it('fails a running item whose run is gone — nothing will finish it', () => {
    const it_ = item({ status: 'running', runId: 'r1' });
    expect(settleItemOnLoad(it_, GONE, NOW)).toBe(true);
    expect(it_.status).toBe('failed');
    expect(it_.note).toBe('Interrupted by app restart.');
    expect(it_.finishedAt).toBe(NOW);
  });

  it('cancels a queued item rather than spending tokens with nobody present', () => {
    const it_ = item({ status: 'queued' });
    expect(settleItemOnLoad(it_, ALIVE, NOW)).toBe(true);
    expect(it_.status).toBe('cancelled');
  });

  it('keeps a paused batch\'s queue — nothing launches until Resume', () => {
    const it_ = item({ status: 'queued' });
    expect(settleItemOnLoad(it_, ALIVE, NOW, true)).toBe(false);
    expect(it_.status).toBe('queued');
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

describe('prunePlan', () => {
  const batch = (id: string, over: Partial<Orchestration> = {}): Orchestration =>
    ({ id, title: id, projectPath: '/p', maxConcurrent: 1, createdAt: 0, items: [item({ status: 'done' })], origin: { kind: 'worker', workerId: 'w', workerName: 'W' }, ...over }) as Orchestration;

  it('evicts a desk turn that proposed nothing, not only stamped batches, so they cannot hold the cap', () => {
    const all = [
      batch('new', { completedAt: 1 }),
      batch('empty', { items: [] }),
      batch('open', { items: [item({ status: 'proposed' })] }),
      batch('old', { completedAt: 1 }),
    ];
    const { kept, gone } = prunePlan(all, 1);
    expect(kept.map((o) => o.id)).toEqual(['new', 'open']);
    expect(gone.map((o) => o.id)).toEqual(['empty', 'old']);
  });

  it('logs a worker batch with work in it, and nothing else', () => {
    expect(prunedRecord(batch('b', { createdAt: 5, items: [item({ status: 'done', finishedAt: 9 }), item({ status: 'failed' })] }))).toEqual({
      id: 'b', workerId: 'w', createdAt: 5, items: [{ status: 'done', finishedAt: 9 }, { status: 'failed' }],
    });
    expect(prunedRecord(batch('e', { items: [] }))).toBeNull();
    expect(prunedRecord(batch('s', { origin: undefined }))).toBeNull();
  });
});

describe('the pruned batch log', () => {
  const rec = (id: string, status: 'done' | 'failed' = 'done'): PrunedWorkerBatch => ({ id, workerId: 'w', createdAt: 1, items: [{ status }] });
  const file = () => path.join(dataDir.current, 'worker-batches.jsonl');

  beforeEach(() => {
    dataDir.current = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-pruned-'));
  });
  afterEach(() => {
    fs.rmSync(dataDir.current, { recursive: true, force: true });
  });

  it('reads the file once, then folds its own appends in without reading again', () => {
    appendPrunedBatches([rec('a')]);
    expect(loadPrunedBatches().map((r) => r.id)).toEqual(['a']);
    const read = vi.spyOn(fs, 'readFileSync');
    appendPrunedBatches([rec('b'), rec('a', 'failed')]);
    const all = loadPrunedBatches();
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(all.find((r) => r.id === 'a')?.items[0].status).toBe('failed');
  });

  it('notices the file changing underneath it', () => {
    appendPrunedBatches([rec('a')]);
    expect(loadPrunedBatches()).toHaveLength(1);
    fs.appendFileSync(file(), JSON.stringify(rec('outside')) + '\n');
    expect(loadPrunedBatches().map((r) => r.id).sort()).toEqual(['a', 'outside']);
    fs.rmSync(file());
    expect(loadPrunedBatches()).toEqual([]);
  });

  it('compacts a log full of repeated ids down to one line each, keeping the last', () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) lines.push(JSON.stringify(rec(`b${i % 3}`, i === 299 ? 'failed' : 'done')));
    fs.writeFileSync(file(), lines.join('\n') + '\n');
    const all = loadPrunedBatches();
    expect(all).toHaveLength(3);
    expect(fs.readFileSync(file(), 'utf8').trim().split('\n')).toHaveLength(3);
    expect(all.find((r) => r.id === 'b2')?.items[0].status).toBe('failed');
    // Still served from cache, and still right after another append.
    appendPrunedBatches([rec('b3')]);
    expect(loadPrunedBatches()).toHaveLength(4);
  });
});
