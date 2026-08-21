// The deferred-steer channel: a course correction typed while a step is
// running, held in `run.pendingSteer`, and injected at the top of the NEXT
// step's prompt. Covers `buildSteerBlock` in isolation and `steerRun`'s
// set/replace/withdraw semantics through the real FlowRuntimeImpl.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { buildSteerBlock, FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun, FlowStep } from '../../shared/flows/schema';

const RUN_ID = 'run-1' as UUID;

function flow(): Flow {
  const steps: FlowStep[] = [
    {
      id: 'write-tests',
      participantId: 'primary',
      role: 'implementer',
      inputs: ['plan.md'],
      tools: ['Read'],
      output: 'code.md',
    },
  ];
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: [
      {
        id: 'primary',
        name: 'Sonnet',
        backend: 'claude',
        model: 'claude-sonnet-4-6',
        kind: 'primary',
      },
    ],
    steps,
    source: 'user',
    filePath: '/tmp/test.yaml',
  };
}

function run(stateKind: FlowRun['state']['kind'] = 'running'): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'test-flow',
    flowSnapshot: flow(),
    projectPath: '/tmp/project',
    userPrompt: 'ship the thing',
    conversationIds: {},
    artifacts: {},
    state:
      stateKind === 'running'
        ? { kind: 'running', currentStepId: 'write-tests' }
        : ({ kind: stateKind } as FlowRun['state']),
    createdAt: 1,
    attempts: [],
  };
}

function harness() {
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    { prewarm: () => {}, dropIfPrewarmed: () => {}, send: () => ({ ok: true as const }) } as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, emitted };
}

/// Two-step flow (`build` -> `review`, with a `goto` retry back to `build`)
/// so the integration tests below can exercise the seam between `steerRun`,
/// `buildStepPrompt`, and `executeStep` — not just each in isolation. Mirrors
/// `runtime.retry.test.ts`'s flow, which this reuses the retry wiring from.
function twoStepFlow(): Flow {
  const steps: FlowStep[] = [
    {
      id: 'build',
      participantId: 'primary',
      role: 'implementer',
      inputs: ['plan.md'],
      tools: ['Read'],
      output: 'code.md',
    },
    {
      id: 'review',
      participantId: 'primary',
      role: 'reviewer',
      inputs: ['code.md'],
      tools: ['Read'],
      output: 'review.md',
      onFail: { action: 'goto', target: 'build', maxRetries: 2 },
    },
  ];
  return {
    id: 'test-flow-2',
    name: 'Test Flow 2',
    input: 'user_prompt',
    participants: [
      { id: 'primary', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' },
    ],
    steps,
    source: 'user',
    filePath: '/tmp/test2.yaml',
  };
}

function twoStepRun(): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'test-flow-2',
    flowSnapshot: twoStepFlow(),
    projectPath: '/tmp/project',
    userPrompt: 'ship the thing',
    conversationIds: {},
    artifacts: { 'plan.md': { name: 'plan.md', kind: 'markdown', body: 'the plan', producedByStepId: 'plan', producedAt: 1 } },
    state: { kind: 'running', currentStepId: 'build' },
    createdAt: 1,
    attempts: [],
  };
}

/// A runtime with a stub runner that records every prompt/displayText it was
/// asked to send, so the tests below can assert on what actually reached the
/// model instead of only on `run.pendingSteer`'s bookkeeping.
function sendingHarness() {
  const sends: Array<{ prompt: string; displayText?: string }> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { prompt: string; displayText?: string }) => {
      sends.push({ prompt: args.prompt, displayText: args.displayText });
      return { ok: true as const };
    },
  };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, sends, emitted };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('buildSteerBlock', () => {
  it('contains the shouty header, the step id, and the text', () => {
    const block = buildSteerBlock('per-tenant limits', 'write-tests');
    expect(block).toContain('COURSE CORRECTION FROM YOUR OWNER');
    expect(block).toContain('write-tests');
    expect(block).toContain('per-tenant limits');
  });

  it('puts the header first — a model that truncates its attention must still see it', () => {
    const block = buildSteerBlock('per-tenant limits', 'write-tests');
    expect(block.indexOf('COURSE CORRECTION')).toBe(0);
  });
});

describe('steerRun', () => {
  it('refuses on a finished run and leaves pendingSteer unset', () => {
    const { rt } = harness();
    const r = run('done');
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

    const res = rt.steerRun({ runId: RUN_ID, text: 'slow down' });

    expect(res.ok).toBe(false);
    expect(r.pendingSteer).toBeUndefined();
  });

  it('accepts on a PAUSED run — the pending step is exactly what you want to correct', () => {
    const { rt } = harness();
    const r = run('paused');
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

    const res = rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });

    expect(res.ok).toBe(true);
    expect(r.pendingSteer?.text).toBe('use per-tenant limits');
    // Nothing was mid-flight, so the block must not claim a step "was
    // running" — buildSteerBlock drops that clause when the id is absent.
    expect(r.pendingSteer?.queuedDuringStepId).toBeUndefined();
  });

  it('replaces a queued steer rather than stacking it', () => {
    const { rt } = harness();
    const r = run();
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

    rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });
    rt.steerRun({ runId: RUN_ID, text: 'actually, use per-org limits' });

    expect(r.pendingSteer?.text).toBe('actually, use per-org limits');
  });

  it('withdraws a queued steer when given blank text', () => {
    const { rt } = harness();
    const r = run();
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);

    rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });
    expect(r.pendingSteer).toBeDefined();
    rt.steerRun({ runId: RUN_ID, text: '   ' });

    expect(r.pendingSteer).toBeUndefined();
  });

  it('is dropped when the run is aborted, so a re-run cannot replay it', () => {
    const { rt } = harness();
    const r = run();
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
    rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });

    rt.abortRun({ runId: RUN_ID });

    // `pendingSteer` is persisted, unlike the in-memory retry feedback, so
    // without this it would resurface on a `rerunFromStep` days later framed
    // as fresh guidance.
    expect(r.pendingSteer).toBeUndefined();
  });

  it('survives a JSON round-trip, so it persists across a restart', () => {
    const { rt } = harness();
    const r = run();
    (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
    rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });

    const restored = JSON.parse(JSON.stringify(r)) as FlowRun;

    expect(restored.pendingSteer?.text).toBe('use per-tenant limits');
  });
});

// The seam between the three builders above: does a queued steer actually
// reach the prompt the model is sent, ahead of a pending retry, and does it
// actually get spent so the step after doesn't see it again?
describe('steer integration', () => {
  it('prefixes the next step\'s prompt and is spent by the time it runs', async () => {
    const h = sendingHarness();
    const r = twoStepRun();
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
    h.rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });

    await (h.rt as never as { executeStep: (a: UUID, b: string) => Promise<void> }).executeStep(
      RUN_ID,
      'build',
    );
    await flush();

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.prompt.startsWith('COURSE CORRECTION FROM YOUR OWNER')).toBe(true);
    expect(h.sends[0]!.displayText).toContain('Course correction applied');
    expect(r.pendingSteer).toBeUndefined();

    // The step after: no steer block left to inject.
    r.artifacts['code.md'] = { name: 'code.md', kind: 'markdown', body: 'done', producedByStepId: 'build', producedAt: 2 };
    r.state = { kind: 'running', currentStepId: 'review' };
    await (h.rt as never as { executeStep: (a: UUID, b: string) => Promise<void> }).executeStep(
      RUN_ID,
      'review',
    );
    await flush();

    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]!.prompt).not.toContain('COURSE CORRECTION');
  });

  it('leads a pending retry block — the live correction outranks the earlier rejection', async () => {
    const h = sendingHarness();
    const r = twoStepRun();
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
    // Feedback owed to `build`, set directly exactly as
    // `runtime.retry.test.ts` does for the same reason: bypass the goto
    // flow and land the runtime in the state under test.
    (h.rt as never as { retryFeedback: Map<UUID, unknown> }).retryFeedback.set(RUN_ID, {
      targetStepId: 'build',
      fromStepId: 'review',
      artifactName: null,
      reason: 'Reviewer step "review" did not approve.',
      attempt: 1,
      maxRetries: 2,
    });
    h.rt.steerRun({ runId: RUN_ID, text: 'use per-tenant limits' });

    await (h.rt as never as { executeStep: (a: UUID, b: string) => Promise<void> }).executeStep(
      RUN_ID,
      'build',
    );
    await flush();

    const { prompt } = h.sends[0]!;
    expect(prompt).toContain('COURSE CORRECTION FROM YOUR OWNER');
    expect(prompt).toContain('RETRY 1 of 2');
    expect(prompt.indexOf('COURSE CORRECTION')).toBeLessThan(prompt.indexOf('RETRY 1 of 2'));
  });
});
