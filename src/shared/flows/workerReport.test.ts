import { describe, expect, it } from 'vitest';
import { buildWorkerReport, type WorkerRunFact } from './workerReport';
import type { Orchestration, OrchestrationItem } from './orchestration';
import type { Worker, WorkerJournalEntry } from './worker';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-1',
    name: 'Scout',
    jobDescription: 'Review incoming work and prioritize useful maintenance.',
    projectPath: '/tmp/project',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'autonomous',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 10,
    heartbeatModel: 'gpt-5',
    flowIds: ['flow-1'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function makeItem(overrides: Partial<OrchestrationItem> = {}): OrchestrationItem {
  return {
    candidate: { id: 'c1', title: 'Do a thing', prompt: 'Do a thing' },
    flowId: 'flow-1',
    status: 'done',
    ...overrides,
  };
}

function makeBatch(overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'batch-1',
    title: 'Shift batch',
    projectPath: '/tmp/project',
    maxConcurrent: 1,
    items: [],
    createdAt: 1,
    origin: { kind: 'worker', workerId: 'worker-1', workerName: 'Scout', task: 'shift' },
    ...overrides,
  };
}

function makeShiftEntry(overrides: Partial<WorkerJournalEntry> = {}): WorkerJournalEntry {
  return {
    id: 'entry-1',
    workerId: 'worker-1',
    kind: 'shift',
    at: 1000,
    title: 'Shift 1',
    ...overrides,
  };
}

function report(args: {
  workers: Worker[];
  journalByWorker: Record<string, WorkerJournalEntry[]>;
  orchestrations?: Orchestration[];
  runs?: WorkerRunFact[];
  sinceMs?: number;
}) {
  return buildWorkerReport({
    workers: args.workers,
    journal: (id) => args.journalByWorker[id] ?? [],
    orchestrations: args.orchestrations ?? [],
    runs: args.runs ?? [],
    sinceMs: args.sinceMs ?? 0,
    generatedAt: 5000,
  });
}

describe('buildWorkerReport', () => {
  it('counts a title-less shift entry as skipped, not worked', () => {
    const r = report({
      workers: [makeWorker()],
      journalByWorker: {
        'worker-1': [makeShiftEntry({ title: '' })],
      },
    });
    expect(r.byWorker[0].skippedShifts).toBe(1);
    expect(r.byWorker[0].shifts).toBe(0);
  });

  it('counts a shift whose note starts with "Failed: " as a failed shift', () => {
    const r = report({
      workers: [makeWorker()],
      journalByWorker: {
        'worker-1': [makeShiftEntry({ note: 'Failed: producer turn errored' })],
      },
    });
    expect(r.byWorker[0].shifts).toBe(1);
    expect(r.byWorker[0].failedShifts).toBe(1);
  });

  it('counts a shift with a zero-item batch as quiet, and a two-item batch as working', () => {
    const quietBatch = makeBatch({ id: 'batch-quiet', items: [] });
    const workingBatch = makeBatch({
      id: 'batch-working',
      items: [makeItem(), makeItem({ candidate: { id: 'c2', title: 'Another', prompt: 'x' } })],
    });
    const r = report({
      workers: [makeWorker()],
      journalByWorker: {
        'worker-1': [
          makeShiftEntry({ id: 'e-quiet', orchestrationId: 'batch-quiet' }),
          makeShiftEntry({ id: 'e-working', orchestrationId: 'batch-working' }),
        ],
      },
      orchestrations: [quietBatch, workingBatch],
    });
    expect(r.byWorker[0].quietShifts).toBe(1);
    expect(r.byWorker[0].workingShifts).toBe(1);
  });

  it('counts rejected journal entries and done items separately', () => {
    const batch = makeBatch({
      items: [makeItem({ status: 'done' }), makeItem({ status: 'done' })],
    });
    const r = report({
      workers: [makeWorker()],
      journalByWorker: {
        'worker-1': [
          { id: 'r1', workerId: 'worker-1', kind: 'rejected', at: 1000, title: 'Rejected thing' },
        ],
      },
      orchestrations: [batch],
    });
    expect(r.byWorker[0].rejected).toBe(1);
    expect(r.byWorker[0].itemsDone).toBe(2);
  });

  it('dates an item by when it finished, not by when its batch opened', () => {
    // The batch predates the window; the work landed inside it. Its run is
    // counted in the window (runs window on terminalAt), so the item has to
    // be too — otherwise the window shows cost against zero jobs done.
    const batch = makeBatch({
      createdAt: 100,
      items: [makeItem({ status: 'done', finishedAt: 2000 })],
    });
    const r = report({
      workers: [makeWorker()],
      journalByWorker: { 'worker-1': [] },
      orchestrations: [batch],
      sinceMs: 1000,
    });
    expect(r.byWorker[0].itemsDone).toBe(1);
  });

  it('excludes an unfinished item whose batch opened before the window', () => {
    const batch = makeBatch({
      createdAt: 100,
      items: [makeItem({ status: 'done' })],
    });
    const r = report({
      workers: [makeWorker()],
      journalByWorker: { 'worker-1': [] },
      orchestrations: [batch],
      sinceMs: 1000,
    });
    expect(r.byWorker[0].itemsDone).toBe(0);
  });

  it('sums runs into tokens/cost/time, excluding stale or mismatched-worker runs', () => {
    const runs: WorkerRunFact[] = [
      {
        workerId: 'worker-1',
        completed: true,
        turns: 2,
        inputTokens: 100,
        outputTokens: 50,
        costUSD: 1.5,
        wallClockMs: 60_000,
        terminalAt: 2000,
      },
      // Excluded: before sinceMs.
      {
        workerId: 'worker-1',
        completed: true,
        turns: 1,
        inputTokens: 999,
        outputTokens: 999,
        costUSD: 99,
        wallClockMs: 999_000,
        terminalAt: 500,
      },
      // Excluded: different worker.
      {
        workerId: 'worker-2',
        completed: true,
        turns: 1,
        inputTokens: 999,
        outputTokens: 999,
        costUSD: 99,
        wallClockMs: 999_000,
        terminalAt: 3000,
      },
    ];
    const r = report({
      workers: [makeWorker()],
      journalByWorker: { 'worker-1': [] },
      runs,
      sinceMs: 1000,
    });
    expect(r.byWorker[0].inputTokens).toBe(100);
    expect(r.byWorker[0].outputTokens).toBe(50);
    expect(r.byWorker[0].costUSD).toBe(1.5);
    expect(r.byWorker[0].workedMs).toBe(60_000);
    expect(r.byWorker[0].savedMinutes).toBe(1.5);
  });

  it('sums totals across two workers', () => {
    const workerA = makeWorker({ id: 'worker-a', name: 'A' });
    const workerB = makeWorker({ id: 'worker-b', name: 'B' });
    const r = report({
      workers: [workerA, workerB],
      journalByWorker: {
        'worker-a': [makeShiftEntry({ workerId: 'worker-a' })],
        'worker-b': [
          makeShiftEntry({ workerId: 'worker-b' }),
          makeShiftEntry({ workerId: 'worker-b', id: 'entry-2' }),
        ],
      },
    });
    const sum = r.byWorker.reduce((n, row) => n + row.shifts, 0);
    expect(r.totals.shifts).toBe(sum);
    expect(r.totals.shifts).toBe(3);
  });
});

describe('buildWorkerReport · daily buckets', () => {
  // Local noon on a fixed day, so the axis is deterministic wherever this runs.
  const NOW = new Date(2026, 7, 20, 12, 0, 0).getTime();
  const DAY = 86_400_000;
  const noonDaysAgo = (n: number) => new Date(2026, 7, 20 - n, 12, 0, 0).getTime();

  function daily(args: {
    journal?: WorkerJournalEntry[];
    orchestrations?: Orchestration[];
    runs?: WorkerRunFact[];
    sinceMs: number;
  }) {
    return buildWorkerReport({
      workers: [makeWorker()],
      journal: () => args.journal ?? [],
      orchestrations: args.orchestrations ?? [],
      runs: args.runs ?? [],
      sinceMs: args.sinceMs,
      generatedAt: NOW,
    });
  }

  it('gap-fills every day of a fixed window, including the empty ones', () => {
    const r = daily({
      journal: [makeShiftEntry({ at: noonDaysAgo(2) })],
      sinceMs: NOW - 2 * DAY,
    });
    expect(r.daily.map((d) => d.day)).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    expect(r.daily.map((d) => d.shifts)).toEqual([1, 0, 0]);
  });

  it('puts each measure on the day it landed', () => {
    const r = daily({
      journal: [makeShiftEntry({ at: noonDaysAgo(1) })],
      orchestrations: [
        makeBatch({ items: [makeItem({ status: 'done', finishedAt: noonDaysAgo(0) })] }),
      ],
      runs: [
        {
          workerId: 'worker-1',
          completed: true,
          turns: 1,
          inputTokens: 60,
          outputTokens: 40,
          costUSD: 2.5,
          wallClockMs: 90_000,
          terminalAt: noonDaysAgo(0),
        },
      ],
      sinceMs: NOW - 1 * DAY,
    });
    const [yesterday, today] = r.daily;
    expect(yesterday.shifts).toBe(1);
    expect(yesterday.itemsDone).toBe(0);
    expect(today.itemsDone).toBe(1);
    expect(today.costUSD).toBe(2.5);
    expect(today.tokens).toBe(100);
    expect(today.workedMs).toBe(90_000);
  });

  it('gives every worker the same axis, and sums the roster series off it', () => {
    const r = buildWorkerReport({
      workers: [makeWorker(), makeWorker({ id: 'worker-2', name: 'Other' })],
      journal: (id) =>
        id === 'worker-1'
          ? [makeShiftEntry({ at: noonDaysAgo(1) })]
          : [makeShiftEntry({ workerId: 'worker-2', at: noonDaysAgo(1) })],
      orchestrations: [],
      runs: [],
      sinceMs: NOW - 2 * DAY,
      generatedAt: NOW,
    });
    for (const row of r.byWorker) {
      expect(row.daily.map((d) => d.day)).toEqual(r.daily.map((d) => d.day));
    }
    expect(r.daily.map((d) => d.shifts)).toEqual([0, 2, 0]);
  });

  it('starts an all-time axis at the first thing that ever happened', () => {
    const r = daily({
      journal: [makeShiftEntry({ at: noonDaysAgo(3) })],
      sinceMs: 0,
    });
    expect(r.daily[0].day).toBe('2026-08-17');
    expect(r.daily).toHaveLength(4);
  });
});
