import { describe, expect, it, vi } from 'vitest';

// The engine's default deps touch electron-backed stores at import time.
// Stub them; the harness injects in-memory replacements anyway.
vi.mock('./workersStore', () => ({
  saveWorker: vi.fn(),
  loadAllWorkers: vi.fn(() => []),
  deleteWorker: vi.fn(),
  loadTreasury: vi.fn(() => null),
  saveTreasury: vi.fn(),
}));
vi.mock('./workerJournal', () => ({
  appendWorkerJournalEntry: vi.fn(() => true),
  loadWorkerJournal: vi.fn(() => []),
  workerRejectedTitles: vi.fn(() => []),
  digestWorkerJournal: vi.fn(() => ''),
  clearWorkerJournal: vi.fn(() => 0),
}));
vi.mock('./runSummaryLog', () => ({
  workerSpendSince: vi.fn(() => 0),
  workerSpendByWorkerSince: vi.fn(() => new Map<string, number>()),
}));
// Partial: only the archiving call is stubbed, so the weekly pass is
// observable without touching the disk. `archiveWorkerFiles` has its own
// tests; what is unproven here is that the engine calls it at all.
const { archiveMock } = vi.hoisted(() => ({ archiveMock: vi.fn(() => ({ moved: 0 })) }));
vi.mock('./workerFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerFiles')>()),
  archiveWorkerFiles: archiveMock,
}));

import {
  WorkerEngine,
  parseFlowRequest,
  type WorkerEngineDeps,
  type WorkerParker,
} from './workerEngine';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import type { Treasury } from '../../shared/flows/treasury';
import { compactionCutoff } from '../../shared/flows/workerCompaction';

function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

function makeHarness(
  opts: {
    seed?: Worker[];
    startAt?: number;
    spend?: number;
    /// The monthly pool. Left unset, the engine seeds it from the sum of the
    /// seeded workers' caps — the same migration a real install gets, so a
    /// test that says nothing about funding behaves as it did before there
    /// was a treasury.
    pool?: number;
    generatedFlow?: WorkerEngineDeps['generatedFlow'];
    clearActivity?: WorkerEngineDeps['clearActivity'];
    journalClear?: (workerId: string) => number;
    supervisorTurn?: WorkerEngineDeps['supervisorTurn'];
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
  let treasury: Treasury | null = opts.pool != null ? { monthlyUSD: opts.pool } : null;
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
      clear: (workerId) => {
        if (opts.journalClear) return opts.journalClear(workerId);
        const before = journal.length;
        for (let i = journal.length - 1; i >= 0; i--) {
          if (journal[i].workerId === workerId) journal.splice(i, 1);
        }
        return before - journal.length;
      },
    },
    spend: () => spend,
    // The harness models one spend figure for everybody; the engine wants it
    // per worker, for every id it might ask about — seeded or hired mid-test.
    spendAll: () =>
      new Map(
        [...new Set([...(opts.seed ?? []).map((w) => w.id), ...saved.map((w) => w.id)])].map(
          (id) => [id, spend] as const,
        ),
      ),
    treasuryStore: {
      load: () => treasury,
      save: (t) => {
        treasury = t;
      },
    },
    generatedFlow: opts.generatedFlow,
    clearActivity: opts.clearActivity,
    supervisorTurn: opts.supervisorTurn,
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
    treasury: () => treasury,
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

describe('WorkerEngine flow supervision', () => {
  it('answers a child flow as the standing persona with journal context', async () => {
    let prompt = '';
    const h = makeHarness({
      seed: [seedWorker()],
      supervisorTurn: async (args) => {
        prompt = args.prompt;
        return { ok: true, text: '<worker_answer>Use Unknown.</worker_answer>' };
      },
    });
    h.journal.push({
      id: 'note-1',
      workerId: 'worker-1',
      kind: 'shift',
      at: 1,
      title: 'Prior decision',
      note: 'Prefer explicit labels.',
    });
    h.engine.start();

    const result = await h.engine.answerFlowQuestion({
      workerId: 'worker-1',
      workerName: 'Scout',
      flowName: 'Write brief',
      projectPath: '/repo',
      userPrompt: 'Add missing submitter details.',
      step: {
        id: 'write-brief',
        role: 'technical-writer',
        inputs: ['user_prompt'],
        output: 'brief.md',
      },
      question: 'Blank or Unknown?',
      artifacts: [],
    });

    expect(result).toEqual({ kind: 'answer', answer: 'Use Unknown.' });
    expect(prompt).toContain('Scout');
    expect(prompt).toContain('Prior decision');
    expect(prompt).toContain('Blank or Unknown?');
    expect(prompt).toContain('Local file/code edits and tests are already authorized');
  });

  it('surfaces an explicit Worker escalation', async () => {
    const h = makeHarness({
      seed: [seedWorker()],
      supervisorTurn: async () => ({
        ok: true,
        text: '<escalate>I need the private recipient list.</escalate>',
      }),
    });
    h.engine.start();
    const result = await h.engine.answerFlowQuestion({
      workerId: 'worker-1',
      flowName: 'Send brief',
      projectPath: '/repo',
      userPrompt: 'Send it.',
      step: { id: 'send', role: 'custom', inputs: [], output: 'receipt.md' },
      question: 'Who receives this?',
      artifacts: [],
    });
    expect(result).toEqual({
      kind: 'escalate',
      reason: 'I need the private recipient list.',
    });
  });
});

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
  it('snapshots external-action authority onto the worker batch', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({
          caps: {
            maxItemsPerShift: 3,
            runIn: 'worktree',
            allowExternalActions: true,
          },
        }),
      ],
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    expect(h.parked[0].origin).toMatchObject({
      kind: 'worker',
      workerId: 'worker-1',
      allowExternalActions: true,
    });
  });

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

  it('skips a worker the pot no longer reaches, and says so as a POOL problem', async () => {
    // Two workers, $10 of caps each, but only $10 in the pot: the first is
    // fully funded and the second gets nothing — even though neither has
    // spent a cent of its own budget.
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', name: 'First', order: 0 }),
        seedWorker({ id: 'worker-2', name: 'Second', order: 1 }),
      ],
      pool: 10,
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    // A tick walks the roster one worker at a time, awaiting each; a
    // multi-worker roster needs more than one drain to get to the end of it.
    await h.flush();
    await h.flush();

    expect(h.parked.map((p) => p.origin)).toHaveLength(1);
    expect(h.parked[0].title).toContain('First');
    const skipped = h.journal.find((e) => e.workerId === 'worker-2' && e.note);
    expect(skipped?.id).toContain('shift-pool-worker-2');
    // Not its own budget's fault, and the note has to say what to do.
    expect(skipped?.note).toContain('pool');
    expect(skipped?.note).toMatch(/move it up|pause/i);
  });

  it('notifies once for the whole roster when the pot runs dry, not once per worker', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', name: 'First', order: 0 }),
        seedWorker({ id: 'worker-2', name: 'Second', order: 1 }),
        seedWorker({ id: 'worker-3', name: 'Third', order: 2 }),
      ],
      // One dollar between three $20 workers.
      pool: 1,
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    await h.flush();
    await h.flush();

    // The top of the roster gets the last dollar and works — funding is
    // checked before a turn, not metered during one, so the pot's final
    // dollar buys a whole shift. That tolerance is deliberate; it belongs to
    // whoever is FIRST, which is the guarantee priority is supposed to give.
    expect(h.parked).toHaveLength(1);
    expect(h.parked[0].title).toContain('First');

    const poolNotices = h.notifications.filter((n) => n.title.includes('pool'));
    expect(poolNotices).toHaveLength(1);
    expect(poolNotices[0].body).toContain('2 workers');
    // Each starved worker still journals its own reason — the desk has to
    // answer for itself even when the notification speaks for the roster.
    expect(h.journal.filter((e) => e.id.startsWith('shift-pool-'))).toHaveLength(2);
  });

  it('refuses a manual shift with the pool explanation, and runs it once the pot goes up', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', name: 'First', order: 0 }),
        seedWorker({ id: 'worker-2', name: 'Second', order: 1 }),
      ],
      pool: 10,
    });
    h.engine.start();

    const refused = await h.engine.workShiftNow('worker-2');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('pool');

    expect(h.engine.setTreasury(40)).toEqual({ ok: true });
    expect(h.treasury()).toEqual({ monthlyUSD: 40 });
    await expect(h.engine.workShiftNow('worker-2')).resolves.toEqual({ ok: true });
    expect(h.parked).toHaveLength(1);
  });

  it('rejects a pot of zero and pushes the whole allocation on every change', async () => {
    const h = makeHarness({ seed: [seedWorker()], pool: 40 });
    h.engine.start();

    expect(h.engine.setTreasury(0)).toMatchObject({ ok: false });
    expect(h.treasury()).toEqual({ monthlyUSD: 40 });

    h.emitted.length = 0;
    h.engine.reorder(['worker-1']);
    expect(h.emitted.some((e) => e.type === 'treasuryUpdate')).toBe(true);

    h.emitted.length = 0;
    expect(h.engine.setTreasury(75)).toEqual({ ok: true });
    const pushed = h.emitted.find((e) => e.type === 'treasuryUpdate');
    expect(pushed.treasury).toEqual({ monthlyUSD: 75 });
    expect(pushed.allocation.byWorker[0]).toMatchObject({
      workerId: 'worker-1',
      priority: 1,
      availableUSD: 20,
    });
  });

  it('seeds an upgrading install with the caps it already had, so nothing changes on day one', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', budgetUSDPerMonth: 20, order: 0 }),
        seedWorker({ id: 'worker-2', budgetUSDPerMonth: 30, order: 1 }),
      ],
    });
    h.engine.start();

    expect(h.treasury()).toEqual({ monthlyUSD: 50 });
    // Both still fully funded to their own caps, exactly as before the pot.
    const { allocation } = h.engine.treasury();
    expect(allocation.byWorker.map((f) => f.availableUSD)).toEqual([20, 30]);
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

  it('remembers which output to render, and survives an edit that never mentions it', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    expect(h.engine.setAutoRender('worker-1', 'dashboard.html')).toEqual({ ok: true });
    expect(h.engine.get('worker-1')?.autoRender).toBe('dashboard.html');
    // The contract editor sends a draft with no `autoRender` key at all —
    // renaming a worker must not silently unpin its report.
    const res = h.engine.save({ ...seedWorker(), name: 'Scout II' });
    expect(res.ok).toBe(true);
    expect(h.engine.get('worker-1')?.autoRender).toBe('dashboard.html');
  });

  it('refuses an empty auto-render choice and an unknown worker', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    expect(h.engine.setAutoRender('worker-1', '  ')).toEqual({
      ok: false,
      error: 'Pick what to render.',
    });
    expect(h.engine.setAutoRender('nobody', 'off').ok).toBe(false);
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

describe('WorkerEngine weekly compaction', () => {
  // Wednesday 08:00. The most recent compaction slot is Sunday 2026-03-01
  // 03:00, so a worker last compacted before that is due; one compacted after
  // it is not. The first tick lands a minute in (MAX_TIMER_MS), well before
  // the 09:00 cadence, so nothing else the engine does is in the way.
  const WED = local(2026, 3, 4, 8, 0);
  const FIRST_TICK = local(2026, 3, 4, 8, 1);

  it('archives older filed work and journals what moved', async () => {
    archiveMock.mockClear().mockReturnValue({ moved: 3 });
    const h = makeHarness({
      startAt: WED,
      seed: [seedWorker({ lastCompactedAt: local(2026, 2, 22, 3, 0) })],
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 8, 2));

    const stamped = h.engine.get('worker-1')?.lastCompactedAt;
    expect(stamped).toBe(FIRST_TICK);
    // The cutoff is derived from the pass's own clock, not from whenever the
    // worker last compacted — a worker that missed a week must not archive
    // two weeks' worth as though it were one.
    expect(archiveMock).toHaveBeenCalledWith('worker-1', compactionCutoff(stamped!));
    expect(h.journal.filter((e) => e.kind === 'compacted')).toEqual([
      {
        // `dayKey` does not zero-pad; it is only ever a dedupe key.
        id: 'compacted-worker-1-2026-3-4',
        workerId: 'worker-1',
        kind: 'compacted',
        at: FIRST_TICK,
        title: '',
        note: 'Weekly compaction: archived 3 older files.',
      },
    ]);
  });

  it('stamps the pass but writes no journal line when nothing was old enough', async () => {
    archiveMock.mockClear().mockReturnValue({ moved: 0 });
    const h = makeHarness({
      startAt: WED,
      seed: [seedWorker({ lastCompactedAt: local(2026, 2, 22, 3, 0) })],
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 8, 2));

    expect(archiveMock).toHaveBeenCalledTimes(1);
    // Stamped anyway, or a worker with nothing to archive would be re-checked
    // every minute for the rest of the week.
    expect(h.engine.get('worker-1')?.lastCompactedAt).toBe(FIRST_TICK);
    expect(h.journal.filter((e) => e.kind === 'compacted')).toEqual([]);
  });

  it('leaves a worker alone until the next weekly slot comes round', async () => {
    archiveMock.mockClear().mockReturnValue({ moved: 3 });
    const h = makeHarness({
      startAt: WED,
      // Monday, i.e. AFTER the Sunday 03:00 slot — already done this week.
      seed: [seedWorker({ lastCompactedAt: local(2026, 3, 2, 3, 0) })],
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 8, 2));

    expect(archiveMock).not.toHaveBeenCalled();
    expect(h.engine.get('worker-1')?.lastCompactedAt).toBe(local(2026, 3, 2, 3, 0));
  });

  it('compacts a worker that has never been compacted', async () => {
    archiveMock.mockClear().mockReturnValue({ moved: 1 });
    const h = makeHarness({ startAt: WED, seed: [seedWorker()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 8, 2));

    expect(archiveMock).toHaveBeenCalledWith('worker-1', compactionCutoff(FIRST_TICK));
    expect(h.journal.filter((e) => e.kind === 'compacted')).toHaveLength(1);
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

describe('WorkerEngine shift clock', () => {
  it('states the wall clock, and the previous shift once there is one', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();

    await h.advanceTo(local(2026, 3, 2, 9, 0));
    expect(h.parked[0].prompt).toContain(
      `This shift started at ${new Date(local(2026, 3, 2, 9, 0)).toISOString()}.`,
    );
    expect(h.parked[0].prompt).toContain('never worked a shift before');

    await h.advanceTo(local(2026, 3, 3, 9, 0));
    expect(h.parked).toHaveLength(2);
    // The window to catch up on is the FIRST shift's time, not this one's.
    expect(h.parked[1].prompt).toContain(
      `Your previous shift planned at ${new Date(local(2026, 3, 2, 9, 0)).toISOString()}`,
    );
  });

  it('hands the worker its own cursor convention and the first-pass window', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    expect(h.parked[0].prompt).toContain('cursor.json');
    expect(h.parked[0].prompt).toContain('cover the last 90 days');
    // Nothing verifies the mark, so the journal's own failure entries are the
    // only check the worker has that its cursor is not ahead of its data.
    expect(h.parked[0].prompt).toContain('resume from the one it replaced');
  });

  it('keeps the planning anchor across a cadence edit that clears lastShiftAt', async () => {
    const seed = seedWorker();
    const h = makeHarness({ seed: [seed] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    const firstShiftAt = local(2026, 3, 2, 9, 0);

    // Editing the cadence re-anchors the schedule — which must not tell the
    // worker it has never looked at the project.
    const saved = h.engine.save({ ...seed, cadence: { kind: 'interval', everyMinutes: 60 } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.worker.lastShiftAt).toBeUndefined();
    expect(saved.worker.lastPlannedAt).toBe(firstShiftAt);

    // The next shift under the new cadence still knows when the last one was.
    await h.advanceTo(local(2026, 3, 2, 11, 0));
    expect(h.parked.length).toBeGreaterThan(1);
    expect(h.parked[1].prompt).toContain(
      `Your previous shift planned at ${new Date(firstShiftAt).toISOString()}`,
    );
  });

  it('does not let an errand move the anchor a shift has to catch up from', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    h.setNow(local(2026, 3, 2, 14, 0));
    await h.engine.runErrand('worker-1', 'How many open TODOs are there?');

    h.setNow(local(2026, 3, 3, 9, 0));
    await h.advanceTo(local(2026, 3, 3, 9, 0));
    const last = h.parked[h.parked.length - 1];
    expect(last.prompt).toContain(
      `Your previous shift planned at ${new Date(local(2026, 3, 2, 9, 0)).toISOString()}`,
    );
  });
});

describe('WorkerEngine memory reset', () => {
  it('forgets the journal and starts over at shift #1', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.journal.push({
      id: 'other',
      workerId: 'worker-2',
      kind: 'rejected',
      at: 1,
      title: 'Someone else’s idea',
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    expect(h.journal.filter((e) => e.workerId === 'worker-1').length).toBeGreaterThan(0);

    const res = h.engine.resetMemory('worker-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toBeGreaterThan(0);
    expect(res.files).toBe(0);
    expect(res.shifts).toBe(0);
    expect(res.errands).toBe(0);
    expect(res.runs).toBe(0);
    expect(h.journal.filter((e) => e.workerId === 'worker-1')).toEqual([]);
    // Another worker's memory is not the caller's to wipe.
    expect(h.journal.filter((e) => e.workerId === 'worker-2')).toHaveLength(1);

    const w = h.engine.get('worker-1')!;
    expect(w.shiftCount).toBeUndefined();
    expect(w.lastPlannedAt).toBeUndefined();
    // Trust and budget are standing decisions about the worker, not memories.
    expect(w.trust).toBe('probation');
    expect(w.budgetUSDPerMonth).toBe(seedWorker().budgetUSDPerMonth);

    // Next shift is #1 again, with nothing to catch up on.
    await h.advanceTo(local(2026, 3, 3, 9, 0));
    const last = h.parked[h.parked.length - 1];
    expect(last.prompt).toContain('This is your shift #1.');
    expect(last.prompt).toContain('never worked a shift before');
  });

  it('clears shift, errand, and child-run history as part of the same reset', () => {
    const cleared: string[] = [];
    const h = makeHarness({
      seed: [seedWorker()],
      clearActivity: (workerId) => {
        cleared.push(workerId);
        return { shifts: 3, errands: 2, runs: 4 };
      },
    });
    h.engine.start();

    const res = h.engine.resetMemory('worker-1');

    expect(res).toEqual({
      ok: true,
      entries: 0,
      files: 0,
      shifts: 3,
      errands: 2,
      runs: 4,
    });
    expect(cleared).toEqual(['worker-1']);
  });

  it('leaves activity intact when the journal rewrite fails', () => {
    // The journal rewrite is the fallible step, and it is the one that is
    // harmless to retry — so it has to run BEFORE the irreversible activity
    // clear. Reversed, a failed reset reported {ok:false} while the activity
    // was already gone, and no retry could recover it.
    const cleared: string[] = [];
    const h = makeHarness({
      seed: [seedWorker()],
      clearActivity: (workerId) => {
        cleared.push(workerId);
        return { shifts: 3, errands: 2, runs: 4 };
      },
      journalClear: () => {
        throw new Error('read-only file system');
      },
    });
    h.engine.start();

    const res = h.engine.resetMemory('worker-1');

    expect(res).toEqual({ ok: false, error: 'read-only file system' });
    expect(cleared).toEqual([]);
    // The worker record is untouched, so the same reset can simply be retried.
    expect(h.engine.get('worker-1')!.anchorAt).toBeUndefined();
  });

  it('does not fire the moment the reset lands', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    expect(h.parked).toHaveLength(1);

    // Reset at 23:00 — the daily 09:00 slot is long past, and a cleared
    // anchor would read as "due since this morning".
    h.setNow(local(2026, 3, 2, 23, 0));
    expect(h.engine.resetMemory('worker-1').ok).toBe(true);
    await h.flush();
    expect(h.parked).toHaveLength(1);
  });

  it('refuses while a planning turn is in flight', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    const release = h.holdPark();
    const shift = h.engine.workShiftNow('worker-1');
    await h.flush();

    const res = h.engine.resetMemory('worker-1');
    expect(res).toEqual({ ok: false, error: 'This worker is mid-shift. Wait for it to finish, then reset.' });

    release();
    await shift;
  });

  it('reports an unknown worker rather than clearing nothing quietly', () => {
    const h = makeHarness();
    h.engine.start();
    expect(h.engine.resetMemory('nobody')).toEqual({ ok: false, error: 'Worker not found.' });
  });
});
