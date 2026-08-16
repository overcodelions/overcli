import { describe, expect, it, vi } from 'vitest';

// The engine's default deps touch electron-backed stores at import time.
// Stub them; the harness injects in-memory replacements anyway.
vi.mock('./workersStore', () => ({
  saveWorker: vi.fn(),
  loadAllWorkers: vi.fn(() => []),
  deleteWorker: vi.fn(),
}));
vi.mock('./workerJournal', () => ({
  appendWorkerJournalEntry: vi.fn(() => true),
  loadWorkerJournal: vi.fn(() => []),
  workerRejectedTitles: vi.fn(() => []),
  digestWorkerJournal: vi.fn(() => ''),
}));
vi.mock('./runSummaryLog', () => ({
  workerSpendSince: vi.fn(() => 0),
}));

import { WorkerEngine, type WorkerParker } from './workerEngine';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';

function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

function makeHarness(opts: { seed?: Worker[]; startAt?: number; spend?: number } = {}) {
  let now = opts.startAt ?? local(2026, 3, 2, 8, 0);
  const parked: Array<Parameters<WorkerParker['parkProposal']>[0]> = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const emitted: any[] = [];
  const saved: Worker[] = [];
  const journal: WorkerJournalEntry[] = [];
  const orchestrations = new Map<string, Orchestration>();
  let spend = opts.spend ?? 0;
  let parkResult: Awaited<ReturnType<WorkerParker['parkProposal']>> = {
    ok: true,
    orchestrationId: 'orch-1',
    count: 3,
    queued: 0,
    excluded: 0,
  };

  let pending: { at: number; fn: () => void } | null = null;

  const parker: WorkerParker = {
    async parkProposal(args) {
      parked.push(args);
      return parkResult;
    },
    get: (id) => orchestrations.get(id) ?? null,
    list: () => [...orchestrations.values()],
  };

  const engine = new WorkerEngine({
    parker,
    isGitRepo: () => true,
    emit: (e) => emitted.push(e),
    notify: (n) => notifications.push(n),
    now: () => now,
    timers: {
      set: ((fn: () => void, ms: number) => {
        pending = { at: now + ms, fn };
        return pending as any;
      }) as any,
      clear: (() => {
        pending = null;
      }) as any,
    },
    store: {
      loadAll: () => opts.seed ?? [],
      save: (w) => saved.push(structuredClone(w)),
      remove: () => {},
    },
    journal: {
      append: (entry) => {
        if (journal.some((e) => e.id === entry.id)) return false;
        journal.push(structuredClone(entry));
        return true;
      },
      load: (workerId) =>
        journal.filter((e) => e.workerId === workerId).sort((a, b) => b.at - a.at),
      rejectedTitles: (workerId) => [
        ...new Set(
          journal
            .filter((e) => e.workerId === workerId && e.kind === 'rejected')
            .map((e) => e.title.trim().toLowerCase())
            .filter(Boolean),
        ),
      ],
      digest: (workerId) =>
        journal
          .filter((e) => e.workerId === workerId)
          .map((e) => `${e.kind}: ${e.title || e.note || ''}`)
          .join('\n'),
    },
    spend: () => spend,
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  async function advanceTo(t: number): Promise<void> {
    for (let guard = 0; guard < 5000; guard++) {
      if (!pending || pending.at > t) break;
      now = Math.max(now, pending.at);
      const fn = pending.fn;
      pending = null;
      fn();
      await flush();
    }
    now = Math.max(now, t);
  }

  return {
    engine,
    parked,
    notifications,
    emitted,
    saved,
    journal,
    orchestrations,
    advanceTo,
    flush,
    setNow: (t: number) => {
      now = t;
    },
    setSpend: (s: number) => {
      spend = s;
    },
    setParkResult: (r: typeof parkResult) => {
      parkResult = r;
    },
    hasTimer: () => pending !== null,
  };
}

function seedWorker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-1',
    name: 'Scout',
    jobDescription: 'Find the most valuable maintenance work and propose it.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 20,
    heartbeatModel: 'cheap-model',
    flowIds: ['fix-it'],
    enabled: true,
    createdAt: local(2026, 3, 2, 7, 0),
    ...over,
  };
}

function workerBatch(over: Partial<Orchestration> = {}): Orchestration {
  return {
    id: 'orch-1',
    title: '[Shift 1] Scout',
    projectPath: '/repo',
    maxConcurrent: 1,
    origin: { kind: 'worker', workerId: 'worker-1', workerName: 'Scout' },
    createdAt: local(2026, 3, 2, 9, 0),
    items: [],
    ...over,
  };
}

describe('WorkerEngine shifts', () => {
  it('fires a probation shift with no auto-approve and the journal exclusions', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.journal.push({
      id: 'r1',
      workerId: 'worker-1',
      kind: 'rejected',
      at: 1,
      title: 'Rewrite everything in Rust',
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    expect(h.parked).toHaveLength(1);
    const args = h.parked[0];
    expect(args.autoApprove).toBeUndefined();
    expect(args.excludeTitles).toEqual(['rewrite everything in rust']);
    expect(args.model).toBe('cheap-model');
    expect(args.maxItems).toBe(3);
    expect(args.origin).toEqual({ kind: 'worker', workerId: 'worker-1', workerName: 'Scout' });
    // The shift prompt is rebuilt from the persona, not a frozen string.
    expect(args.prompt).toContain('Scout');
    expect(args.prompt).toContain('Rewrite everything in Rust');
    // The shift landed in the journal.
    expect(h.journal.some((e) => e.kind === 'shift' && e.title === 'Shift 1')).toBe(true);
  });

  it('auto-approves up to the trust cap for a trusted worker', async () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    expect(h.parked[0].autoApprove).toEqual({ maxItems: 2 });
  });

  it('fires only once per occurrence and re-arms for the next day', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 12, 0));
    expect(h.parked).toHaveLength(1);
    await h.advanceTo(local(2026, 3, 3, 9, 0));
    expect(h.parked).toHaveLength(2);
  });

  it('skips shifts once the monthly budget is spent, journaling once a day', async () => {
    const h = makeHarness({ seed: [seedWorker({ budgetUSDPerMonth: 5 })], spend: 5 });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    expect(h.parked).toHaveLength(0);
    const budgetEntries = h.journal.filter((e) => e.note?.includes('budget'));
    expect(budgetEntries).toHaveLength(1);
    expect(h.notifications.some((n) => n.title.includes('out of budget'))).toBe(true);
  });

  it('refuses a manual shift when over budget instead of silently skipping', async () => {
    const h = makeHarness({ seed: [seedWorker({ budgetUSDPerMonth: 5 })], spend: 6 });
    h.engine.start();
    const res = await h.engine.workShiftNow('worker-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('budget');
  });

  it('journals a missed shift instead of replaying it after a long sleep', async () => {
    const h = makeHarness({ seed: [seedWorker()], startAt: local(2026, 3, 2, 8, 0) });
    h.engine.start();
    // Jump straight past the 9:00 occurrence by more than the grace window,
    // as a laptop shut overnight would.
    h.setNow(local(2026, 3, 2, 20, 0));
    await h.advanceTo(local(2026, 3, 2, 20, 0));

    expect(h.parked).toHaveLength(0);
    expect(h.journal.some((e) => e.note?.startsWith('Missed a shift'))).toBe(true);
  });
});

describe('WorkerEngine hiring and trust', () => {
  it('forces every new hire onto probation', () => {
    const h = makeHarness();
    h.engine.start();
    const res = h.engine.save({ ...seedWorker(), id: undefined, trust: 'autonomous' } as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.worker.trust).toBe('probation');
  });

  it('keeps existing trust across an edit', () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.engine.start();
    const res = h.engine.save({ ...seedWorker(), name: 'Scout II' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.worker.trust).toBe('trusted');
  });

  it('flips a cwd worker back to worktrees on demotion', () => {
    const h = makeHarness({
      seed: [seedWorker({ trust: 'autonomous', caps: { maxItemsPerShift: 3, runIn: 'cwd' } })],
    });
    h.engine.start();
    const res = h.engine.setTrust('worker-1', 'trusted');
    expect(res.ok).toBe(true);
    expect(h.engine.get('worker-1')?.caps.runIn).toBe('worktree');
  });
});

describe('WorkerEngine journal projection', () => {
  it('folds batch item statuses into journal kinds', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const o = workerBatch({
      items: [
        {
          candidate: { id: 'c1', title: 'Fix the flaky test', prompt: 'p1' },
          flowId: 'fix-it',
          status: 'proposed',
        },
        {
          candidate: { id: 'c2', title: 'Trim the bundle', prompt: 'p2' },
          flowId: 'fix-it',
          status: 'done',
          runId: 'run-9',
          finishedAt: 5,
        },
        {
          candidate: { id: 'c3', title: 'Rename the module', prompt: 'p3' },
          flowId: 'fix-it',
          status: 'cancelled',
          finishedAt: 6,
        },
      ],
    });
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });

    const kinds = (id: string) =>
      h.journal.filter((e) => e.id.includes(`:${id}:`)).map((e) => e.kind).sort();
    expect(kinds('c1')).toEqual(['proposed']);
    expect(kinds('c2')).toEqual(['approved', 'completed', 'launched', 'proposed']);
    expect(kinds('c3')).toEqual(['proposed', 'rejected']);
    // Rejected titles now feed the dedup filter.
    expect(
      h.journal.some((e) => e.kind === 'rejected' && e.title === 'Rename the module'),
    ).toBe(true);
  });

  it('is idempotent across repeated updates', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const o = workerBatch({
      items: [
        {
          candidate: { id: 'c1', title: 'Fix the flaky test', prompt: 'p1' },
          flowId: 'fix-it',
          status: 'done',
          runId: 'run-9',
        },
      ],
    });
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });
    const count = h.journal.length;
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });
    expect(h.journal.length).toBe(count);
  });

  it('does not journal a rejection for a cancellation of an already-accepted item', () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.engine.start();
    const item = {
      candidate: { id: 'c1', title: 'Trim the bundle', prompt: 'p' },
      flowId: 'fix-it',
    };
    // Auto-queued under the trust cap → journaled approved…
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({ items: [{ ...item, status: 'queued' }] }),
    });
    expect(h.journal.some((e) => e.kind === 'approved')).toBe(true);
    // …then settled to cancelled (app restart, or a batch abort). That is
    // not a verdict: no rejected entry, no title ban, no streak food.
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({ items: [{ ...item, status: 'cancelled', finishedAt: 9 }] }),
    });
    expect(h.journal.some((e) => e.kind === 'rejected')).toBe(false);
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
  });

  it('demotes after three consecutive rejections, exactly once', () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'autonomous' })] });
    h.engine.start();
    const items = ['a', 'b', 'c'].map((id) => ({
      candidate: { id, title: `Idea ${id}`, prompt: 'p' },
      flowId: 'fix-it',
      status: 'cancelled' as const,
      finishedAt: 5,
    }));
    const o = workerBatch({ items });
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });

    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
    expect(h.notifications.some((n) => n.title.includes('demoted'))).toBe(true);
    // Replaying the same batch does not demote again.
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
  });

  it('a demotion spends the streak — one more rejection does not demote again', () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'autonomous' })] });
    h.engine.start();
    const rejectedItems = (ids: string[], at: number) =>
      ids.map((id) => ({
        candidate: { id, title: `Idea ${id}`, prompt: 'p' },
        flowId: 'fix-it',
        status: 'cancelled' as const,
        finishedAt: at,
      }));
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({ id: 'orch-1', items: rejectedItems(['a', 'b', 'c'], 5) }),
    });
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
    // A fresh rejection AFTER the demotion starts a new streak of 1 — it
    // must take three more, not one, to fall to probation.
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({
        id: 'orch-2',
        createdAt: local(2026, 3, 3, 9, 0),
        items: rejectedItems(['d'], local(2026, 3, 3, 9, 5)),
      }),
    });
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
  });

  it('an approval resets the streak', () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.engine.start();
    const o = workerBatch({
      items: [
        {
          candidate: { id: 'a', title: 'Idea a', prompt: 'p' },
          flowId: 'fix-it',
          status: 'cancelled',
          finishedAt: 4,
        },
        {
          candidate: { id: 'b', title: 'Idea b', prompt: 'p' },
          flowId: 'fix-it',
          status: 'cancelled',
          finishedAt: 5,
        },
        {
          candidate: { id: 'c', title: 'Idea c', prompt: 'p' },
          flowId: 'fix-it',
          status: 'queued',
        },
      ],
    });
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: o });
    // Two rejections + one approval (newest, since sync stamps approvals at
    // `now`): no demotion.
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
  });
});
