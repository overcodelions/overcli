// The `on_fail.goto` retry loop, driven through the real FlowRuntimeImpl.
//
// runtime.test.ts covers the two builders in isolation; this covers the
// wiring between them, which is where the interesting failure modes live:
// feedback that never reaches the retried step, feedback that reaches the
// WRONG step, or feedback that outlives the attempt it belongs to and turns
// up again on a later run of the same step.
//
// Lives in its own file because driving the class needs the runs store
// mocked out, and runtime.test.ts imports the module clean.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun, FlowStep } from '../../shared/flows/schema';

const RUN_ID = 'run-1' as UUID;
const REJECTION = 'Reviewer step "review" did not approve — Verdict: CHANGES REQUESTED.';

function flow(): Flow {
  const steps: FlowStep[] = [
    {
      id: 'build',
      participantId: 'primary',
      role: 'implementer',
      // Deliberately does NOT list review.md: a build step is authored
      // before the review it will one day be sent back by.
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

function artifact(name: string, body: string, stepId: string) {
  return { name, kind: 'markdown' as const, body, producedByStepId: stepId, producedAt: 1 };
}

function run(withReviewArtifact = true): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'test-flow',
    flowSnapshot: flow(),
    projectPath: '/tmp/project',
    userPrompt: 'ship the thing',
    conversationIds: {},
    artifacts: {
      'plan.md': artifact('plan.md', 'the plan', 'plan'),
      ...(withReviewArtifact
        ? {
            'review.md': artifact(
              'review.md',
              'Verdict: CHANGES REQUESTED.\n\nThe SSO branch drops the redirect param.',
              'review',
            ),
          }
        : {}),
    },
    state: { kind: 'running', currentStepId: 'review' },
    createdAt: 1,
    attempts: [],
  };
}

/// A runtime with a stub runner, plus the sends it made. `send` resolving
/// `ok` is enough — nothing here needs a reply, only the prompt we handed over.
function harness() {
  const sends: Array<{ prompt: string; displayText?: string }> = [];
  const runner = {
    // Look-ahead prewarming is fire-and-forget; these stubs keep the
    // runtime's calls from throwing without affecting what's asserted.
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

/// `handleStepFailure` fires `executeStep` without awaiting it (the run
/// advances, the send happens on the next tick).
const flush = () => new Promise((r) => setTimeout(r, 0));

/// Send the review step back to build, exactly as a non-approving reviewer
/// turn would.
async function reject(rt: FlowRuntimeImpl, r: FlowRun, message = REJECTION) {
  const review = r.flowSnapshot.steps.find((s) => s.id === 'review')!;
  (rt as never as { handleStepFailure: (a: UUID, b: FlowStep, c: string) => void })
    .handleStepFailure(RUN_ID, review, message);
  await flush();
}

describe('on_fail.goto retry feedback', () => {
  let h: ReturnType<typeof harness>;
  let r: FlowRun;

  beforeEach(() => {
    h = harness();
    r = run();
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  });

  it('tells the retried step it was rejected, by whom, and how many shots are left', async () => {
    await reject(h.rt, r);

    expect(h.sends).toHaveLength(1);
    const { prompt } = h.sends[0]!;
    expect(prompt).toContain('RETRY 1 of 2');
    expect(prompt).toContain('Rejected by step "review"');
    expect(prompt).toContain('Verdict: CHANGES REQUESTED');
    // The preamble leads — a model that truncates its attention to the top of
    // a long prompt must still see that this is a second attempt.
    expect(prompt.indexOf('RETRY 1 of 2')).toBeLessThan(prompt.indexOf('INPUTS:'));
  });

  it('puts the rejecting review in front of the model even though build never declared it', async () => {
    await reject(h.rt, r);

    const { prompt } = h.sends[0]!;
    expect(prompt).toContain('The SSO branch drops the redirect param.');
    // Its declared input is still there — the retry augments the step's
    // inputs, it doesn't replace them.
    expect(prompt).toContain('the plan');
  });

  it('shows the retry in the step header so the loop is visible in the run pane', async () => {
    await reject(h.rt, r);

    const { displayText } = h.sends[0]!;
    expect(displayText).toContain('Retry 1 of 2');
    expect(displayText).toContain('review');
    expect(displayText).toContain('The SSO branch drops the redirect param.');
  });

  it('spends the feedback on one attempt — a later run of the same step starts clean', async () => {
    await reject(h.rt, r);
    expect(h.sends[0]!.prompt).toContain('RETRY 1 of 2');

    // The retried build runs again for a reason of its own — it failed and
    // the user resumed, say. Re-serving the old rejection here would tell it
    // to fix objections it has already addressed.
    await (h.rt as never as {
      executeStep: (a: UUID, b: string) => Promise<void>;
    }).executeStep(RUN_ID, 'build');

    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]!.prompt).not.toContain('RETRY');
    expect(h.sends[1]!.displayText).not.toContain('Retry');
  });

  it('drops the feedback on a manual rewind — being sent back by hand is not a rejection', async () => {
    // Feedback owed but not yet served. Normally the goto serves it on the
    // next tick, so this is the narrow window where a rewind can beat it: the
    // step that ran never got there (aborted, or the run paused first). Set
    // directly rather than via `reject`, which would spend it immediately.
    (h.rt as never as { retryFeedback: Map<UUID, unknown> }).retryFeedback.set(RUN_ID, {
      targetStepId: 'build',
      fromStepId: 'review',
      artifactName: 'review.md',
      reason: REJECTION,
      attempt: 1,
      maxRetries: 2,
    });

    r.state = { kind: 'paused', nextStepId: 'build', reason: 'failure' };
    h.rt.rerunFromStep({ runId: RUN_ID, stepId: 'build' });
    await flush();

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.prompt).not.toContain('RETRY');
    expect(h.sends[0]!.displayText).not.toContain('Retry');
  });

  it('does not leak a rejection onto a different step', async () => {
    await reject(h.rt, r);
    h.sends.length = 0;

    // The reviewer itself runs next; it was not the goto target.
    await (h.rt as never as {
      executeStep: (a: UUID, b: string) => Promise<void>;
    }).executeStep(RUN_ID, 'review');

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.prompt).not.toContain('RETRY');
  });

  it('counts up to the budget, then pauses instead of looping forever', async () => {
    await reject(h.rt, r);
    expect(h.sends[0]!.prompt).toContain('RETRY 1 of 2');

    await reject(h.rt, r);
    expect(h.sends[1]!.prompt).toContain('RETRY 2 of 2');

    await reject(h.rt, r);
    expect(h.sends).toHaveLength(2); // no third attempt
    expect(r.state).toEqual({ kind: 'paused', nextStepId: 'review', reason: 'failure' });
  });

  it('still explains itself when the failing step produced no artifact', async () => {
    // A step that died before emitting <output> has nothing to attach — the
    // retry has to work off the failure message alone rather than pointing at
    // an artifact that isn't there.
    const bare = run(false);
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, bare);
    await reject(h.rt, bare, 'missing <output name="review.md"> in assistant text');

    const { prompt } = h.sends[0]!;
    expect(prompt).toContain('RETRY 1 of 2');
    expect(prompt).toContain('missing <output name="review.md">');
    expect(prompt).not.toContain('input "review.md"');
  });
});
