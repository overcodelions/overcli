import { describe, expect, it, vi } from 'vitest';

// The store persists to <userData>/orchestrations via electron's app.getPath.
// Stub the store module so the engine runs without electron/fs.
vi.mock('./orchestrationsStore', () => ({
  saveOrchestration: vi.fn(),
  loadAllOrchestrations: vi.fn(() => []),
  deleteOrchestration: vi.fn(),
}));
// Health probing executes backend binaries — stub it so propose()'s backend
// pick is deterministic (not exercised here, but keeps imports cheap).
vi.mock('../health', () => ({
  probeBackendHealth: async () => ({ kind: 'ready' }),
  healthyBackends: async () => new Set(['claude', 'codex', 'gemini', 'copilot', 'ollama']),
}));

import { OrchestratorImpl, type FlowLauncher } from './orchestrator';
import type { FlowRun } from '../../shared/flows/schema';

/// A fake launcher that records start calls and lets the test drive each
/// child run to a terminal state by hand — modelling the runtime's async
/// completion without spawning anything.
///
/// `producerReply` stands in for the producer turn's output — supply it when
/// the test exercises propose/park, which are the only paths that reach the
/// runner.
function makeHarness(opts: { producerReply?: string } = {}) {
  const runs = new Map<string, FlowRun>();
  let counter = 0;
  const started: Array<{
    runId: string;
    prompt: string;
    flowId: string;
    runIn?: string;
    baseBranch?: string;
    workerId?: string;
    workerName?: string;
  }> = [];

  const emitted: any[] = [];
  /// Every args object the producer handed to runner.oneShot, so a test can
  /// assert how the turn was budgeted.
  const oneShotCalls: any[] = [];
  let observer: ((run: FlowRun) => void) | null = null;

  const launcher: FlowLauncher = {
    async startRun(args) {
      const runId = `run-${++counter}`;
      const run = {
        id: runId,
        flowId: args.flowId,
        userPrompt: args.userPrompt,
        state: { kind: 'running', currentStepId: 's1' },
        branchName: `agent/${runId}`,
        parentOrchestrationId: args.parentOrchestrationId,
      } as unknown as FlowRun;
      runs.set(runId, run);
      started.push({
        runId,
        prompt: args.userPrompt,
        flowId: args.flowId,
        runIn: args.runIn,
        baseBranch: args.baseBranch,
        workerId: args.workerId,
        workerName: args.workerName,
      });
      return { ok: true, runId };
    },
    abortRun({ runId }) {
      const run = runs.get(runId);
      if (run) {
        (run as any).state = { kind: 'aborted' };
        observer?.(run);
      }
      return { ok: true };
    },
    getRun(runId) {
      return runs.get(runId) ?? null;
    },
  };

  const engine = new OrchestratorImpl(
    // runner — unused by the dispatch path, stubbed for the producer path.
    {
      oneShot: async (a: any) => {
        oneShotCalls.push(a);
        return { ok: true, text: opts.producerReply ?? '<candidates>[]</candidates>' };
      },
    } as any,
    launcher,
    (e) => emitted.push(e),
    () => [{ id: 'p', name: 'proj', path: '/proj' } as any],
    () => ({ backendPaths: {}, disabledBackends: {}, preferredBackend: 'claude' }) as any,
  );
  // The runtime calls the observer on every run update; wire the fake to it.
  observer = (run) => engine.onRunUpdate(run);

  // onRunUpdate fires pump() fire-and-forget (`void this.pump()`), which
  // awaits the async startRun. Flush microtasks so the follow-on launch has
  // landed before the test asserts.
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const finish = async (runId: string, kind: 'done' | 'aborted' = 'done') => {
    const run = runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    (run as any).state = kind === 'done' ? { kind: 'done', success: true } : { kind: 'aborted' };
    observer!(run);
    await flush();
  };
  /// Drive a run to an arbitrary non-terminal state (paused / running-again).
  const transition = async (runId: string, state: any) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`no run ${runId}`);
    (run as any).state = state;
    observer!(run);
    await flush();
  };

  return { engine, launcher, started, runs, finish, transition, emitted, oneShotCalls, flush };
}

function items(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    candidate: { id: `c${i}`, title: `Ask ${i}`, prompt: `do ${i}` },
    flowId: 'flow-a',
  }));
}

describe('OrchestratorImpl dispatch', () => {
  it('never launches more than maxConcurrent at once, and pumps as runs finish', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 2,
      items: items(5),
    });
    expect(res.ok).toBe(true);

    // Cap is 2 → only 2 launched up front.
    expect(h.started).toHaveLength(2);

    // Finish one → exactly one more pumps in (back to 2 in flight).
    await h.finish('run-1');
    expect(h.started).toHaveLength(3);

    await h.finish('run-2');
    expect(h.started).toHaveLength(4);

    await h.finish('run-3');
    expect(h.started).toHaveLength(5); // last item launched

    // No more items to pump.
    await h.finish('run-4');
    await h.finish('run-5');
    expect(h.started).toHaveLength(5);

    const o = h.engine.list()[0];
    expect(o.items.every((i) => i.status === 'done')).toBe(true);
    expect(o.completedAt).toBeGreaterThan(0);
  });

  it('records branch + status on completion and marks aborted runs failed', async () => {
    const h = makeHarness();
    await h.engine.startBatch({ title: 'b', projectPath: '/proj', maxConcurrent: 1, items: items(2) });
    expect(h.started).toHaveLength(1);

    await h.finish('run-1', 'done');
    let o = h.engine.list()[0];
    expect(o.items[0].status).toBe('done');
    expect(o.items[0].branchName).toBe('agent/run-1');

    // Second item launched after the first finished; abort it.
    expect(h.started).toHaveLength(2);
    await h.finish('run-2', 'aborted');
    o = h.engine.list()[0];
    expect(o.items[1].status).toBe('failed');
    expect(o.completedAt).toBeGreaterThan(0);
  });

  it('abort cancels queued items and aborts running ones', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 2,
      items: items(5),
    });
    const id = (res as { orchestrationId: string }).orchestrationId;
    expect(h.started).toHaveLength(2);

    h.engine.abort({ id });
    const o = h.engine.get(id)!;
    // 2 were running → failed; 3 queued → cancelled.
    expect(o.items.filter((i) => i.status === 'failed')).toHaveLength(2);
    expect(o.items.filter((i) => i.status === 'cancelled')).toHaveLength(3);
    expect(o.completedAt).toBeGreaterThan(0);
  });

  it('abort settles paused items so the batch completes and can be cleared', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 1,
      items: items(3),
    });
    const id = (res as { orchestrationId: string }).orchestrationId;

    // run-1 parks at a checkpoint (frees the slot → run-2 pumps), so the batch
    // has a paused item + a running one + a queued one when we abort.
    await h.transition('run-1', { kind: 'paused', nextStepId: 's2', reason: 'preStep' });
    let o = h.engine.get(id)!;
    expect(o.items[0].status).toBe('paused');
    expect(o.completedAt).toBeUndefined();

    h.engine.abort({ id });
    o = h.engine.get(id)!;
    // paused → cancelled, running → failed, queued → cancelled. Nothing left
    // non-terminal, so the batch completes and the UI can show "Clear".
    expect(o.items[0].status).toBe('cancelled'); // was paused
    expect(o.items.some((i) => i.status === 'failed')).toBe(true); // was running
    expect(o.items.every((i) => i.status === 'failed' || i.status === 'cancelled')).toBe(true);
    expect(o.completedAt).toBeGreaterThan(0);
  });

  it('a paused item frees its slot, pumps the next, then resumes + finishes', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 1,
      items: items(3),
    });
    const id = (res as { orchestrationId: string }).orchestrationId;
    expect(h.started).toHaveLength(1); // cap 1 → only run-1 up

    // run-1 hits a pause_before step → parks. The slot frees, so run-2 pumps.
    await h.transition('run-1', { kind: 'paused', nextStepId: 's2', reason: 'preStep' });
    let o = h.engine.get(id)!;
    expect(o.items[0].status).toBe('paused');
    expect(h.started).toHaveLength(2); // run-2 launched despite cap 1
    expect(o.completedAt).toBeUndefined(); // paused is NOT terminal

    // User continues run-1 → back to running (display), still tracked.
    await h.transition('run-1', { kind: 'running', currentStepId: 's2' });
    o = h.engine.get(id)!;
    expect(o.items[0].status).toBe('running');

    // run-1 finishes → routes correctly even though run-2 launched meanwhile.
    await h.finish('run-1', 'done');
    o = h.engine.get(id)!;
    expect(o.items[0].status).toBe('done');

    // Finish the rest.
    await h.finish('run-2', 'done');
    expect(h.started).toHaveLength(3);
    await h.finish('run-3', 'done');
    o = h.engine.get(id)!;
    expect(o.items.every((i) => i.status === 'done')).toBe(true);
    expect(o.completedAt).toBeGreaterThan(0);
  });

  it('retries a failed item — re-queues, relaunches, and reactivates the batch', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 2,
      items: items(2),
    });
    const id = (res as { orchestrationId: string }).orchestrationId;

    await h.finish('run-1', 'aborted'); // → failed
    await h.finish('run-2', 'done');
    let o = h.engine.get(id)!;
    expect(o.items[0].status).toBe('failed');
    expect(o.completedAt).toBeGreaterThan(0);
    const startedBefore = h.started.length; // 2

    // Retry just the failed one.
    const r = h.engine.retry({ id, candidateId: 'c0' });
    expect(r.ok).toBe(true);
    await h.flush();
    o = h.engine.get(id)!;
    // It relaunched (a 3rd start) and the batch is active again.
    expect(h.started.length).toBe(startedBefore + 1);
    expect(o.items[0].status).toBe('running');
    expect(o.completedAt).toBeUndefined();

    // And it can complete normally on the retry.
    await h.finish('run-3', 'done');
    o = h.engine.get(id)!;
    expect(o.items.every((i) => i.status === 'done')).toBe(true);
  });

  it('retry with no failed items is a no-op error', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 2,
      items: items(1),
    });
    const id = (res as { orchestrationId: string }).orchestrationId;
    await h.finish('run-1', 'done');
    expect(h.engine.retry({ id }).ok).toBe(false);
  });

  it('rejects a batch with no items', async () => {
    const h = makeHarness();
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 2,
      items: [],
    });
    expect(res.ok).toBe(false);
  });

  it('emits an orchestrationUpdate on launch and on each completion', async () => {
    const h = makeHarness();
    await h.engine.startBatch({ title: 'b', projectPath: '/proj', maxConcurrent: 1, items: items(1) });
    const updatesBefore = h.emitted.filter((e) => e.type === 'orchestrationUpdate').length;
    expect(updatesBefore).toBeGreaterThan(0);
    await h.finish('run-1');
    const updatesAfter = h.emitted.filter((e) => e.type === 'orchestrationUpdate').length;
    expect(updatesAfter).toBeGreaterThan(updatesBefore);
  });
});

describe('OrchestratorImpl runIn', () => {
  it('defaults to a worktree per item, forked from the batch base branch', async () => {
    const h = makeHarness();
    await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      baseBranch: 'main',
      maxConcurrent: 2,
      items: items(2),
    });
    expect(h.started.map((s) => s.runIn)).toEqual(['worktree', 'worktree']);
    expect(h.started.map((s) => s.baseBranch)).toEqual(['main', 'main']);
  });

  it('launches cwd items in the project tree, with no base branch to fork from', async () => {
    const h = makeHarness();
    // A base branch is meaningless in the main tree — it must not leak through
    // to the launch even when the caller sends one.
    await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      runIn: 'cwd',
      baseBranch: 'main',
      maxConcurrent: 1,
      items: items(1),
    });
    expect(h.started[0].runIn).toBe('cwd');
    expect(h.started[0].baseBranch).toBeUndefined();
  });

  it('serializes a cwd batch even when the caller asks for concurrency', async () => {
    const h = makeHarness();
    // Two agents in one working tree would edit the same files underneath each
    // other, so the cap is overruled to 1 no matter what was requested.
    const res = await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      runIn: 'cwd',
      maxConcurrent: 4,
      items: items(3),
    });
    expect(res.ok).toBe(true);

    expect(h.started).toHaveLength(1);
    await h.finish('run-1');
    expect(h.started).toHaveLength(2);
    await h.finish('run-2');
    expect(h.started).toHaveLength(3);

    const o = h.engine.list()[0];
    expect(o.maxConcurrent).toBe(1);
    expect(o.runIn).toBe('cwd');
  });

  it('keeps a retried cwd item in the project tree', async () => {
    const h = makeHarness();
    await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      runIn: 'cwd',
      maxConcurrent: 1,
      items: items(1),
    });
    await h.finish('run-1', 'aborted');

    const o = h.engine.list()[0];
    expect(h.engine.retry({ id: o.id }).ok).toBe(true);
    await h.flush();

    expect(h.started).toHaveLength(2);
    expect(h.started[1].runIn).toBe('cwd');
  });

  it('treats a batch persisted before runIn existed as a worktree batch', async () => {
    const h = makeHarness();
    await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 1,
      items: items(1),
    });
    // Simulate the legacy record: no `runIn` on disk at all.
    const o = h.engine.list()[0];
    delete (o as { runIn?: string }).runIn;
    await h.finish('run-1', 'aborted');
    h.engine.retry({ id: o.id });
    await h.flush();

    expect(h.started[1].runIn).toBe('worktree');
  });
});

describe('OrchestratorImpl parked proposals', () => {
  const REPLY = [
    'Found three small asks.',
    '<candidates>',
    JSON.stringify([
      { id: 'a', title: 'A', prompt: 'do a' },
      { id: 'b', title: 'B', prompt: 'do b', flowId: 'docs-flow' },
      { id: 'c', title: 'C', prompt: 'do c' },
    ]),
    '</candidates>',
  ].join('\n');

  const park = (h: ReturnType<typeof makeHarness>) =>
    h.engine.parkProposal({
      scheduleId: 'sched-1',
      scheduleName: 'Morning triage',
      projectPath: '/proj',
      prompt: 'pull feedback',
      flowId: 'default-flow',
      runIn: 'worktree',
      maxConcurrent: 2,
    });

  it('parks every candidate and launches nothing', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await park(h);

    expect(res).toMatchObject({ ok: true, count: 3 });
    // The whole point: a schedule fired, and no worktree was forked.
    expect(h.started).toHaveLength(0);
    const o = h.engine.list()[0];
    expect(o.items.map((i) => i.status)).toEqual(['proposed', 'proposed', 'proposed']);
    expect(o.origin).toMatchObject({ kind: 'schedule', scheduleId: 'sched-1' });
    expect(o.completedAt).toBeUndefined();
  });

  it('launches the first N and parks the rest when the schedule opted in', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await h.engine.parkProposal({
      scheduleId: 'sched-1',
      scheduleName: 'Morning triage',
      projectPath: '/proj',
      prompt: 'pull feedback',
      flowId: 'default-flow',
      runIn: 'worktree',
      maxConcurrent: 2,
      autoApprove: { maxItems: 2 },
    });

    expect(res).toMatchObject({ ok: true, count: 3, queued: 2 });
    const o = h.engine.list()[0];
    // maxConcurrent caps how many are in flight; the auto-launch cap governs
    // how many were committed to at all. Item 2 is queued behind item 1's
    // slot, item 3 was never committed.
    expect(o.items[2].status).toBe('proposed');
    expect(o.items[2].note).toMatch(/2-item auto-launch cap/i);
    expect(o.items.slice(0, 2).map((i) => i.status)).not.toContain('proposed');
    expect(h.started).toHaveLength(2);
    // The overflow keeps the batch on the approval surface rather than
    // letting it look finished.
    expect(o.completedAt).toBeUndefined();
  });

  // The Orchestrator banner's "Discard the rest" leans on this: declining the
  // parked overflow must not touch the children the cap already launched.
  it('declines parked overflow without disturbing the launched items', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await h.engine.parkProposal({
      scheduleId: 'sched-1',
      scheduleName: 'Morning triage',
      projectPath: '/proj',
      prompt: 'pull feedback',
      flowId: 'default-flow',
      runIn: 'worktree',
      maxConcurrent: 2,
      autoApprove: { maxItems: 2 },
    });
    const id = (res as { orchestrationId: string }).orchestrationId;

    const declined = await h.engine.approveBatch({ id, approve: [] });

    expect(declined).toMatchObject({ ok: true, queued: 0 });
    const o = h.engine.list()[0];
    expect(o.items[0].status).toBe('running');
    expect(o.items[1].status).toBe('running');
    expect(o.items[2].status).toBe('cancelled');
    // Two children are still working, so the batch is not settled.
    expect(o.completedAt).toBeUndefined();
  });

  it('launches everything when the cap is above what the producer found', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await h.engine.parkProposal({
      scheduleId: 'sched-1',
      scheduleName: 'Morning triage',
      projectPath: '/proj',
      prompt: 'pull feedback',
      flowId: 'default-flow',
      runIn: 'worktree',
      maxConcurrent: 3,
      autoApprove: { maxItems: 10 },
    });

    expect(res).toMatchObject({ ok: true, count: 3, queued: 3 });
    const o = h.engine.list()[0];
    expect(o.items.some((i) => i.status === 'proposed')).toBe(false);
    expect(o.items.every((i) => !i.note)).toBe(true);
    expect(h.started).toHaveLength(3);
  });

  // A schedule written by an older build, or hand-edited on disk, must not be
  // able to talk the engine into an unbounded unattended dispatch — the cap is
  // re-clamped here, not just at save time.
  it('clamps a nonsense cap instead of trusting it', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await h.engine.parkProposal({
      scheduleId: 'sched-1',
      scheduleName: 'Morning triage',
      projectPath: '/proj',
      prompt: 'pull feedback',
      flowId: 'default-flow',
      runIn: 'worktree',
      maxConcurrent: 2,
      autoApprove: { maxItems: Number.NaN },
    });

    expect(res).toMatchObject({ ok: true, count: 3, queued: 0 });
    expect(h.started).toHaveLength(0);
    expect(h.engine.list()[0].items.map((i) => i.status)).toEqual([
      'proposed',
      'proposed',
      'proposed',
    ]);
  });

  // Regression: the producer ran under a flat 300s wall clock, so a schedule
  // whose prompt spanned two issue trackers and three repos failed every
  // single morning with "Timed out after 300s." — mid-investigation, while
  // the turn was still streaming tool calls. The budget has to key off
  // silence, with the wall clock demoted to a far-off backstop.
  it('budgets the producer turn on silence, not a short wall clock', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);

    expect(h.oneShotCalls).toHaveLength(1);
    const call = h.oneShotCalls[0];
    expect(call.idleTimeoutMs).toBeGreaterThanOrEqual(60_000);
    // The absolute cap still exists — a runaway producer can't sit forever —
    // but it must be well clear of how long a real investigation takes.
    expect(call.timeoutMs).toBeGreaterThan(300_000);
  });

  it('falls back to the schedule flow but honours a per-candidate suggestion', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);
    const o = h.engine.list()[0];
    expect(o.items.map((i) => i.flowId)).toEqual(['default-flow', 'docs-flow', 'default-flow']);
  });

  it('launches only the approved items and cancels the rest', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);
    const o = h.engine.list()[0];

    const res = await h.engine.approveBatch({
      id: o.id,
      approve: [{ candidateId: 'a' }, { candidateId: 'c', flowId: 'other-flow' }],
    });

    expect(res).toMatchObject({ ok: true, queued: 2 });
    expect(h.started).toHaveLength(2);
    expect(h.started.map((s) => s.flowId)).toEqual(['default-flow', 'other-flow']);
    const after = h.engine.list()[0];
    expect(after.items.find((i) => i.candidate.id === 'b')!.status).toBe('cancelled');
  });

  it('approves the whole batch when no picks are given', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);
    const res = await h.engine.approveBatch({ id: h.engine.list()[0].id });
    expect(res).toMatchObject({ ok: true, queued: 3 });
    // Cap of 2 still holds — approval dispatches, it doesn't flood.
    expect(h.started).toHaveLength(2);
  });

  it('settles the batch when every item is declined', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);
    const res = await h.engine.approveBatch({ id: h.engine.list()[0].id, approve: [] });
    expect(res).toMatchObject({ ok: true, queued: 0 });
    expect(h.started).toHaveLength(0);
    expect(h.engine.list()[0].completedAt).toBeDefined();
  });

  it('refuses to approve a batch that has nothing parked', async () => {
    const h = makeHarness();
    await h.engine.startBatch({
      title: 'b',
      projectPath: '/proj',
      maxConcurrent: 1,
      items: items(1),
    });
    const res = await h.engine.approveBatch({ id: h.engine.list()[0].id });
    expect(res).toMatchObject({ ok: false });
  });

  it('aborting a parked batch cancels the proposals', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await park(h);
    const o = h.engine.list()[0];
    h.engine.abort({ id: o.id });
    const after = h.engine.list()[0];
    expect(after.items.every((i) => i.status === 'cancelled')).toBe(true);
    expect(after.completedAt).toBeDefined();
  });
});

describe('OrchestratorImpl worker batches', () => {
  const CANDIDATES = [
    { id: 'a', title: 'Fix the flaky test', prompt: 'do a', suggestedFlowId: 'contract-alt' },
    { id: 'b', title: 'Trim the bundle', prompt: 'do b', suggestedFlowId: 'rogue-flow' },
    { id: 'c', title: 'Rename the module', prompt: 'do c' },
    { id: 'd', title: 'Document the API', prompt: 'do d' },
  ];
  const REPLY = `plan prose\n<candidates>${JSON.stringify(CANDIDATES)}</candidates>`;

  function parkAsWorker(
    h: ReturnType<typeof makeHarness>,
    over: Record<string, unknown> = {},
  ) {
    return h.engine.parkProposal({
      origin: { kind: 'worker', workerId: 'w1', workerName: 'Scout' },
      projectPath: '/proj',
      prompt: 'shift plan',
      flowId: 'contract-main',
      runIn: 'worktree',
      maxConcurrent: 2,
      title: '[Shift 1] Scout',
      ...over,
    });
  }

  it('drops journaled rejections case-insensitively and reports the count', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await parkAsWorker(h, { excludeTitles: ['  FIX THE FLAKY TEST '] });
    expect(res).toMatchObject({ ok: true, count: 3, excluded: 1 });
    const o = h.engine.list()[0];
    expect(o.items.map((i) => i.candidate.id)).toEqual(['b', 'c', 'd']);
  });

  it('hard-caps recorded items at maxItems, taking the best-first prefix', async () => {
    const h = makeHarness({ producerReply: REPLY });
    const res = await parkAsWorker(h, { maxItems: 2 });
    // The cap trim is NOT "previously rejected" — excluded must stay 0.
    expect(res).toMatchObject({ ok: true, count: 2, excluded: 0 });
    expect(h.engine.list()[0].items.map((i) => i.candidate.id)).toEqual(['a', 'b']);
  });

  it('honours a suggested flow on the contract and clamps one off it', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await parkAsWorker(h, { allowedFlowIds: ['contract-main', 'contract-alt'] });
    const flows = h.engine.list()[0].items.map((i) => i.flowId);
    // a's suggestion is on the contract → honoured; b's rogue suggestion and
    // the unsuggested rest → the primary contract flow.
    expect(flows).toEqual(['contract-alt', 'contract-main', 'contract-main', 'contract-main']);
  });

  it('records the worker origin and stamps workerId onto auto-launched child runs', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await parkAsWorker(h, { autoApprove: { maxItems: 1 } });
    const o = h.engine.list()[0];
    expect(o.origin).toEqual({ kind: 'worker', workerId: 'w1', workerName: 'Scout' });
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ workerId: 'w1', workerName: 'Scout' });
  });

  it('runs the planning turn on the heartbeat model override', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await parkAsWorker(h, { model: 'tiny-heartbeat' });
    expect(h.oneShotCalls[0].model).toBe('tiny-heartbeat');
  });

  it('never stamps a worker on a schedule batch child run', async () => {
    const h = makeHarness({ producerReply: REPLY });
    await h.engine.parkProposal({
      scheduleId: 's1',
      scheduleName: 'Morning',
      projectPath: '/proj',
      prompt: 'seed',
      flowId: 'flow-a',
      runIn: 'worktree',
      maxConcurrent: 2,
      autoApprove: { maxItems: 1 },
    });
    expect(h.started).toHaveLength(1);
    expect(h.started[0].workerId).toBeUndefined();
    expect(h.engine.list()[0].origin).toEqual({
      kind: 'schedule',
      scheduleId: 's1',
      scheduleName: 'Morning',
    });
  });
});
