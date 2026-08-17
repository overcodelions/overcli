// Look-ahead prewarming, driven through the real FlowRuntimeImpl.
//
// Steps run strictly one after another, so the first step of every new
// participant would otherwise pay CLI startup on the critical path. The
// runtime warms it while the previous step is still generating.
//
// The eligibility rules inside the runner are covered by `canPrewarm` in
// runner.test.ts; what's tested here is the decision the runtime makes about
// WHICH conversation to warm and when — the part that costs a stray process
// when it's wrong.
//
// Lives in its own file for the same reason runtime.retry.test.ts does:
// driving the class needs the runs store mocked out.

import { describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowParticipant, FlowRun, FlowStep } from '../../shared/flows/schema';

const RUN_ID = 'run-1' as UUID;

const PLANNER: FlowParticipant = {
  id: 'planner',
  name: 'Opus',
  backend: 'claude',
  model: 'claude-opus-5',
  kind: 'primary',
};
const BUILDER: FlowParticipant = {
  id: 'builder',
  name: 'Sonnet',
  backend: 'claude',
  model: 'claude-sonnet-5',
  kind: 'worker',
};

function step(over: Partial<FlowStep> & { id: string; participantId: string }): FlowStep {
  return {
    role: 'implementer',
    inputs: ['user_prompt'],
    tools: ['Read'],
    output: `${over.id}.md`,
    ...over,
  } as FlowStep;
}

function flow(over: { steps?: FlowStep[]; participants?: FlowParticipant[] } = {}): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: over.participants ?? [PLANNER, BUILDER],
    steps:
      over.steps ??
      [
        step({ id: 'plan', participantId: 'planner', role: 'planner' }),
        step({ id: 'build', participantId: 'builder', inputs: ['plan.md'] }),
      ],
    source: 'user',
    filePath: '/tmp/test.yaml',
  };
}

function run(f: Flow, conversationIds: Record<string, UUID> = {}): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'test-flow',
    flowSnapshot: f,
    projectPath: '/tmp/project',
    userPrompt: 'ship the thing',
    conversationIds,
    artifacts: {},
    state: { kind: 'running', currentStepId: f.steps[0].id },
    createdAt: 1,
    attempts: [],
  };
}

interface WarmCall {
  conversationId: UUID;
  backend: string;
  model: string;
  permissionMode: string;
  prompt: string;
  cwd: string;
}

/// A runtime whose runner records prewarms and sends instead of spawning.
/// `dropIfPrewarmed` records too, so teardown is observable.
function harness() {
  const warms: WarmCall[] = [];
  const sends: Array<{ conversationId: UUID }> = [];
  const dropped: UUID[] = [];
  const runner = {
    send: (args: { conversationId: UUID }) => {
      sends.push({ conversationId: args.conversationId });
      return { ok: true as const };
    },
    prewarm: (args: WarmCall) => warms.push(args),
    dropIfPrewarmed: (convId: UUID) => dropped.push(convId),
    stop: () => {},
  };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, warms, sends, dropped };
}

/// Register a run with the runtime and execute one of its steps, exactly as
/// the advance path would.
function execute(rt: FlowRuntimeImpl, r: FlowRun, stepId: string) {
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(r.id, r);
  (rt as never as { executeStep: (a: UUID, b: string) => void }).executeStep(r.id, stepId);
}

describe('prewarmNextParticipant', () => {
  it("warms the next step's participant while the current step generates", () => {
    const { rt, warms } = harness();
    const r = run(flow());

    execute(rt, r, 'plan');

    expect(warms).toHaveLength(1);
    // The next step's own model and permission mode — not the running
    // step's. Warming with the wrong params would force a respawn.
    expect(warms[0].backend).toBe('claude');
    expect(warms[0].model).toBe('claude-sonnet-5');
    expect(warms[0].permissionMode).toBe('bypassPermissions');
    expect(warms[0].cwd).toBe('/tmp/project');
    expect(warms[0].prompt).toBe('');
  });

  it('warms under the conversation id the next step will actually use', () => {
    // The whole optimization rests on this: a warm process under a different
    // id is a leak plus a cold start, which is worse than not warming.
    const { rt, warms, sends } = harness();
    const r = run(flow());

    execute(rt, r, 'plan');
    const warmedConv = warms[0].conversationId;
    expect(r.conversationIds.builder).toBe(warmedConv);

    execute(rt, r, 'build');
    expect(sends.at(-1)?.conversationId).toBe(warmedConv);
  });

  it('skips a participant that already has a conversation', () => {
    // It has a live process or a session to resume; prewarm spawns without a
    // resume hint, so warming it would trade context for nothing.
    const { rt, warms } = harness();
    const r = run(flow(), { builder: 'existing-conv' as UUID });

    execute(rt, r, 'plan');

    expect(warms).toHaveLength(0);
    expect(r.conversationIds.builder).toBe('existing-conv');
  });

  it('skips when the next step reuses the running participant', () => {
    const { rt, warms } = harness();
    const f = flow({
      participants: [PLANNER],
      steps: [
        step({ id: 'plan', participantId: 'planner', role: 'planner' }),
        step({ id: 'review', participantId: 'planner', role: 'reviewer', inputs: ['plan.md'] }),
      ],
    });
    const r = run(f);

    execute(rt, r, 'plan');

    // One conversation is minted by the running step itself, and the second
    // step shares it — there is nothing left to warm.
    expect(warms).toHaveLength(0);
  });

  it('skips a pause_before step — the wait is a human, not a latency window', () => {
    const { rt, warms } = harness();
    const f = flow();
    f.steps[1] = { ...f.steps[1], pauseBefore: true };
    const r = run(f);

    execute(rt, r, 'plan');

    expect(warms).toHaveLength(0);
    expect(r.conversationIds.builder).toBeUndefined();
  });

  it('skips ollama — there is no process to start early', () => {
    const { rt, warms } = harness();
    const f = flow({
      participants: [PLANNER, { ...BUILDER, backend: 'ollama', model: 'qwen2.5-coder:7b' }],
    });
    const r = run(f);

    execute(rt, r, 'plan');

    expect(warms).toHaveLength(0);
  });

  it('does nothing on the last step', () => {
    const { rt, warms } = harness();
    const f = flow({
      participants: [PLANNER],
      steps: [step({ id: 'plan', participantId: 'planner', role: 'planner' })],
    });
    const r = run(f);

    execute(rt, r, 'plan');

    expect(warms).toHaveLength(0);
  });

  it('releases a warm process when the run is aborted', () => {
    // The step it was speculating on will never arrive. An unused prewarm has
    // no session id, so without this it would sit until the idle reap.
    const { rt, warms, dropped } = harness();
    const r = run(flow());

    execute(rt, r, 'plan');
    const warmedConv = warms[0].conversationId;

    rt.abortRun({ runId: RUN_ID });

    expect(dropped).toContain(warmedConv);
  });
});
