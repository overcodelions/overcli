import { describe, expect, it, vi } from 'vitest';

import {
  CONCISE_RESPONSE_DIRECTIVE,
  EFFICIENT_TOOL_DIRECTIVE,
} from '../../shared/responseDirectives';

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
const { archiveMock, deleteDeliverableMock, fileDeliverableMock } = vi.hoisted(() => ({
  archiveMock: vi.fn(() => ({ moved: 0 })),
  deleteDeliverableMock: vi.fn(() => ({ removed: 0 })),
  // The cabinet copy has its own tests; stubbing it keeps the engine's tests
  // off the disk now that a finished item can carry artifacts.
  fileDeliverableMock: vi.fn<typeof import('./workerFiles').fileWorkerDeliverable>(() => ({
    written: true,
    name: 'filed',
  })),
}));
const { publishMock } = vi.hoisted(() => ({
  publishMock: vi.fn<typeof import('./workerPublish').publishDeliverableToProject>(() => ({ written: [] })),
}));
vi.mock('./workerPublish', () => ({
  publishDeliverableToProject: publishMock,
}));
vi.mock('./workerFiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workerFiles')>()),
  archiveWorkerFiles: archiveMock,
  deleteDeliverable: deleteDeliverableMock,
  fileWorkerDeliverable: fileDeliverableMock,
}));

import { WorkerEngine, parseFlowRequest, type WorkerEngineDeps, type WorkerParker } from './workerEngine';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { Worker, WorkerJournalEntry } from '../../shared/flows/worker';
import { WORKER_MAX_HANDOFFS_PER_TURN } from '../../shared/flows/worker';
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
    deleteActivity?: WorkerEngineDeps['deleteActivity'];
    journalClear?: (workerId: string) => number;
    supervisorTurn?: WorkerEngineDeps['supervisorTurn'];
    deliverablesFor?: WorkerEngineDeps['deliverablesFor'];
    runIdForConversation?: WorkerEngineDeps['runIdForConversation'];
  } = {},
) {
  let now = opts.startAt ?? local(2026, 3, 2, 8, 0);
  const parked: Array<Parameters<WorkerParker['parkProposal']>[0]> = [];
  const direct: Array<Parameters<WorkerParker['parkDirect']>[0]> = [];
  const deleted: string[] = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const emitted: any[] = [];
  const saved: Worker[] = [];
  const journal: WorkerJournalEntry[] = [];
  const orchestrations = new Map<string, Orchestration>();
  const checkpoints: Array<{ projectPath: string; message: string }> = [];
  let spend = opts.spend ?? 0;
  let treasury: Treasury | null = opts.pool != null ? { monthlyUSD: opts.pool } : null;
  let parkResult: Awaited<ReturnType<WorkerParker['parkProposal']>> = {
    ok: true,
    orchestrationId: 'orch-1',
    count: 3,
    queued: 0,
    excluded: 0,
  };
  let directResult: Awaited<ReturnType<WorkerParker['parkDirect']>> = {
    ok: true,
    orchestrationId: 'orch-direct',
    count: 1,
    queued: 0,
  };
  let parkGate: Promise<void> | null = null;

  let pending: { at: number; fn: () => void } | null = null;

  const parker: WorkerParker = {
    delete: ({ id }) => {
      deleted.push(id);
      orchestrations.delete(id);
    },
    async parkProposal(args) {
      parked.push(args);
      if (parkGate) await parkGate;
      return parkResult;
    },
    async parkDirect(args) {
      direct.push(args);
      return directResult;
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
      load: (workerId) => journal.filter((e) => e.workerId === workerId).sort((a, b) => b.at - a.at),
      has: (entryId) => journal.some((e) => e.id === entryId),
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
      remove: (workerId, match) => {
        const ids = new Set(match.ids ?? []);
        const before = journal.length;
        for (let i = journal.length - 1; i >= 0; i--) {
          const e = journal[i];
          if (e.workerId !== workerId) continue;
          const hit =
            (match.orchestrationId !== undefined && e.orchestrationId === match.orchestrationId) || ids.has(e.id);
          if (hit) journal.splice(i, 1);
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
    deleteActivity: opts.deleteActivity,
    supervisorTurn: opts.supervisorTurn,
    deliverablesFor: opts.deliverablesFor,
    runIdForConversation: opts.runIdForConversation,
    checkpoint: (args) => checkpoints.push(args),
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
    direct,
    deleted,
    notifications,
    emitted,
    saved,
    journal,
    orchestrations,
    checkpoints,
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
    setDirectResult: (r: typeof directResult) => {
      directResult = r;
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
        return {
          ok: true,
          text: '<worker_answer>Use Unknown.</worker_answer>',
        };
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

describe('WorkerEngine on-demand workers', () => {
  it('never fires on the clock, and reports no next shift', async () => {
    const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
    h.engine.start();
    // Well past the 09:00 a scheduled Scout would have worked, and past the
    // next day's too — a desk has no morning.
    await h.advanceTo(local(2026, 3, 3, 12, 0));
    expect(h.parked).toEqual([]);
    expect(h.engine.nextShiftAt('worker-1')).toBeNull();
    // And nothing was journalled as missed: an occurrence that does not exist
    // cannot have been slept through.
    expect(h.journal.filter((e) => e.note?.startsWith('Missed'))).toEqual([]);
  });

  it('still answers an errand, which pausing would have refused', async () => {
    const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
    h.engine.start();
    const res = await h.engine.runErrand('worker-1', 'Break the search epic down with me.');
    expect(res.ok).toBe(true);
    expect(parkedWorkerIds(h.parked)).toEqual(['worker-1']);
  });

  describe('a direct run', () => {
    it('sends the work straight to the flow, with no planning turn', async () => {
      const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
      h.engine.start();
      const res = await h.engine.runErrand('worker-1', '/run LG Partner Club Thailand');
      expect(res.ok).toBe(true);
      // The producer never ran — that is the whole point of the path.
      expect(h.parked).toEqual([]);
      expect(h.direct).toHaveLength(1);
      expect(h.direct[0]).toMatchObject({
        projectPath: '/repo',
        flowId: 'fix-it',
        runIn: 'worktree',
        origin: { kind: 'worker', workerId: 'worker-1', task: 'errand' },
      });
      // The work itself, verbatim and last, under its own heading.
      expect(h.direct[0].prompt).toContain('THE WORK\nLG Partner Club Thailand');
      // Parked, not launched: `/run` is unambiguous about WHAT, not about
      // spending the month unattended.
      expect(h.direct[0].autoLaunch).toBeFalsy();
    });

    it('carries the worker\u2019s whole briefing into the run', async () => {
      const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
      h.engine.start();
      h.journal.push({
        id: 'e-1',
        workerId: 'worker-1',
        kind: 'shift',
        at: local(2026, 3, 1, 9, 0),
        title: 'Reviewed LG Thailand',
        note: 'One report filed.',
      });
      await h.engine.runErrand('worker-1', '/run LG Electronics USA');
      const prompt = h.direct[0].prompt;
      // Skipping the planning turn skipped what the planning turn knew. All
      // three pieces travel with the work instead.
      expect(prompt).toContain('Find the most valuable maintenance work');
      expect(prompt).toContain('Reviewed LG Thailand');
      expect(prompt).toContain('worker-files');
      // And the job description cannot outrank the step it lands in — a
      // description saying "produce the report" would otherwise talk step 1 of
      // a four-step flow into drawing conclusions it must not draw.
      expect(prompt).toContain('THE STEP WINS');
    });

    it('lands on the desk as a turn with its batch attached', async () => {
      const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
      h.engine.start();
      await h.engine.runErrand('worker-1', '/run Review LG Thailand');
      const entry = h.journal.at(-1);
      expect(entry).toMatchObject({
        kind: 'errand',
        title: 'Review LG Thailand',
        orchestrationId: 'orch-direct',
      });
      expect(entry?.note).not.toContain('Nothing launched');
    });

    it('leaves an ordinary message on the planning path', async () => {
      const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
      h.engine.start();
      await h.engine.runErrand('worker-1', 'did you review the documents?');
      expect(h.direct).toEqual([]);
      expect(h.parked).toHaveLength(1);
    });

    it('refuses when the worker has no flow to run', async () => {
      const h = makeHarness({ seed: [seedWorker({ cadence: null, flowIds: [] })] });
      h.engine.start();
      const res = await h.engine.runErrand('worker-1', '/run anything');
      expect(res).toEqual({ ok: false, error: 'Scout has no flow to run.' });
      expect(h.direct).toEqual([]);
    });

    it('is still gated on funding, like every other turn', async () => {
      const h = makeHarness({
        seed: [seedWorker({ cadence: null, budgetUSDPerMonth: 5 })],
        pool: 20,
        spend: 6,
      });
      h.engine.start();
      const res = await h.engine.runErrand('worker-1', '/run Review LG Thailand');
      expect(res.ok).toBe(false);
      expect(h.direct).toEqual([]);
    });
  });

  it('works a shift on demand when asked', async () => {
    const h = makeHarness({ seed: [seedWorker({ cadence: null })] });
    h.engine.start();
    const res = await h.engine.workShiftNow('worker-1');
    expect(res.ok).toBe(true);
    expect(h.parked[0].title).toBe('[Shift 1] Scout');
  });

  it('is funded, where a paused worker is not', async () => {
    const paused = makeHarness({ seed: [seedWorker({ enabled: false })], pool: 20 });
    paused.engine.start();
    const refused = await paused.engine.runErrand('worker-1', 'Help me plan.');
    expect(refused).toEqual({ ok: false, error: 'Paused — it holds no funds and works no shifts.' });

    const desk = makeHarness({ seed: [seedWorker({ cadence: null })], pool: 20 });
    desk.engine.start();
    const answered = await desk.engine.runErrand('worker-1', 'Help me plan.');
    expect(answered.ok).toBe(true);
  });

  it('leaves the pool for the workers below it instead of reserving its cap', () => {
    // Scout is FIRST in the funding order with a $20 cap and no clock; Nadia
    // is second with a $20 cap and a daily shift. The pot is $20 — enough for
    // exactly one of them to be fully funded. Before on-demand existed, the
    // only worker that released its reserve was a paused one, whose desk was
    // shut; here the desk stays open and the reserve is still released.
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', order: 0, cadence: null, budgetUSDPerMonth: 20 }),
        seedWorker({ id: 'worker-2', name: 'Nadia', order: 1, budgetUSDPerMonth: 20 }),
      ],
      pool: 20,
    });
    h.engine.start();
    const { allocation } = h.engine.treasury();
    const scout = allocation.byWorker.find((f) => f.workerId === 'worker-1')!;
    const nadia = allocation.byWorker.find((f) => f.workerId === 'worker-2')!;
    expect(scout.availableUSD).toBe(20);
    expect(scout.blocked).toBe('none');
    // The whole pot is still reachable by the scheduled worker below it.
    expect(nadia.availableUSD).toBe(20);
    expect(nadia.blocked).toBe('none');
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

/// `origin` is a union — a batch can come from a schedule or a worker — so the
/// worker id needs narrowing. The engine only ever parks worker batches; a
/// schedule origin here would be a bug, and surfaces as an `undefined` id.
function parkedWorkerIds(parked: Array<Parameters<WorkerParker['parkProposal']>[0]>): Array<string | undefined> {
  return parked.map((p) => (p.origin?.kind === 'worker' ? p.origin.workerId : undefined));
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
    const h = makeHarness({
      seed: [seedWorker({ budgetUSDPerMonth: 5 })],
      spend: 5,
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));

    expect(h.parked).toHaveLength(0);
    const budgetEntries = h.journal.filter((e) => e.note?.includes('budget'));
    expect(budgetEntries).toHaveLength(1);
    expect(h.notifications.some((n) => n.title.includes('out of budget'))).toBe(true);
  });

  it('refuses a manual shift when over budget instead of silently skipping', async () => {
    const h = makeHarness({
      seed: [seedWorker({ budgetUSDPerMonth: 5 })],
      spend: 6,
    });
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
    await expect(h.engine.workShiftNow('worker-2')).resolves.toEqual({
      ok: true,
    });
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

  it('distributes remaining funds by active-worker priority in one update', () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', order: 0, budgetUSDPerMonth: 5 }),
        seedWorker({ id: 'worker-2', order: 1, budgetUSDPerMonth: 25 }),
        seedWorker({
          id: 'paused',
          order: 2,
          budgetUSDPerMonth: 99,
          enabled: false,
        }),
      ],
      pool: 40,
    });
    h.engine.start();
    h.emitted.length = 0;

    const result = h.engine.distributeFunds();

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.workers.map((worker) => [worker.id, worker.budgetUSDPerMonth])).toEqual([
      ['worker-1', 26.67],
      ['worker-2', 13.33],
    ]);
    expect(result.allocation.byWorker.map((row) => [row.workerId, Number(row.availableUSD.toFixed(2))])).toEqual([
      ['worker-1', 26.67],
      ['worker-2', 13.33],
      ['paused', 0],
    ]);
    expect(h.saved.find((worker) => worker.id === 'paused')).toBeUndefined();
    expect(h.emitted.filter((event) => event.type === 'treasuryUpdate')).toHaveLength(1);
  });

  it('distributes a valid one-cent share even when spend carries a 7th decimal', () => {
    const h = makeHarness({
      seed: [seedWorker({ id: 'worker-1', order: 0, budgetUSDPerMonth: 20 })],
      spend: 12.3456784,
      pool: 12.3556784,
    });
    h.engine.start();

    const result = h.engine.distributeFunds();

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.workers[0].budgetUSDPerMonth).toBeCloseTo(12.355678, 6);
  });

  it('drops a parked distribution on an explicit budget edit, and the new budget survives into next month', () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', order: 0, budgetUSDPerMonth: 5 }),
        seedWorker({ id: 'worker-2', order: 1, budgetUSDPerMonth: 25 }),
      ],
      pool: 40,
    });
    h.engine.start();

    const distributed = h.engine.distributeFunds();
    expect(distributed).toMatchObject({ ok: true });
    if (!distributed.ok) return;
    expect(distributed.workers.find((w) => w.id === 'worker-1')?.distribution?.budgetUSDPerMonth).toBe(5);

    // An explicit budget edit while a distribution is still parked must win —
    // otherwise settleDistributions puts the OLD number back on the 1st.
    const current = h.engine.get('worker-1');
    expect(current).not.toBeNull();
    const edited = h.engine.save({ ...(current as Worker), budgetUSDPerMonth: 50 });
    expect(edited).toMatchObject({ ok: true });
    if (!edited.ok) return;
    expect(edited.worker.distribution).toBeUndefined();

    // September: the spend window resets and settleDistributions runs again —
    // it must not have anything parked to restore, so the edit sticks.
    h.setNow(new Date(2026, 8, 1, 0, 30).getTime());
    const after = h.engine.treasury().allocation;
    expect(after.byWorker.find((row) => row.workerId === 'worker-1')?.capUSD).toBe(50);
  });

  it('gives back the configured budget when the distributed month ends', () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'worker-1', order: 0, budgetUSDPerMonth: 5 }),
        seedWorker({ id: 'worker-2', order: 1, budgetUSDPerMonth: 25 }),
      ],
      pool: 40,
    });
    h.engine.start();
    h.setNow(new Date(2026, 7, 31, 12).getTime());

    const result = h.engine.distributeFunds();
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // In-month the distributed cap stands, and the original is parked on it.
    expect(result.workers.map((w) => [w.id, w.budgetUSDPerMonth])).toEqual([
      ['worker-1', 26.67],
      ['worker-2', 13.33],
    ]);
    expect(result.workers.map((w) => w.distribution?.budgetUSDPerMonth)).toEqual([5, 25]);

    // Same month, second click: the ORIGINAL budget must survive, not the cap
    // the first distribution wrote.
    h.engine.distributeFunds();
    expect([...h.saved].reverse().find((w) => w.id === 'worker-1')?.distribution?.budgetUSDPerMonth).toBe(5);

    // September: the spend window resets, so the distributed ceilings have to
    // go — otherwise the roster carries August's spend as next month's budget.
    h.saved.length = 0;
    h.setNow(new Date(2026, 8, 1, 0, 30).getTime());
    const after = h.engine.treasury().allocation;

    expect(after.byWorker.map((row) => [row.workerId, row.capUSD])).toEqual([
      ['worker-1', 5],
      ['worker-2', 25],
    ]);
    expect(h.saved.map((w) => [w.id, w.budgetUSDPerMonth])).toEqual([
      ['worker-1', 5],
      ['worker-2', 25],
    ]);
    expect(h.saved.every((w) => w.distribution === undefined)).toBe(true);

    // Idempotent: a second read in the same month re-saves nothing.
    h.saved.length = 0;
    h.engine.treasury();
    expect(h.saved).toEqual([]);
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

  it('runs a worker whose slot passed while the one in front of it was planning', async () => {
    // Both due at 9:00. Scout's planning turn holds the tick past the grace
    // window; Relay's slot is late by then, but it was late because overcli
    // was busy, not closed — it has to run, not be written off. Before this
    // the bottom of a roster starved: skipped, re-anchored, skipped again.
    const h = makeHarness({
      seed: [seedWorker(), seedWorker({ id: 'worker-2', name: 'Relay' })],
      startAt: local(2026, 3, 2, 8, 0),
      pool: 100,
    });
    const release = h.holdPark();
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    expect(parkedWorkerIds(h.parked)).toEqual(['worker-1']);

    h.setNow(local(2026, 3, 2, 9, 10));
    release();
    for (let i = 0; i < 5; i++) await h.flush();

    expect(parkedWorkerIds(h.parked)).toEqual(['worker-1', 'worker-2']);
    expect(h.journal.some((e) => e.note?.startsWith('Missed a shift'))).toBe(false);
  });

  it('journals a missed shift when overcli was not open for it', async () => {
    const h = makeHarness({
      seed: [seedWorker()],
      // The engine only starts at 8pm: the 9:00 occurrence came and went with
      // the app shut, which is the one case nobody could have fired.
      startAt: local(2026, 3, 2, 20, 0),
    });
    h.engine.start();
    // A host wake is what brings the engine round to look — and it must not
    // talk the verdict into "slept through". The app genuinely was not here.
    h.setNow(local(2026, 3, 2, 21, 0));
    h.engine.onHostResume();
    for (let i = 0; i < 5; i++) await h.flush();

    expect(h.parked).toHaveLength(0);
    const missed = h.journal.find((e) => e.note?.startsWith('Missed a shift'));
    expect(missed?.note).toMatch(/closed/i);
  });

  it('works the shift the host slept through, rather than losing it', async () => {
    // Vantage's 2026-08-31: overcli open since the night before, the Mac
    // asleep across the 9:00 slot, awake again the same morning. The slot is
    // still the current one, so it is late, not missed.
    const h = makeHarness({
      seed: [seedWorker()],
      startAt: local(2026, 3, 2, 8, 0),
    });
    h.engine.start();
    h.setNow(local(2026, 3, 2, 9, 13));
    h.engine.onHostResume();
    for (let i = 0; i < 5; i++) await h.flush();

    expect(parkedWorkerIds(h.parked)).toEqual(['worker-1']);
    expect(h.journal.some((e) => e.note?.startsWith('Missed a shift'))).toBe(false);
  });

  it('gives up on a slot only once the next one has come due, and says why', async () => {
    // Open the whole time, asleep from Monday morning to Wednesday afternoon.
    // Tuesday's and Wednesday's 9am slots have passed, so Monday's is no
    // longer current and replaying it would mean two runs for one slot.
    const h = makeHarness({
      seed: [seedWorker()],
      startAt: local(2026, 3, 2, 8, 0),
    });
    h.engine.start();
    h.setNow(local(2026, 3, 4, 14, 0));
    h.engine.onHostResume();
    for (let i = 0; i < 5; i++) await h.flush();

    expect(h.parked).toHaveLength(0);
    const missed = h.journal.find((e) => e.note?.startsWith('Missed a shift'));
    expect(missed?.note).toMatch(/asleep/i);
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
  it('never auto-approves a desk errand, at any trust level', async () => {
    // The Ask/Create-work toggle used to be the only thing standing between a
    // casual question and an unattended launch on an autonomous worker. The
    // toggle is gone, so the guarantee lives here instead: a shift is
    // something you scheduled and may launch on its own; a sentence you typed
    // is not, whoever you typed it to.
    for (const trust of ['probation', 'trusted', 'autonomous'] as const) {
      const h = makeHarness({ seed: [seedWorker({ trust })] });
      h.engine.start();
      await h.engine.runErrand('worker-1', 'What changed?');
      expect(h.parked[0].autoApprove).toBeUndefined();
      // The ceiling is still the worker's own — it may PROPOSE its full cap,
      // it just cannot launch any of it without you.
      expect(h.parked[0].maxItems).toBe(3);
    }

    // A shift keeps its cap, so removing the toggle did not quietly ground
    // the autonomous workers.
    const shift = makeHarness({ seed: [seedWorker({ trust: 'autonomous' })] });
    shift.engine.start();
    await shift.engine.workShiftNow('worker-1');
    expect(shift.parked[0].autoApprove).toEqual({ maxItems: 3 });
  });

  it('leads a swift worker\'s errand with the Swift directives, and a full one\'s with the job', async () => {
    const swift = makeHarness({ seed: [seedWorker()] });
    swift.engine.start();
    await swift.engine.runErrand('worker-1', 'What changed?');
    // Default, for a worker hired before `pace` existed and for every new one.
    expect(swift.parked[0].prompt.startsWith(CONCISE_RESPONSE_DIRECTIVE)).toBe(true);
    expect(swift.parked[0].prompt).toContain(EFFICIENT_TOOL_DIRECTIVE);
    // The directives are a preamble, not a replacement: the errand still
    // carries the whole contract behind them.
    expect(swift.parked[0].prompt).toContain('Find the most valuable maintenance work');

    const full = makeHarness({ seed: [seedWorker({ pace: 'full' })] });
    full.engine.start();
    await full.engine.runErrand('worker-1', 'What changed?');
    expect(full.parked[0].prompt).not.toContain(CONCISE_RESPONSE_DIRECTIVE);
  });

  it('holds one desk conversation for the day instead of re-hiring the worker every message', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'How did the release go?');
    // First message of the day: cold. Nothing to resume, so it carries the
    // whole worker — job description, journal, the lot.
    expect(h.parked[0].resumeSessionId).toBeUndefined();
    expect(h.parked[0].prompt).toContain('Find the most valuable maintenance work');
    const conversationId = h.parked[0].conversationId;
    expect(conversationId).toBeTruthy();

    await h.engine.runErrand('worker-1', 'And the one before it?');
    // Second message: the worker is still sitting there. Resume the session
    // and say the new thing — re-sending the contract would be paying twice
    // for context it never lost.
    expect(h.parked[1]).toMatchObject({ conversationId, resumeSessionId: 'sess-a' });
    expect(h.parked[1].prompt).toContain('And the one before it?');
    // The persona is not re-sent — that is the point of resuming. Only the
    // output contract rides along, because a resumed model drifting off
    // <subject>/<candidates> loses the propose and flow-request paths
    // silently.
    expect(h.parked[1].prompt).not.toContain('Find the most valuable maintenance work');
    expect(h.parked[1].prompt).toContain('Same three paths as before');
    // And no replay: the replayed thread exists only for a thread we cannot
    // resume, and re-sending it reads as the manager repeating themselves.
    expect(h.parked[1].priorTurns).toBeUndefined();
  });

  it('starts a new desk conversation the next day', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'How did the release go?');

    h.setNow(local(2026, 3, 3, 8, 0));
    await h.engine.runErrand('worker-1', 'And today?');
    // Yesterday's thread is not resumed — a desk conversation that ran for a
    // week would carry Monday's tangent into Friday. The handoff block is how
    // yesterday gets across.
    expect(h.parked[1].resumeSessionId).toBeUndefined();
    expect(h.parked[1].conversationId).not.toBe(h.parked[0].conversationId);
    expect(h.parked[1].prompt).toContain('Find the most valuable maintenance work');
  });

  it('re-asks in full when the CLI refuses the resume', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'How did the release go?');

    // The session is gone (history wiped), so the CLI answered cold — from a
    // prompt that was only the bare message, because we expected it to
    // remember the rest.
    h.setParkResult({ ok: true, orchestrationId: 'orch-2', count: 0, queued: 0, excluded: 0, sessionId: 'sess-b' });
    await h.engine.runErrand('worker-1', 'And the one before it?');

    expect(h.parked).toHaveLength(3);
    expect(h.parked[1].resumeSessionId).toBe('sess-a');
    // The redo: same conversation, no resume, the whole worker again.
    expect(h.parked[2].resumeSessionId).toBeUndefined();
    expect(h.parked[2].conversationId).toBe(h.parked[0].conversationId);
    expect(h.parked[2].prompt).toContain('Find the most valuable maintenance work');
    expect(h.deleted).toEqual(['orch-2']);
  });

  it('re-establishes the worker when you rewrite its job description mid-thread', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'How would you build this?');

    const before = h.engine.get('worker-1')!;
    const saved = await h.engine.save({ ...before, jobDescription: 'You are a designer. Talk it through first.' });
    expect(saved.ok).toBe(true);

    await h.engine.runErrand('worker-1', 'And now?');
    // Cold again. A resumed turn re-sends none of the persona, so a thread
    // held open across the edit would answer as the OLD worker until
    // midnight and the edit would look like it did nothing.
    expect(h.parked[1].resumeSessionId).toBeUndefined();
    expect(h.parked[1].prompt).toContain('Talk it through first.');
  });

  it('keeps the thread across an edit that is not the job description', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'How would you build this?');

    const before = h.engine.get('worker-1')!;
    await h.engine.save({ ...before, budgetUSDPerMonth: 99 });

    await h.engine.runErrand('worker-1', 'And now?');
    // Raising the budget mid-morning is not a change of persona, and must not
    // make the worker forget what you were just talking about.
    expect(h.parked[1].resumeSessionId).toBe('sess-a');
  });

  it('keeps work errands in the same desk conversation as the chat around them', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'How would you build this?');
    // First message of the day is cold either way — there is nothing to
    // resume, so it carries the whole worker.
    expect(h.parked[0].resumeSessionId).toBeUndefined();
    const conversationId = h.parked[0].conversationId;
    expect(conversationId).toBeTruthy();

    await h.engine.runErrand('worker-1', 'Where does the data get persisted?');
    // The follow-up is the same conversation. Before this it opened a cold
    // process and read a 2000-char truncation of the answer above as though
    // the manager had said it, which is why every reply restated the design
    // instead of continuing it.
    expect(h.parked[1].conversationId).toBe(conversationId);
    expect(h.parked[1].resumeSessionId).toBe('sess-a');
    expect(h.parked[1].priorTurns).toBeUndefined();
    expect(h.parked[1].prompt).not.toContain('Find the most valuable maintenance work');
  });

  it('restates the output contract on a warm turn, but not the worker', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'How would you build this?');
    await h.engine.runErrand('worker-1', 'Where does the data get persisted?');

    // The job description and journal are not re-sent — the worker still has
    // them. The output contract is, because a resumed model drifting off
    // <subject>/<candidates> silently loses the propose and flow-request
    // paths, and there is no way to tell from the reply that it happened.
    expect(h.parked[1].prompt).toContain('Where does the data get persisted?');
    expect(h.parked[1].prompt).toContain('<subject>');
    expect(h.parked[1].prompt).toContain('Same three paths as before');
    expect(h.parked[1].prompt).not.toContain('YOUR JOB DESCRIPTION');
  });

  it('says whether the turn actually resumed, rather than letting the desk guess', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0, sessionId: 'sess-a' });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'How would you build this?');
    await h.engine.runErrand('worker-1', 'And where does it persist?');

    const starts = h.emitted.filter(
      (e: any) => e.type === 'workerShiftProgress' && e.active && e.task === 'errand',
    );
    // Cold, then warm. The desk prints "picking up where you left off" off
    // this and nothing else — a stored session for today is not the same
    // claim, and it used to say it on turns that opened cold.
    expect(starts.map((e: any) => e.warm)).toEqual([false, true]);
  });

  it('carries the worker\'s MCP allowlist into every shift and errand', async () => {
    const h = makeHarness({ seed: [seedWorker({ mcpServers: ['atlassian'] })] });
    h.engine.start();
    await h.engine.workShiftNow('worker-1');
    await h.engine.runErrand('worker-1', 'What changed?');
    expect(h.parked[0].mcpAllowlist).toEqual(['atlassian']);
    expect(h.parked[1].mcpAllowlist).toEqual(['atlassian']);

    // Absent stays absent: a worker hired before the field existed inherits
    // everything, exactly as it did.
    const legacy = makeHarness({ seed: [seedWorker()] });
    legacy.engine.start();
    await legacy.engine.workShiftNow('worker-1');
    expect(legacy.parked[0].mcpAllowlist).toBeUndefined();
  });

  it('leaves a shift at full pace whatever the worker is set to', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.engine.workShiftNow('worker-1');
    expect(h.parked[0].prompt).not.toContain(CONCISE_RESPONSE_DIRECTIVE);
  });

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
    // A worker whose own job description describes the work reads path 1 as
    // covering it and answers in prose, skipping the flow's review and
    // fact-check steps. The tie-break is what stops that.
    expect(h.parked[0].prompt).toContain('WINS THE TIE against path 1');
  });

  it('states context discipline in both the shift and the errand prompt', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    await h.engine.runErrand('worker-1', 'audit the flaky specs');
    await h.engine.workShiftNow('worker-1');

    expect(h.parked).toHaveLength(2);
    for (const parked of h.parked) {
      expect(parked.prompt).toContain('KEEPING YOUR CONTEXT FOR THE WORK');
      expect(parked.prompt).toContain('Read those through a subagent');
    }
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
    expect(h.parked[0].autoApprove).toBeUndefined();
    expect(h.parked[0].excludeTitles).toEqual(['do not repeat this']);
    expect(h.parked[0].prompt).toContain('Do not repeat this');
    expect(h.saved).toHaveLength(savedBefore);
    expect(h.engine.get('worker-1')?.shiftCount).toBeUndefined();
    expect(h.engine.get('worker-1')?.lastShiftAt).toBeUndefined();
  });

  it('honours an autonomous worker’s working-copy execution setting', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({
          trust: 'autonomous',
          caps: { maxItemsPerShift: 3, runIn: 'cwd' },
        }),
      ],
    });
    h.engine.start();

    await h.engine.runErrand('worker-1', 'Repair the flaky CI spec.');

    expect(h.parked[0].runIn).toBe('cwd');
  });

  it('returns and journals a no-launch reply without labeling it a refusal', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 0,
      queued: 0,
      excluded: 0,
    });
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
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 3,
      queued: 1,
      excluded: 0,
    });
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
    await expect(budget.engine.runErrand('worker-1', 'do a thing')).resolves.toMatchObject({
      ok: false,
    });
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

    expect(h.parked.map((p) => p.title)).toEqual(['[Shift 1] Scout', '[Errand] first', '[Errand] second']);
  });

  it('keeps the queue moving when an errand fails', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    // An empty instruction is rejected before it ever reaches the queue, so
    // use the one failure that happens inside it: a park that returns not-ok.
    h.setParkResult({ ok: false, error: 'planner exploded' });
    await expect(h.engine.runErrand('worker-1', 'first')).resolves.toMatchObject({ ok: false });

    h.setParkResult({
      ok: true,
      orchestrationId: 'o-2',
      count: 1,
      queued: 1,
      excluded: 0,
    });
    await expect(h.engine.runErrand('worker-1', 'second')).resolves.toMatchObject({ ok: true });
  });
});

describe('WorkerEngine hiring and trust', () => {
  it('forces every new hire onto probation', () => {
    const h = makeHarness();
    h.engine.start();
    const res = h.engine.save({
      ...seedWorker(),
      id: undefined,
      trust: 'autonomous',
    } as never);
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
    expect(h.engine.setAutoRender('worker-1', 'dashboard.html')).toEqual({
      ok: true,
    });
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
      seed: [
        seedWorker({
          trust: 'autonomous',
          caps: { maxItemsPerShift: 3, runIn: 'cwd' },
        }),
      ],
    });
    h.engine.start();
    const res = h.engine.setTrust('worker-1', 'trusted');
    expect(res.ok).toBe(true);
    expect(h.engine.get('worker-1')?.caps.runIn).toBe('worktree');
  });
});

describe('WorkerEngine notes', () => {
  it('writes a note against a turn, into the journal the worker plans from', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.orchestrations.set('orch-1', workerBatch({ title: '[Shift 1] Scout' }));
    h.engine.start();
    expect(h.engine.note('worker-1', 'orch-1', '  Panasonic is blocked their side.  ')).toEqual({
      ok: true,
    });
    const notes = h.journal.filter((e) => e.kind === 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toBe('Panasonic is blocked their side.');
    expect(notes[0].orchestrationId).toBe('orch-1');
    // The point of storing it as a journal entry rather than a UI annotation:
    // the digest is what the next planning turn reads.
    expect(h.journal.map((e) => `${e.kind}: ${e.note}`)).toContain('note: Panasonic is blocked their side.');
  });

  it('takes two identical notes on one turn as two things the user said', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.orchestrations.set('orch-1', workerBatch({ title: '[Shift 1] Scout' }));
    h.engine.start();
    h.setNow(1_000);
    expect(h.engine.note('worker-1', 'orch-1', 'same').ok).toBe(true);
    h.setNow(2_000);
    expect(h.engine.note('worker-1', 'orch-1', 'same').ok).toBe(true);
    expect(h.journal.filter((e) => e.kind === 'note')).toHaveLength(2);
  });

  it('refuses an empty note, an oversized one, and an unknown worker', () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.orchestrations.set('orch-1', workerBatch({ title: '[Shift 1] Scout' }));
    h.engine.start();
    expect(h.engine.note('worker-1', 'orch-1', '   ')).toEqual({
      ok: false,
      error: 'Write the note first.',
    });
    expect(h.engine.note('worker-1', 'orch-1', 'x'.repeat(601)).ok).toBe(false);
    expect(h.engine.note('nobody', 'orch-1', 'hello').ok).toBe(false);
  });
});

describe('WorkerEngine delivery to the project folder', () => {
  const doneBatch = () =>
    workerBatch({
      items: [
        {
          candidate: {
            id: 'c1',
            title: 'Summarise the course material',
            prompt: 'p',
          },
          flowId: 'fix-it',
          status: 'done',
          runId: 'run-1',
          finishedAt: 10,
        },
      ],
    });

  it('files a finished deliverable into the folder and saves a version', () => {
    publishMock.mockReturnValue({ written: ['Summary.md'] });
    const h = makeHarness({
      seed: [
        seedWorker({
          projectPath: '/documents/Course',
          caps: {
            maxItemsPerShift: 3,
            runIn: 'worktree',
            fileIntoProject: true,
          },
        }),
      ],
      deliverablesFor: () => [{ name: 'Summary.md', body: 'hello' }],
    });
    h.engine.start();
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: doneBatch(),
    });

    expect(publishMock).toHaveBeenCalledWith({
      workerId: 'worker-1',
      projectPath: '/documents/Course',
      runId: 'run-1',
      artifacts: [{ name: 'Summary.md', body: 'hello' }],
    });
    expect(h.checkpoints).toEqual([{ projectPath: '/documents/Course', message: 'Scout added Summary.md' }]);
  });

  it('saves a version when a revision overwrote what was already delivered', () => {
    publishMock.mockReturnValue({ written: [], revised: ['Summary.md'] });
    const h = makeHarness({
      seed: [
        seedWorker({
          projectPath: '/documents/Course',
          caps: { maxItemsPerShift: 3, runIn: 'worktree', fileIntoProject: true },
        }),
      ],
      deliverablesFor: () => [{ name: 'Summary.md', body: 'final' }],
    });
    h.engine.start();
    h.engine.observeEvent({ type: 'orchestrationUpdate', orchestration: doneBatch() });

    expect(h.checkpoints).toEqual([
      { projectPath: '/documents/Course', message: 'Scout updated Summary.md' },
    ]);
  });

  it('saves no version when the deliverable did not land in the folder', () => {
    publishMock.mockReturnValue({ written: [] });
    const h = makeHarness({
      seed: [
        seedWorker({
          caps: {
            maxItemsPerShift: 3,
            runIn: 'worktree',
            fileIntoProject: true,
          },
        }),
      ],
      deliverablesFor: () => [{ name: 'notes.py', body: 'x' }],
    });
    h.engine.start();
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: doneBatch(),
    });
    expect(h.checkpoints).toEqual([]);
  });

  // A run stays alive after its last step: the run pane's composer keeps
  // talking to the participant, and "now turn that into a PDF" writes real
  // files into the run root with no orchestration update behind them.
  it('files again when a chat turn ends on a run that already finished', () => {
    fileDeliverableMock.mockClear();
    const h = makeHarness({
      seed: [seedWorker()],
      deliverablesFor: () => [
        { name: 'Summary.md', body: 'hello' },
        { name: 'Summary.pdf', sourcePath: '/run/Summary.pdf' },
      ],
      runIdForConversation: (conversationId) => (conversationId === ('conv-1' as any) ? ('run-1' as any) : null),
    });
    h.engine.start();
    h.orchestrations.set('orch-1', doneBatch());
    fileDeliverableMock.mockClear();

    h.engine.observeEvent({ type: 'running', conversationId: 'conv-1' as any, isRunning: false });

    expect(fileDeliverableMock).toHaveBeenCalledTimes(1);
    expect(fileDeliverableMock.mock.calls[0][0]).toMatchObject({
      workerId: 'worker-1',
      artifacts: [
        { name: 'Summary.md', body: 'hello' },
        { name: 'Summary.pdf', sourcePath: '/run/Summary.pdf' },
      ],
    });
  });

  it('ignores a turn that ends on a conversation belonging to no worker run', () => {
    fileDeliverableMock.mockClear();
    const h = makeHarness({
      seed: [seedWorker()],
      deliverablesFor: () => [{ name: 'Summary.md', body: 'hello' }],
      runIdForConversation: () => null,
    });
    h.engine.start();
    h.orchestrations.set('orch-1', doneBatch());
    fileDeliverableMock.mockClear();

    h.engine.observeEvent({ type: 'running', conversationId: 'conv-9' as any, isRunning: false });
    expect(fileDeliverableMock).not.toHaveBeenCalled();
  });

  // Mid-flow the step's own turn ends the same way. Filing then would copy a
  // half-finished run root into the cabinet under the finished job's name.
  it('does not file when the run it belongs to is still going', () => {
    fileDeliverableMock.mockClear();
    const h = makeHarness({
      seed: [seedWorker()],
      deliverablesFor: () => [{ name: 'Summary.md', body: 'hello' }],
      runIdForConversation: () => 'run-1' as any,
    });
    h.engine.start();
    const running = doneBatch();
    running.items[0].status = 'running';
    h.orchestrations.set('orch-1', running);

    h.engine.observeEvent({ type: 'running', conversationId: 'conv-1' as any, isRunning: false });
    expect(fileDeliverableMock).not.toHaveBeenCalled();
  });

  it('leaves a worker without the cap filing only to its cabinet', () => {
    publishMock.mockClear();
    const h = makeHarness({
      seed: [seedWorker()],
      deliverablesFor: () => [{ name: 'Summary.md', body: 'hello' }],
    });
    h.engine.start();
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: doneBatch(),
    });
    expect(publishMock).not.toHaveBeenCalled();
    expect(h.checkpoints).toEqual([]);
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
    expect(
      h.journal
        .filter((entry) => entry.title === 'Repair CI spec')
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['approved', 'completed', 'launched', 'proposed']);
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
      h.journal
        .filter((e) => e.id.includes(`:${id}:`))
        .map((e) => e.kind)
        .sort();
    expect(kinds('c1')).toEqual(['proposed']);
    expect(kinds('c2')).toEqual(['approved', 'completed', 'launched', 'proposed']);
    expect(kinds('c3')).toEqual(['proposed', 'rejected']);
    // Rejected titles now feed the dedup filter.
    expect(h.journal.some((e) => e.kind === 'rejected' && e.title === 'Rename the module')).toBe(true);
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
      orchestration: workerBatch({
        items: [{ ...item, status: 'cancelled', finishedAt: 9 }],
      }),
    });
    expect(h.journal.some((e) => e.kind === 'rejected')).toBe(false);
    expect(h.engine.get('worker-1')?.trust).toBe('trusted');
  });

  it('does not journal a rejection for an item a restart settled', () => {
    // The narrow case the `approved` guard above cannot cover: the app died
    // between the item reaching `queued` and the fold that journals it, so
    // there is no `approved` entry to lean on. The item says so itself.
    const h = makeHarness({ seed: [seedWorker({ trust: 'trusted' })] });
    h.engine.start();
    h.engine.observeEvent({
      type: 'orchestrationUpdate',
      orchestration: workerBatch({
        items: [
          {
            candidate: { id: 'c1', title: 'Trim the bundle', prompt: 'p' },
            flowId: 'fix-it',
            status: 'cancelled',
            finishedAt: 9,
            settledByRestart: true,
          },
        ],
      }),
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
      orchestration: workerBatch({
        id: 'orch-1',
        items: rejectedItems(['a', 'b', 'c'], 5),
      }),
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
      producer: {
        prompt: 'p',
        reply: `This needs digging.\n<flow_request>\n${request}\n</flow_request>`,
      },
      items: [],
    });
  }

  it('drafts and launches a flow when the worker asks for one', async () => {
    const calls: Array<{ request: string; errand: string; runIn: string }> = [];
    const h = makeHarness({
      seed: [seedWorker()],
      generatedFlow: async (args) => {
        calls.push({
          request: args.request,
          errand: args.errand,
          runIn: args.runIn,
        });
        return {
          ok: true,
          orchestrationId: 'orch-gen',
          flowId: 'generated-abcd1234',
        };
      },
    });
    h.engine.start();
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 0,
      queued: 0,
      excluded: 0,
    });
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
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 2,
      queued: 0,
      excluded: 0,
    });
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
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 0,
      queued: 0,
      excluded: 0,
    });
    h.orchestrations.set('orch-1', replyRequesting('investigate'));
    const res = await h.engine.runErrand('worker-1', 'big ask');
    expect(res).toEqual({ ok: false, error: 'drafter offline' });
    expect(h.journal.find((e) => e.kind === 'errand')?.note).toContain('drafter offline');
  });
});

describe('WorkerEngine daily errand conversations', () => {
  it("replays only today's thread, oldest first, so same-day follow-ups land", async () => {
    const today = local(2026, 3, 2, 8, 0);
    const h = makeHarness({ seed: [seedWorker()], startAt: today });
    h.engine.start();
    // Two settled errands already on the books, newest last by createdAt.
    for (const [id, ask, reply, at, intent] of [
      ['e1', 'which spec is flaky', 'WOW-4921 is.', today + 1_000, 'chat'],
      ['e2', 'why', 'A race in the fixture.', today + 2_000, 'work'],
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
            intent,
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

  it('starts a fresh thread each day and carries a compact prior-day brief', async () => {
    const today = local(2026, 3, 3, 8, 0);
    const yesterday = local(2026, 3, 2, 15, 0);
    const h = makeHarness({ seed: [seedWorker()], startAt: today });
    h.engine.start();
    h.orchestrations.set(
      'e1',
      workerBatch({
        id: 'e1',
        createdAt: yesterday,
        origin: {
          kind: 'worker',
          workerId: 'worker-1',
          workerName: 'Scout',
          task: 'errand',
          errand: 'which spec is flaky',
          intent: 'chat',
        },
        producer: {
          prompt: 'assembled prompt',
          reply: 'WOW-4921 has a fixture race.',
        },
        items: [],
      }),
    );

    await h.engine.runErrand('worker-1', 'what should I check today');

    expect(h.parked[0].priorTurns).toBeUndefined();
    expect(h.parked[0].prompt).toContain('PREVIOUS CONVERSATION HANDOFF');
    expect(h.parked[0].prompt).toContain('which spec is flaky');
    expect(h.parked[0].prompt).toContain('WOW-4921 has a fixture race.');
  });

  it('carries no thread on the first errand, and ignores shifts', async () => {
    const h = makeHarness({ seed: [seedWorker()] });
    h.engine.start();
    // A worked shift is not something the user said, so it is not a turn.
    h.orchestrations.set(
      's1',
      workerBatch({
        id: 's1',
        producer: { prompt: 'p', reply: 'shift prose' },
        items: [],
      }),
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
    expect(h.parked[0].prompt).toContain(`This shift started at ${new Date(local(2026, 3, 2, 9, 0)).toISOString()}.`);
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
    const saved = h.engine.save({
      ...seed,
      cadence: { kind: 'interval', everyMinutes: 60 },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.worker.lastShiftAt).toBeUndefined();
    expect(saved.worker.lastPlannedAt).toBe(firstShiftAt);

    // The next shift under the new cadence still knows when the last one was.
    await h.advanceTo(local(2026, 3, 2, 11, 0));
    expect(h.parked.length).toBeGreaterThan(1);
    expect(h.parked[1].prompt).toContain(`Your previous shift planned at ${new Date(firstShiftAt).toISOString()}`);
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
    expect(last.prompt).toContain(`Your previous shift planned at ${new Date(local(2026, 3, 2, 9, 0)).toISOString()}`);
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
    expect(res).toEqual({
      ok: false,
      error: 'This worker is mid-shift. Wait for it to finish, then reset.',
    });

    release();
    await shift;
  });

  it('reports an unknown worker rather than clearing nothing quietly', () => {
    const h = makeHarness();
    h.engine.start();
    expect(h.engine.resetMemory('nobody')).toEqual({
      ok: false,
      error: 'Worker not found.',
    });
  });
});

describe('WorkerEngine delegation', () => {
  const CHIEF = 'worker-1';

  function delegationHarness(over: { chief?: Partial<Worker>; roster?: Worker[] } = {}) {
    const chief = seedWorker({
      name: 'Chief of Staff',
      trust: 'autonomous',
      caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
      ...over.chief,
    });
    const triage = seedWorker({
      id: 'triage',
      name: 'Triage',
      jobDescription: 'You are the Ticket Triage Worker. Every weekday morning, find and solve the open tickets.',
      trust: 'trusted',
    });
    const h = makeHarness({ seed: [chief, ...(over.roster ?? [triage])] });
    // A shift that proposed nothing still has item budget for a referral,
    // which is the case the handoff path exists for.
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 0,
      queued: 0,
      excluded: 0,
    });
    return h;
  }

  function seedReply(h: ReturnType<typeof makeHarness>, reply: string): void {
    h.orchestrations.set('orch-1', workerBatch({ producer: { prompt: 'plan the shift', reply } }));
  }

  it('sends a shift handoff on as an errand stamped with the sender', async () => {
    const h = delegationHarness();
    seedReply(h, 'Nothing for me today.\n<handoff to="Triage">RED-6814 bundles six issues. Split it.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    const errand = h.parked.find((p) => p.origin?.kind === 'worker' && p.origin.task === 'errand');
    expect(errand).toBeDefined();
    expect(errand!.origin).toMatchObject({
      workerId: 'triage',
      task: 'errand',
      errand: 'RED-6814 bundles six issues. Split it.',
      from: { workerId: CHIEF, workerName: 'Chief of Staff' },
    });

    const handed = h.journal.find((e) => e.kind === 'delegated');
    expect(handed?.workerId).toBe(CHIEF);
    expect(handed?.note).toContain('Handed to Triage');
    expect(h.journal.find((e) => e.kind === 'shift')?.note).toContain('Handed on to Triage.');
  });

  /// The whole of the depth limit: a worker that cannot see its colleagues
  /// cannot pass the parcel on to them.
  it('does not let an answered question refer work to a colleague', async () => {
    // A referral spends a COLLEAGUE's budget, so it is the one desk outcome
    // you cannot wave away by dismissing a card. Tied to a turn that actually
    // proposed something rather than to one that answered in prose and
    // mentioned a name on the way past.
    const h = delegationHarness({
      roster: [
        seedWorker({
          id: 'triage',
          name: 'Triage',
          trust: 'autonomous',
          caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
        }),
      ],
    });
    h.setParkResult({ ok: true, orchestrationId: 'orch-1', count: 0, queued: 0, excluded: 0 });
    h.orchestrations.set(
      'orch-1',
      workerBatch({
        origin: {
          kind: 'worker',
          workerId: CHIEF,
          workerName: 'Chief of Staff',
          task: 'errand',
          errand: 'What changed?',
        },
        producer: {
          prompt: 'p',
          reply: 'Nothing material. <handoff to="Triage">Look at RED-6814.</handoff>',
        },
        items: [],
      }),
    );
    h.engine.start();
    await h.engine.runErrand(CHIEF, 'What changed?');
    await h.flush();

    expect(h.parked.filter((p) => p.origin?.kind === 'worker' && p.origin.from)).toHaveLength(0);
  });

  it('shows a delegated errand no roster, so referrals cannot chain', async () => {
    const h = delegationHarness({
      roster: [
        seedWorker({
          id: 'triage',
          name: 'Triage',
          trust: 'autonomous',
          caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
        }),
      ],
    });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    const errand = h.parked.find((p) => p.origin?.kind === 'worker' && p.origin.task === 'errand');
    expect(errand!.prompt).not.toContain('YOUR COLLEAGUES');
    expect(errand!.prompt).toContain('A COLLEAGUE — "Chief of Staff"');
    // And it stays out of the manager's desk thread. That conversation is one
    // speaker's; resuming it for a colleague's referral would let this worker
    // read the other half of it.
    expect(errand!.conversationId).toBeUndefined();
    expect(errand!.resumeSessionId).toBeUndefined();
  });

  it('reports a handoff aimed at nobody instead of dropping it', async () => {
    const h = delegationHarness();
    seedReply(h, '<handoff to="Ticket Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked.some((p) => p.origin?.kind === 'worker' && p.origin.task === 'errand')).toBe(false);
    const handed = h.journal.find((e) => e.kind === 'delegated');
    expect(handed?.note).toContain('"Ticket Triage", who is not a colleague');
    expect(h.journal.find((e) => e.kind === 'shift')?.note).toContain('matched no colleague');
  });

  it('never offers, and never reaches, a colleague on another project', async () => {
    const h = delegationHarness({
      roster: [
        seedWorker({
          id: 'triage',
          name: 'Triage',
          projectPath: '/other-workspace',
        }),
      ],
    });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked[0].prompt).not.toContain('YOUR COLLEAGUES');
    expect(h.parked.some((p) => p.origin?.kind === 'worker' && p.origin.task === 'errand')).toBe(false);
  });

  it('gives no roster to a worker without the capability', async () => {
    const h = delegationHarness({
      chief: { caps: { maxItemsPerShift: 3, runIn: 'worktree' } },
    });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked[0].prompt).not.toContain('YOUR COLLEAGUES');
    expect(h.journal.some((e) => e.kind === 'delegated')).toBe(false);
  });

  it('gives no roster to a delegating worker still on probation', async () => {
    const h = delegationHarness({ chief: { trust: 'probation' } });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked[0].prompt).not.toContain('YOUR COLLEAGUES');
    expect(h.journal.some((e) => e.kind === 'delegated')).toBe(false);
  });

  /// A dropped referral must not read, to its author, exactly like a sent one.
  it('drops handoffs past the turn item budget and says so', async () => {
    const h = delegationHarness({
      chief: {
        caps: { maxItemsPerShift: 1, runIn: 'worktree', canDelegate: true },
      },
    });
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 1,
      queued: 0,
      excluded: 0,
    });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked.some((p) => p.origin?.kind === 'worker' && p.origin.task === 'errand')).toBe(false);
    expect(h.journal.find((e) => e.kind === 'shift')?.note).toContain(
      '1 more handoff dropped — no item budget left this turn.',
    );
  });

  it('caps how many colleagues one turn may commission', async () => {
    const h = delegationHarness({
      roster: [
        seedWorker({ id: 'a', name: 'Alpha' }),
        seedWorker({ id: 'b', name: 'Bravo' }),
        seedWorker({ id: 'c', name: 'Charlie' }),
      ],
    });
    seedReply(
      h,
      [
        '<handoff to="Alpha">one</handoff>',
        '<handoff to="Bravo">two</handoff>',
        '<handoff to="Charlie">three</handoff>',
      ].join('\n'),
    );
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.journal.filter((e) => e.kind === 'delegated')).toHaveLength(WORKER_MAX_HANDOFFS_PER_TURN);
  });

  /// Without this the same unresolved finding is re-read and re-sent every
  /// morning, and the receiver has no way to notice: each arrival looks new.
  it('tells the next shift what it already handed over', async () => {
    const h = delegationHarness();
    seedReply(h, '<handoff to="Triage">Split RED-6814 into its six issues.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    h.parked.length = 0;
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    expect(h.parked[0].prompt).toContain('ALREADY HANDED OVER');
    expect(h.parked[0].prompt).toContain('Split RED-6814 into its six issues.');
  });

  /// A narrowing that names a worker who has been deleted or moved is a
  /// narrowing the roster no longer supports. Pruning it to nothing restores
  /// the "any colleague" default, which the editor states in words — the other
  /// reading, "delegates to nobody", would switch delegation off in silence
  /// the day the one chosen colleague was let go.
  it('prunes handoff targets that are gone or have moved project', () => {
    const h = makeHarness({
      seed: [
        seedWorker({ id: 'triage', name: 'Triage' }),
        seedWorker({ id: 'far', name: 'Far', projectPath: '/other' }),
      ],
    });
    h.engine.start();

    const chief = seedWorker({
      id: 'chief',
      name: 'Chief of Staff',
      caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
      delegatesTo: ['triage', 'far', 'deleted'],
    });
    const kept = h.engine.save(chief);
    expect(kept.ok && kept.worker.delegatesTo).toEqual(['triage']);

    const emptied = h.engine.save({
      ...chief,
      delegatesTo: ['far', 'deleted'],
    });
    expect(emptied.ok && emptied.worker.delegatesTo).toBeUndefined();
  });

  /// A referral that died on someone else's spent budget has to be visible
  /// from the sender's desk — otherwise the sender records that it handed the
  /// work over, and nothing ever happens to it.
  it('tells the sender when the receiver cannot take the work', async () => {
    const h = makeHarness({
      seed: [
        seedWorker({
          name: 'Chief of Staff',
          trust: 'autonomous',
          caps: { maxItemsPerShift: 3, runIn: 'worktree', canDelegate: true },
          budgetUSDPerMonth: 1000,
        }),
        seedWorker({
          id: 'triage',
          name: 'Triage',
          trust: 'trusted',
          budgetUSDPerMonth: 1,
        }),
      ],
      spend: 500,
      pool: 100_000,
    });
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-1',
      count: 0,
      queued: 0,
      excluded: 0,
    });
    seedReply(h, '<handoff to="Triage">Look at RED-6814.</handoff>');
    h.engine.start();
    await h.engine.workShiftNow(CHIEF);
    await h.flush();

    const failed = h.journal.find((e) => e.kind === 'delegated' && e.id.endsWith(':failed'));
    expect(failed?.workerId).toBe(CHIEF);
    expect(failed?.note).toContain('Triage could not take it');
    expect(h.notifications.some((n) => n.title.includes('could not take'))).toBe(true);
  });
});

describe('WorkerEngine re-running and deleting one shift', () => {
  /// A worker that has worked one shift, with the batch registered so the
  /// engine can look it up the way the desk's row does.
  async function afterOneShift(opts: { deleted?: string[]; runs?: number } = {}) {
    const deleted = opts.deleted ?? [];
    const h = makeHarness({
      seed: [seedWorker()],
      deleteActivity: (_workerId, orchestrationId) => {
        deleted.push(orchestrationId);
        return { runs: opts.runs ?? 2 };
      },
    });
    h.orchestrations.set('orch-1', workerBatch({ title: '[Shift 1] Scout' }));
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0));
    return { h, deleted };
  }

  it('gives the shift number and the data window back when the latest shift is deleted', async () => {
    const { h, deleted } = await afterOneShift();
    expect(h.engine.get('worker-1')!.shiftCount).toBe(1);

    const res = h.engine.forgetActivity('worker-1', 'orch-1');

    expect(res).toMatchObject({
      ok: true,
      task: 'shift',
      label: 'Shift 1',
      runs: 2,
    });
    expect(deleted).toEqual(['orch-1']);
    // Its journal entries are gone — including the shift note, whose id is
    // built from the number the redo is about to reuse.
    expect(h.journal.some((e) => e.orchestrationId === 'orch-1')).toBe(false);
    expect(h.journal.some((e) => e.id === 'shift-worker-1-1')).toBe(false);
    // Memory this shift did not write is not the delete's to take: the weekly
    // compaction note is a fact about the filing cabinet, not about the shift.
    expect(h.journal.some((e) => e.kind === 'compacted')).toBe(true);
    const w = h.engine.get('worker-1')!;
    expect(w.shiftCount).toBeUndefined();
    expect(w.lastPlannedAt).toBeUndefined();
  });

  it('leaves the clock alone, so a delete cannot trigger an unattended shift', async () => {
    const { h } = await afterOneShift();
    const before = h.engine.get('worker-1')!.lastShiftAt;

    h.engine.forgetActivity('worker-1', 'orch-1');

    expect(h.engine.get('worker-1')!.lastShiftAt).toBe(before);
  });

  it('re-runs the latest shift as the SAME number over the same window', async () => {
    const { h } = await afterOneShift();
    const first = h.parked.length;
    h.orchestrations.set('orch-2', workerBatch({ id: 'orch-2', title: '[Shift 1] Scout' }));
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-2',
      count: 3,
      queued: 0,
      excluded: 0,
    });

    const res = await h.engine.redoShift('worker-1', 'orch-1');

    expect(res).toEqual({ ok: true, shift: 1 });
    expect(h.parked).toHaveLength(first + 1);
    expect(h.parked[first].prompt).toContain('This is your shift #1.');
    expect(h.engine.get('worker-1')!.shiftCount).toBe(1);
    // The re-run's own shift note landed: the deleted one shared its id, and
    // an append that silently deduped against it would leave no record at all.
    expect(h.journal.filter((e) => e.kind === 'shift' && e.orchestrationId === 'orch-2')).toHaveLength(1);
  });

  it('refuses to re-run anything but the most recent shift', async () => {
    const { h, deleted } = await afterOneShift();
    // A second shift makes the first one history — its number cannot come back.
    h.orchestrations.set('orch-2', workerBatch({ id: 'orch-2', title: '[Shift 2] Scout' }));
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-2',
      count: 3,
      queued: 0,
      excluded: 0,
    });
    await h.advanceTo(local(2026, 3, 3, 9, 0));
    expect(h.engine.get('worker-1')!.shiftCount).toBe(2);

    const res = await h.engine.redoShift('worker-1', 'orch-1');

    expect(res).toEqual({
      ok: false,
      error: 'Only the most recent shift can be re-run — an older one cannot have its number back.',
    });
    // Nothing was removed on the way to refusing.
    expect(deleted).toEqual([]);
    expect(h.journal.some((e) => e.orchestrationId === 'orch-1')).toBe(true);
  });

  it('keeps numbering when an older shift is deleted, and only forgets that one', async () => {
    const { h } = await afterOneShift();
    h.orchestrations.set('orch-2', workerBatch({ id: 'orch-2', title: '[Shift 2] Scout' }));
    h.setParkResult({
      ok: true,
      orchestrationId: 'orch-2',
      count: 3,
      queued: 0,
      excluded: 0,
    });
    await h.advanceTo(local(2026, 3, 3, 9, 0));

    const res = h.engine.forgetActivity('worker-1', 'orch-1');

    expect(res).toMatchObject({ ok: true, shiftGivenBack: null });
    expect(h.engine.get('worker-1')!.shiftCount).toBe(2);
    expect(h.journal.some((e) => e.orchestrationId === 'orch-1')).toBe(false);
    expect(h.journal.some((e) => e.orchestrationId === 'orch-2')).toBe(true);
  });

  it('refuses a batch that belongs to somebody else', async () => {
    const { h, deleted } = await afterOneShift();
    h.orchestrations.set(
      'orch-9',
      workerBatch({
        id: 'orch-9',
        origin: { kind: 'worker', workerId: 'worker-2', workerName: 'Warden' },
      }),
    );

    expect(h.engine.forgetActivity('worker-1', 'orch-9')).toEqual({
      ok: false,
      error: 'That turn belongs to a different worker.',
    });
    expect(deleted).toEqual([]);
  });

  it('deletes nothing when the journal rewrite fails', async () => {
    const { h, deleted } = await afterOneShift();
    const engine = h.engine as unknown as {
      journal: { remove: (...args: unknown[]) => number };
    };
    engine.journal.remove = () => {
      throw new Error('read-only file system');
    };

    expect(h.engine.forgetActivity('worker-1', 'orch-1')).toEqual({
      ok: false,
      error: 'read-only file system',
    });
    // The irreversible half never ran, so the same delete can be retried.
    expect(deleted).toEqual([]);
    expect(h.engine.get('worker-1')!.shiftCount).toBe(1);
  });

  it('forgetActivity deletes filed deliverables', async () => {
    deleteDeliverableMock.mockReturnValueOnce({ removed: 1 });
    const { h } = await afterOneShift();
    h.orchestrations.set(
      'orch-1',
      workerBatch({
        title: '[Shift 1] Scout',
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
    );

    const res = h.engine.forgetActivity('worker-1', 'orch-1');

    expect(res).toMatchObject({ ok: true });
    expect((res as { files: number }).files).toBeGreaterThan(0);
  });
});
