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

import {
  WorkerEngine,
  parseFlowRequest,
  type WorkerEngineDeps,
  type WorkerParker,
} from './workerEngine';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';

function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

function makeHarness(
  opts: {
    seed?: Worker[];
    startAt?: number;
    spend?: number;
    generatedFlow?: WorkerEngineDeps['generatedFlow'];
  } = {},
) {
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
  let parkGate: Promise<void> | null = null;

  let pending: { at: number; fn: () => void } | null = null;

  const parker: WorkerParker = {
    async parkProposal(args) {
      parked.push(args);
      if (parkGate) await parkGate;
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
    generatedFlow: opts.generatedFlow,
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
    holdPark: () => {
      let release!: () => void;
      parkGate = new Promise<void>((resolve) => {
        release = () => {
          parkGate = null;
          resolve();
        };
      });
      return release;
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
    expect(args.origin).toEqual({
      kind: 'worker',
      workerId: 'worker-1',
      workerName: 'Scout',
      task: 'shift',
    });
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

describe('errand triage', () => {
  it('reads a flow request only when the block is present and non-empty', () => {
    expect(parseFlowRequest('prose only')).toBeNull();
    expect(parseFlowRequest('a <flow_request>  </flow_request> b')).toBeNull();
    expect(parseFlowRequest('why:\n<flow_request>\nRead CI logs, then summarize.\n</flow_request>')).toBe(
      'Read CI logs, then summarize.',
    );
  });
});

describe('WorkerEngine errands', () => {
  it('plans an errand through the job description and worker contract', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const instruction = 'the WOW-4921 spec is flaky on CI — find out why and fix it';
    const res = await h.engine.runErrand('worker-1', instruction);

    expect(res.ok).toBe(true);
    expect(h.parked).toHaveLength(1);
    expect(h.parked[0]).toMatchObject({
      title: `[Errand] ${instruction}`,
      origin: { kind: 'worker', workerId: 'worker-1', workerName: 'Scout' },
      allowedFlowIds: ['fix-it'],
      runIn: 'worktree',
      maxItems: 3,
    });
    expect(h.parked[0].prompt).toContain('Find the most valuable maintenance work');
    expect(h.parked[0].prompt).toContain('THE ERRAND');
    expect(h.parked[0].prompt).toContain(instruction);
    // All three triage paths are offered, and the refusal clause survives.
    expect(h.parked[0].prompt).toContain('ANSWER IT NOW');
    expect(h.parked[0].prompt).toContain('USE YOUR EXISTING FLOWS');
    expect(h.parked[0].prompt).toContain('<flow_request>');
    expect(h.parked[0].prompt).toContain('outside your job description');
  });

  it('uses only the first errand line as the batch and journal title', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'Repair CI spec\nThen update the release note.');

    expect(h.parked[0].title).toBe('[Errand] Repair CI spec');
    expect(h.journal.find((entry) => entry.kind === 'errand')?.title).toBe('Repair CI spec');
  });

  it('honours trust, rejections, and leaves cadence bookkeeping untouched', async () => {
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.journal.push({
      id: 'rejected',
      workerId: 'worker-1',
      kind: 'rejected',
      at: 1,
      title: 'Do not repeat this',
    });
    h.engine.start();
    const savedBefore = h.saved.length;
    await h.engine.runErrand('worker-1', 'Investigate the failed spec.');
    expect(h.parked[0].autoApprove).toEqual({ maxItems: 2 });
    expect(h.parked[0].excludeTitles).toEqual(['do not repeat this']);
    expect(h.parked[0].prompt).toContain('Do not repeat this');
    expect(h.saved).toHaveLength(savedBefore);
    expect(h.engine.get('worker-1')?.shiftCount).toBeUndefined();
    expect(h.engine.get('worker-1')?.lastShiftAt).toBeUndefined();
  });

  it('honours an autonomous worker’s working-copy execution setting', async () => {
    const h = makeHarness({
      seed: [seedWorker({ trust: 'autonomous', caps: { maxItemsPerShift: 3, runIn: 'cwd' } })],
    });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'Repair the flaky CI spec.');

    expect(h.parked[0].runIn).toBe('cwd');
  });

  it('returns and journals a no-launch reply without labeling it a refusal', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0 });
    h.orchestrations.set(
      'orch-1',
      workerBatch({
        producer: {
          prompt: 'x',
          reply: "That's outside my job description. <candidates>[]</candidates>",
        },
      }),
    );
    h.engine.start();
    const res = await h.engine.runErrand('worker-1', 'Redesign the marketing homepage.');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.launchedNothing).toBe(true);
      expect(res.result.reply).toContain("That's outside my job description.");
      expect(res.result.reply).not.toContain('<candidates>');
    }
    const entry = h.journal.find((item) => item.kind === 'errand');
    expect(entry?.note).toMatch(/^Nothing launched — That's outside my job description/);
  });

  it('journals a completed errand and collision-proofs two errands on one clock', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 3, queued: 1, excluded: 0 });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'Check the flaky test.');
    await h.engine.runErrand('worker-1', 'Check the other flaky test.');
    const entries = h.journal.filter((entry) => entry.kind === 'errand');
    expect(entries).toHaveLength(2);
    expect(entries[0].note).toBe('3 proposed — 1 launched, 2 waiting for approval.');
  });

  it('refuses over-budget, empty, unknown, and concurrent errands', async () => {
    const budget = makeHarness({ seed: [seedWorker()], spend: 999 });
    budget.engine.start();
    await expect(budget.engine.runErrand('worker-1', 'do a thing')).resolves.toMatchObject({ ok: false });
    expect(budget.parked).toHaveLength(0);
    expect(budget.journal).toHaveLength(0);
    await expect(budget.engine.runErrand('worker-1', '   ')).resolves.toMatchObject({ ok: false });
    await expect(budget.engine.runErrand('missing', 'do a thing')).resolves.toEqual({
      ok: false,
      error: 'Worker not found.',
    });

    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const release = h.holdPark();
    void h.engine.workShiftNow('worker-1');
    await h.flush();

    // An errand sent mid-shift WAITS rather than bouncing. Refusing it meant
    // the moment you could see the worker working was the one moment you
    // couldn't hand it anything.
    const errand = h.engine.runErrand('worker-1', 'do a thing');
    await h.flush();
    expect(h.parked).toHaveLength(1); // still behind the shift's planning turn

    release();
    await expect(errand).resolves.toMatchObject({ ok: true });
    expect(h.parked).toHaveLength(2);
    expect(h.parked[1].title).toBe('[Errand] do a thing');
  });

  it('runs queued errands in the order they were sent', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const release = h.holdPark();
    void h.engine.workShiftNow('worker-1');
    await h.flush();

    const first = h.engine.runErrand('worker-1', 'first');
    const second = h.engine.runErrand('worker-1', 'second');
    release();
    await Promise.all([first, second]);

    expect(h.parked.map((p) => p.title)).toEqual([
      '[Shift 1] Scout',
      '[Errand] first',
      '[Errand] second',
    ]);
  });

  it('keeps the queue moving when an errand fails', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    // An empty instruction is rejected before it ever reaches the queue, so
    // use the one failure that happens inside it: a park that returns not-ok.
    h.setParkResult({ ok: false, error: 'planner exploded' });
    await expect(h.engine.runErrand('worker-1', 'first')).resolves.toMatchObject({ ok: false });

    h.setParkResult({ ok: true, orchestrationId: 'o-2', count: 1, queued: 1, excluded: 0 });
    await expect(h.engine.runErrand('worker-1', 'second')).resolves.toMatchObject({ ok: true });
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
  it('folds an errand batch into the same proposal and run scorecard entries', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({
        title: '[Errand] Repair the flaky spec',
        items: [
          {
            candidate: { id: 'c1', title: 'Repair CI spec', prompt: 'p' },
            flowId: 'fix-it',
            status: 'done',
            runId: 'run-1',
            finishedAt: 10,
          },
        ],
      }),
    });
    expect(h.journal.filter((entry) => entry.title === 'Repair CI spec').map((entry) => entry.kind).sort()).toEqual([
      'approved',
      'completed',
      'launched',
      'proposed',
    ]);
  });

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

describe('WorkerEngine generated flows', () => {
  function replyRequesting(request: string): Orchestration {
    return workerBatch({
      producer: { prompt: 'p', reply: `This needs digging.\n<flow_request>\n${request}\n</flow_request>` },
      items: [],
    });
  }

  it('drafts and launches a flow when the worker asks for one', async () => {
    const calls: Array<{ request: string; errand: string; runIn: string }> = [];
    const h = makeHarness({
      seed: [seedWorker()],
      generatedFlow: async (args) => {
        calls.push({ request: args.request, errand: args.errand, runIn: args.runIn });
        return { ok: true, orchestrationId: 'orch-gen', flowId: 'generated-abcd1234' };
      },
    });
    h.engine.start();
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0 });
    h.orchestrations.set('orch-1', replyRequesting('Read the CI logs and correlate.'));

    const res = await h.engine.runErrand('worker-1', 'why did CI get slower this month');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toBe('Read the CI logs and correlate.');
    expect(calls[0].runIn).toBe('worktree');
    // Reported as work launched, not as an empty errand.
    expect(res.ok && res.result).toMatchObject({
      orchestrationId: 'orch-gen',
      launchedNothing: false,
    });
    const entry = h.journal.find((e) => e.kind === 'errand');
    expect(entry?.note).toContain('generated-abcd1234');
    expect(entry?.orchestrationId).toBe('orch-gen');
  });

  it('ignores a flow request when the turn also proposed candidates', async () => {
    let called = 0;
    const h = makeHarness({
      seed: [seedWorker()],
      generatedFlow: async () => {
        called++;
        return { ok: true, orchestrationId: 'orch-gen', flowId: 'f' };
      },
    });
    h.engine.start();
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 2, queued: 0, excluded: 0 });
    h.orchestrations.set('orch-1', replyRequesting('build me one'));
    await h.engine.runErrand('worker-1', 'do the thing');
    // A turn that proposed work AND asked for machinery is confused; the
    // candidates it produced are the safer half to act on.
    expect(called).toBe(0);
  });

  it('reports a drafting failure instead of downgrading to an empty errand', async () => {
    const h = makeHarness({
      seed: [seedWorker()],
      generatedFlow: async () => ({ ok: false, error: 'drafter offline' }),
    });
    h.engine.start();
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0 });
    h.orchestrations.set('orch-1', replyRequesting('investigate'));
    const res = await h.engine.runErrand('worker-1', 'big ask');
    expect(res).toEqual({ ok: false, error: 'drafter offline' });
    expect(h.journal.find((e) => e.kind === 'errand')?.note).toContain('drafter offline');
  });
});

describe('WorkerEngine errand threads', () => {
  it('replays the whole errand thread, oldest first, so follow-ups land', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    // Two settled errands already on the books, newest last by createdAt.
    for (const [id, ask, reply, at] of [
      ['e1', 'which spec is flaky', 'WOW-4921 is.', 10],
      ['e2', 'why', 'A race in the fixture.', 20],
    ] as const) {
      h.orchestrations.set(
        id,
        workerBatch({
          id,
          createdAt: at,
          title: `[Errand] ${ask}`,
          origin: {
            kind: 'worker',
            workerId: 'worker-1',
            workerName: 'Scout',
            task: 'errand',
            errand: ask,
          },
          producer: { prompt: 'assembled planning prompt', reply },
          items: [],
        }),
      );
    }

    await h.engine.runErrand('worker-1', 'fix it then');
    const turns = h.parked[0].priorTurns;
    expect(turns).toEqual([
      { prompt: 'which spec is flaky', reply: 'WOW-4921 is.' },
      { prompt: 'why', reply: 'A race in the fixture.' },
    ]);
  });

  it('carries no thread on the first errand, and ignores shifts', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    // A worked shift is not something the user said, so it is not a turn.
    h.orchestrations.set(
      's1',
      workerBatch({ id: 's1', producer: { prompt: 'p', reply: 'shift prose' }, items: [] }),
    );
    await h.engine.runErrand('worker-1', 'first thing i have asked');
    expect(h.parked[0].priorTurns).toBeUndefined();
  });
});
