import { describe, expect, it, vi } from 'vitest';

// The store persists to <userData>/schedules via electron's app.getPath.
// Stub it so the engine runs without electron/fs; the harness injects its own
// in-memory store anyway, but the module-level import still has to resolve.
vi.mock('./schedulesStore', () => ({
  saveSchedule: vi.fn(),
  loadAllSchedules: vi.fn(() => []),
  deleteSchedule: vi.fn(),
}));

import { SchedulerEngine, type ProposalParker } from './scheduler';
import type { FlowLauncher } from './orchestrator';
import type { FlowRun } from '../../shared/flows/schema';
import { SCHEDULE_GRACE_MS, type Schedule } from '../../shared/flows/schedule';

function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

/// Drives the engine with a hand-cranked clock and timer. `advanceTo` is the
/// only way time moves, so nothing here depends on real wall-clock timing.
function makeHarness(opts: { seed?: Schedule[]; startAt?: number; isGitRepo?: boolean } = {}) {
  let now = opts.startAt ?? local(2026, 3, 2, 8, 0);
  const runs = new Map<string, FlowRun>();
  let counter = 0;
  const started: Array<{
    runId: string;
    flowId: string;
    prompt: string;
    scheduleId?: string;
    runIn?: string;
    baseBranch?: string;
  }> = [];
  const parked: Array<{ scheduleId: string; prompt: string; runIn?: string }> = [];
  const notifications: Array<{ title: string; body: string }> = [];
  const emitted: any[] = [];
  const saved: Schedule[] = [];
  let parkResult: { ok: true; orchestrationId: string; count: number } | { ok: false; error: string } =
    { ok: true, orchestrationId: 'orch-1', count: 3 };
  let startResult: { ok: boolean; error?: string } = { ok: true };

  // One pending timer at a time — the engine is documented to hold exactly
  // one, so the harness asserts that by construction.
  let pending: { at: number; fn: () => void } | null = null;

  const launcher: FlowLauncher = {
    async startRun(args) {
      if (!startResult.ok) return { ok: false, error: startResult.error ?? 'nope' };
      const runId = `run-${++counter}`;
      runs.set(runId, {
        id: runId,
        flowId: args.flowId,
        state: { kind: 'running', currentStepId: 's1' },
        flowSnapshot: { name: args.flowId },
        scheduleId: args.scheduleId,
      } as unknown as FlowRun);
      started.push({
        runId,
        flowId: args.flowId,
        prompt: args.userPrompt,
        scheduleId: args.scheduleId,
        runIn: args.runIn,
        baseBranch: args.baseBranch,
      });
      return { ok: true, runId };
    },
    abortRun({ runId }) {
      const run = runs.get(runId);
      if (run) run.state = { kind: 'aborted' };
      return { ok: true };
    },
    getRun: (runId) => runs.get(runId) ?? null,
  };

  const parker: ProposalParker = {
    async parkProposal(args) {
      parked.push({ scheduleId: args.scheduleId, prompt: args.prompt, runIn: args.runIn });
      return parkResult;
    },
  };

  const engine = new SchedulerEngine({
    launcher,
    parker,
    isGitRepo: () => opts.isGitRepo ?? true,
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
      save: (s) => saved.push(structuredClone(s)),
      remove: () => {},
    },
  });

  /// Move the clock to `t`, running any timer that comes due on the way.
  /// Loops because firing rearms, and a rearm can itself be due immediately.
  /// The guard is generous because the engine caps each sleep at 60s, so
  /// crossing a day is ~1440 wakeups — walking all of them is the point, since
  /// it's exactly what the real engine does overnight.
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

  /// The engine's tick is async (it awaits startRun); drain the microtask
  /// queue so its continuations land. Microtasks rather than a macrotask
  /// because this runs on every simulated wakeup — a `setTimeout(0)` here
  /// makes crossing a day take seconds of real time.
  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  /// Drive a run the engine started to a terminal state, as the runtime would.
  function finishRun(runId: string, success = true): void {
    const run = runs.get(runId)!;
    run.state = success ? { kind: 'done', success: true } : { kind: 'aborted' };
    engine.onRunUpdate(run);
  }

  return {
    engine,
    started,
    parked,
    notifications,
    emitted,
    saved,
    runs,
    finishRun,
    advanceTo,
    flush,
    setNow: (t: number) => {
      now = t;
    },
    getNow: () => now,
    setParkResult: (r: typeof parkResult) => {
      parkResult = r;
    },
    setStartResult: (r: typeof startResult) => {
      startResult = r;
    },
    hasTimer: () => pending !== null,
  };
}

function seedSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Morning triage',
    enabled: true,
    projectPath: '/repo',
    target: { kind: 'flow', flowId: 'fix-it', prompt: 'do the thing', runIn: 'worktree' },
    trigger: { kind: 'daily', time: '09:00' },
    onOverlap: 'skip',
    catchUp: 'skip',
    createdAt: local(2026, 3, 2, 7, 0),
    history: [],
    ...over,
  };
}

describe('SchedulerEngine firing', () => {
  it('launches a flow run when the schedule comes due', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    expect(h.started).toHaveLength(0);

    await h.advanceTo(local(2026, 3, 2, 9, 0) + 1000);

    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({
      flowId: 'fix-it',
      prompt: 'do the thing',
      scheduleId: 'sched-1',
    });
  });

  it('does not fire twice for one occurrence', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0) + 1000);
    h.finishRun(h.started[0].runId);
    // Walk through the rest of the day a wakeup at a time.
    await h.advanceTo(local(2026, 3, 2, 23, 59));
    expect(h.started).toHaveLength(1);
  });

  it('fires again on the next day', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0) + 1000);
    h.finishRun(h.started[0].runId);
    await h.advanceTo(local(2026, 3, 3, 9, 0) + 1000);
    expect(h.started).toHaveLength(2);
  });

  it('holds no timer at all when nothing is enabled', () => {
    const h = makeHarness({ seed: [seedSchedule({ enabled: false })] });
    h.engine.start();
    expect(h.hasTimer()).toBe(false);
  });

  it('records a failed launch and notifies instead of wedging', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.setStartResult({ ok: false, error: 'Preflight failed: claude is not signed in.' });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0) + 1000);

    const s = h.engine.get('sched-1')!;
    expect(s.history[0]).toMatchObject({ outcome: 'failed' });
    expect(s.history[0].note).toMatch(/not signed in/);
    expect(s.activeRunId).toBeUndefined();
    expect(h.notifications[0].title).toMatch(/failed to start/i);
  });
});

describe('SchedulerEngine non-git targets', () => {
  it('runs in the project tree when there is no repo to fork', async () => {
    // Plenty of scheduled work — pull the overnight numbers, sync a tracker —
    // targets a plain directory and touches external systems. Refusing it
    // because the target defaults to `worktree` would be pedantry.
    const h = makeHarness({
      seed: [
        seedSchedule({
          target: {
            kind: 'flow',
            flowId: 'pull-metrics',
            prompt: 'pull last night’s numbers',
            runIn: 'worktree',
            baseBranch: 'main',
          },
        }),
      ],
      isGitRepo: false,
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));

    expect(h.started).toHaveLength(1);
    expect(h.started[0].runIn).toBe('cwd');
    // And no stale base branch rides along into a run that isn't forking.
    expect(h.started[0].baseBranch).toBeUndefined();
  });

  it('still isolates in a worktree when the project is a repo', async () => {
    const h = makeHarness({ seed: [seedSchedule()], isGitRepo: true });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.started[0].runIn).toBe('worktree');
  });

  it('degrades an orchestrate target the same way', async () => {
    const h = makeHarness({
      seed: [
        seedSchedule({
          target: {
            kind: 'orchestrate',
            prompt: 'triage the queue',
            flowId: 'small-fix',
            runIn: 'worktree',
            maxConcurrent: 2,
          },
        }),
      ],
      isGitRepo: false,
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.parked[0].runIn).toBe('cwd');
  });
});

describe('SchedulerEngine catch-up', () => {
  it('skips occurrences missed while the app was closed', async () => {
    // Boot at 2pm on the 4th: the 9am slots on the 2nd, 3rd and 4th all passed.
    const h = makeHarness({
      seed: [seedSchedule({ catchUp: 'skip' })],
      startAt: local(2026, 3, 4, 14, 0),
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 14, 1));

    expect(h.started).toHaveLength(0);
    const s = h.engine.get('sched-1')!;
    expect(s.history[0]).toMatchObject({ outcome: 'skipped' });
    expect(s.history[0].note).toMatch(/closed/i);
    // And it doesn't keep skipping the same slot on every wakeup.
    await h.advanceTo(local(2026, 3, 4, 20, 0));
    expect(s.history.filter((entry) => entry.outcome === 'skipped')).toHaveLength(1);
  });

  it('coalesces three missed mornings into one catch-up run', async () => {
    const h = makeHarness({
      seed: [seedSchedule({ catchUp: 'once' })],
      startAt: local(2026, 3, 4, 14, 0),
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 4, 14, 1));

    expect(h.started).toHaveLength(1);
    expect(h.engine.get('sched-1')!.history[0].note).toMatch(/catch-up/i);
    // Nothing further until tomorrow's real slot.
    h.finishRun(h.started[0].runId);
    await h.advanceTo(local(2026, 3, 4, 23, 59));
    expect(h.started).toHaveLength(1);
  });

  it('treats a firing inside the grace window as on time, not a catch-up', async () => {
    const h = makeHarness({ seed: [seedSchedule({ catchUp: 'skip' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 0) + SCHEDULE_GRACE_MS - 1000);
    expect(h.started).toHaveLength(1);
    expect(h.engine.get('sched-1')!.history[0].note).toBeUndefined();
  });
});

describe('SchedulerEngine overlap', () => {
  /// Hourly, anchored so the first firing lands at 9:00 — the harness clock
  /// starts at 8:00, and an anchor already in the past would fire the instant
  /// the engine starts and muddle the counts below.
  const hourly = (over: Partial<Schedule> = {}) =>
    seedSchedule({
      trigger: { kind: 'interval', everyMinutes: 60 },
      createdAt: local(2026, 3, 2, 8, 0),
      ...over,
    });

  it('skips the occurrence when the previous run is still going', async () => {
    const h = makeHarness({ seed: [hourly({ onOverlap: 'skip' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.started).toHaveLength(1); // run 1, still running

    await h.advanceTo(local(2026, 3, 2, 10, 1));
    expect(h.started).toHaveLength(1);
    expect(h.engine.get('sched-1')!.history[0]).toMatchObject({ outcome: 'skipped' });
  });

  it('queues at most one deferred firing and runs it when the tree frees up', async () => {
    const h = makeHarness({ seed: [hourly({ onOverlap: 'queue' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.started).toHaveLength(1);

    // Two occurrences pass while run 1 is still going.
    await h.advanceTo(local(2026, 3, 2, 11, 1));
    expect(h.started).toHaveLength(1);
    expect(h.engine.get('sched-1')!.pendingSince).toBeDefined();

    h.finishRun(h.started[0].runId);
    await h.flush();
    // Exactly one make-up run, not two.
    expect(h.started).toHaveLength(2);
    expect(h.engine.get('sched-1')!.pendingSince).toBeUndefined();
  });

  it('aborts the in-flight run and relaunches under the replace policy', async () => {
    const h = makeHarness({ seed: [hourly({ onOverlap: 'replace' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    const first = h.started[0].runId;

    await h.advanceTo(local(2026, 3, 2, 10, 1));
    expect(h.started).toHaveLength(2);
    expect(h.runs.get(first)!.state.kind).toBe('aborted');
  });

  it('un-wedges itself when a run ended without the engine seeing the update', async () => {
    const h = makeHarness({ seed: [hourly({ onOverlap: 'skip' })] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    // Terminal on the runtime, but onRunUpdate never arrives (crash, restart,
    // dropped observer). The busy check reads through, so the next occurrence
    // must still fire rather than skipping forever.
    h.runs.get(h.started[0].runId)!.state = { kind: 'done', success: true } as any;

    await h.advanceTo(local(2026, 3, 2, 10, 1));
    expect(h.started).toHaveLength(2);
  });
});

describe('SchedulerEngine run lifecycle', () => {
  it('collapses the launched entry into the terminal one and notifies', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    h.finishRun(h.started[0].runId, true);

    const s = h.engine.get('sched-1')!;
    expect(s.history).toHaveLength(1);
    expect(s.history[0]).toMatchObject({ outcome: 'done', runId: h.started[0].runId });
    expect(s.activeRunId).toBeUndefined();
    expect(h.notifications.at(-1)!.title).toMatch(/finished/i);
  });

  it('marks an aborted run failed', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    h.finishRun(h.started[0].runId, false);

    expect(h.engine.get('sched-1')!.history[0]).toMatchObject({ outcome: 'failed' });
    expect(h.notifications.at(-1)!.title).toMatch(/did not finish/i);
  });

  it('ignores runs it did not launch', () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    h.engine.onRunUpdate({
      id: 'someone-elses-run',
      state: { kind: 'done', success: true },
      flowSnapshot: { name: 'other' },
    } as unknown as FlowRun);
    expect(h.engine.get('sched-1')!.history).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });
});

describe('SchedulerEngine orchestrate targets', () => {
  // A function, not a shared constant: the engine mutates the schedule it was
  // handed (lastFiredAt, history), so a constant would leak state between
  // these tests and the second one would never come due.
  const orchestrateSeed = () =>
    seedSchedule({
      target: {
        kind: 'orchestrate',
        prompt: 'pull new feedback and triage it',
        flowId: 'small-fix',
        runIn: 'worktree',
        maxConcurrent: 2,
      },
    });

  it('parks a proposal and never launches a run itself', async () => {
    const h = makeHarness({ seed: [orchestrateSeed()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));

    expect(h.parked).toHaveLength(1);
    expect(h.started).toHaveLength(0);
    const s = h.engine.get('sched-1')!;
    expect(s.history[0]).toMatchObject({ outcome: 'done', orchestrationId: 'orch-1' });
    expect(s.history[0].note).toMatch(/waiting for approval/i);
    expect(h.notifications[0].body).toMatch(/3 candidates waiting/i);
  });

  it('says so plainly when the producer found nothing', async () => {
    const h = makeHarness({ seed: [orchestrateSeed()] });
    h.setParkResult({ ok: true, orchestrationId: 'orch-2', count: 0 });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.notifications[0].body).toMatch(/nothing new/i);
  });

  it('records a producer failure', async () => {
    const h = makeHarness({ seed: [orchestrateSeed()] });
    h.setParkResult({ ok: false, error: 'No CLI is signed in.' });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    expect(h.engine.get('sched-1')!.history[0]).toMatchObject({ outcome: 'failed' });
  });
});

describe('SchedulerEngine editing', () => {
  it('re-anchors an interval on save so an edit does not fire immediately', () => {
    const h = makeHarness({
      seed: [
        seedSchedule({
          trigger: { kind: 'interval', everyMinutes: 60 },
          createdAt: local(2026, 3, 1, 0, 0),
        }),
      ],
    });
    h.engine.start();
    const existing = h.engine.get('sched-1')!;
    const res = h.engine.save({ ...existing, trigger: { kind: 'interval', everyMinutes: 30 } });
    expect(res.ok).toBe(true);
    expect(h.engine.nextFireAt('sched-1')).toBe(h.getNow() + 30 * 60_000);
  });

  it('re-anchors on re-enable so a long-disabled schedule does not owe a run', () => {
    const h = makeHarness({
      seed: [
        seedSchedule({
          enabled: false,
          trigger: { kind: 'interval', everyMinutes: 60 },
          createdAt: local(2026, 3, 1, 0, 0),
        }),
      ],
    });
    h.engine.start();
    h.engine.setEnabled('sched-1', true);
    expect(h.engine.nextFireAt('sched-1')).toBe(h.getNow() + 60 * 60_000);
  });

  it('rejects an invalid schedule with the editor’s own message', () => {
    const h = makeHarness();
    h.engine.start();
    const res = h.engine.save({
      name: '',
      enabled: true,
      projectPath: '/repo',
      target: { kind: 'flow', flowId: 'f', prompt: 'p', runIn: 'cwd' },
      trigger: { kind: 'daily', time: '09:00' },
      onOverlap: 'skip',
      catchUp: 'skip',
    });
    expect(res).toMatchObject({ ok: false });
  });

  it('stops firing once deleted, and leaves its run alone', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1));
    const runId = h.started[0].runId;

    h.engine.remove('sched-1');
    expect(h.engine.get('sched-1')).toBeNull();
    expect(h.runs.get(runId)!.state.kind).toBe('running');

    await h.advanceTo(local(2026, 3, 3, 9, 1));
    expect(h.started).toHaveLength(1);
  });

  it('runNow fires immediately and says so in the history', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.engine.runNow('sched-1');
    expect(h.started).toHaveLength(1);
    expect(h.engine.get('sched-1')!.history[0].note).toMatch(/run now/i);
  });

  it('runNow leaves the cadence alone', async () => {
    // The point of Run now is checking a schedule does what you think before
    // trusting it unattended. If it shunted the next firing out by a full
    // interval, testing an hourly schedule at 8:59 would silently cost you
    // the 9am run you were trying to verify.
    const h = makeHarness({
      seed: [
        seedSchedule({
          trigger: { kind: 'interval', everyMinutes: 60 },
          createdAt: local(2026, 3, 2, 8, 0),
        }),
      ],
    });
    h.engine.start();
    const before = h.engine.nextFireAt('sched-1');
    expect(before).toBe(local(2026, 3, 2, 9, 0));

    // Halfway through the interval — the clock has to move, or stamping
    // lastFiredAt lands on the same anchor and hides the bug.
    h.setNow(local(2026, 3, 2, 8, 30));
    await h.engine.runNow('sched-1');

    expect(h.engine.nextFireAt('sched-1')).toBe(before);
  });

  it('runNow does not swallow a firing that overlap:queue deferred', async () => {
    const h = makeHarness({
      seed: [
        seedSchedule({
          trigger: { kind: 'interval', everyMinutes: 60 },
          createdAt: local(2026, 3, 2, 8, 0),
          onOverlap: 'queue',
        }),
      ],
    });
    h.engine.start();
    await h.advanceTo(local(2026, 3, 2, 9, 1)); // run 1 launches, still going
    await h.advanceTo(local(2026, 3, 2, 10, 1)); // 10:00 slot defers
    expect(h.engine.get('sched-1')!.pendingSince).toBeDefined();

    // Finish the run, then hit Run now before the deferred firing gets its
    // turn. The manual run must not eat the one the schedule still owes.
    h.finishRun(h.started[0].runId);
    await h.flush();
    expect(h.started).toHaveLength(2); // the deferred firing
  });

  it('runNow refuses to double-launch while its own launch is still resolving', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    // Don't await the first — fire two at once, as an impatient double-click
    // on the button would.
    const a = h.engine.runNow('sched-1');
    const b = h.engine.runNow('sched-1');
    const [ra, rb] = await Promise.all([a, b]);

    expect(h.started).toHaveLength(1);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
  });

  it('runNow refuses while a run from the same schedule is going', async () => {
    const h = makeHarness({ seed: [seedSchedule()] });
    h.engine.start();
    await h.engine.runNow('sched-1');
    const res = await h.engine.runNow('sched-1');
    expect(res).toMatchObject({ ok: false });
  });
});
