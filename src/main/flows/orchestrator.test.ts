import { describe, expect, it, vi } from 'vitest';

// The store persists to <userData>/orchestrations via electron's app.getPath.
// Stub the store module so the engine runs without electron/fs.
vi.mock('./orchestrationsStore', () => ({
  saveOrchestration: vi.fn(),
  loadAllOrchestrations: vi.fn(() => []),
  deleteOrchestration: vi.fn(),
}));
// Health probe reaches into backend binaries — stub it ready so propose()'s
// backend pick is deterministic (not exercised here, but keeps imports cheap).
vi.mock('../health', () => ({ probeBackendHealth: () => ({ kind: 'ready' }) }));

import { OrchestratorImpl, type FlowLauncher } from './orchestrator';
import type { FlowRun } from '../../shared/flows/schema';

/// A fake launcher that records start calls and lets the test drive each
/// child run to a terminal state by hand — modelling the runtime's async
/// completion without spawning anything.
function makeHarness() {
  const runs = new Map<string, FlowRun>();
  let counter = 0;
  const started: Array<{ runId: string; prompt: string; flowId: string }> = [];

  const emitted: any[] = [];
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
      started.push({ runId, prompt: args.userPrompt, flowId: args.flowId });
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
    {} as any, // runner — unused by the dispatch path
    launcher,
    (e) => emitted.push(e),
    () => [{ id: 'p', name: 'proj', path: '/proj' } as any],
    () => ({}) as any,
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

  return { engine, launcher, started, runs, finish, transition, emitted, flush };
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
