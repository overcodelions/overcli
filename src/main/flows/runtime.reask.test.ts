// The missing-`<output>` nudge, driven through the real FlowRuntimeImpl.
//
// A step whose reply carries no `<output name="…">` block used to pause the
// run on the spot. In practice that is usually a formatting slip — the model
// wrote the artifact to a file, or narrated it — and the run stalled waiting
// for a human to click Re-run. The runtime now asks once for the block
// itself; only a second miss fails the step.
//
// Lives beside runtime.retry.test.ts for the same reason it does: driving the
// class needs the runs store mocked out.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl, missingOutputReaskPrompt } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-1' as UUID;

function flow(): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants: [
      {
        id: 'primary',
        name: 'Sonnet',
        backend: 'claude',
        model: 'claude-sonnet-5',
        kind: 'primary',
      },
    ],
    steps: [
      {
        id: 'proof-spike',
        participantId: 'primary',
        role: 'implementer',
        inputs: ['user_prompt'],
        tools: ['Read'],
        output: 'spike.md',
      },
      {
        id: 'review',
        participantId: 'primary',
        role: 'reviewer',
        inputs: ['spike.md'],
        tools: ['Read'],
        output: 'review.md',
      },
    ],
    source: 'user',
    filePath: '/tmp/test.yaml',
  };
}

function run(): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'test-flow',
    flowSnapshot: flow(),
    projectPath: '/tmp/project',
    userPrompt: 'prove the approach works',
    // The step already ran, so its participant has a live conversation —
    // the nudge is a follow-up turn on exactly that conversation.
    conversationIds: { primary: 'conv-1' as UUID },
    artifacts: {},
    state: { kind: 'running', currentStepId: 'proof-spike' },
    createdAt: 1,
    // The open attempt `executeStep` pushed before sending the step's turn.
    attempts: [{ stepId: 'proof-spike', startedAt: 1, conversationId: 'conv-1' as UUID }],
  };
}

function harness() {
  const sends: Array<{ conversationId: string; prompt: string; displayText?: string }> = [];
  let sendOk = true;
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    send: (args: { conversationId: string; prompt: string; displayText?: string }) => {
      sends.push({
        conversationId: args.conversationId,
        prompt: args.prompt,
        displayText: args.displayText,
      });
      return sendOk ? { ok: true as const } : { ok: false as const, error: 'backend offline' };
    },
  };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  return { rt, sends, emitted, failSends: () => { sendOk = false; } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/// Finish the current step with `text` as everything the participant said.
async function finishWith(h: ReturnType<typeof harness>, text: string) {
  (h.rt as never as { stepBuffers: Map<UUID, unknown> }).stepBuffers.set(RUN_ID, {
    assistantText: text,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    costUSD: 0,
  });
  (h.rt as never as { onStepFinished: (a: UUID, b: string) => void }).onStepFinished(
    RUN_ID,
    'proof-spike',
  );
  await flush();
}

/// What a step that did the work but skipped the wrapper actually says.
const NARRATED = 'Done — I wrote the spike up in spike.md. Happy to expand any section.';
const WRAPPED = '<output name="spike.md">## Spike\n\nIt works.</output>';

describe('missing <output> nudge', () => {
  let h: ReturnType<typeof harness>;
  let r: FlowRun;

  beforeEach(() => {
    h = harness();
    r = run();
    (h.rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  });

  it('asks for the block instead of pausing the run on the first miss', async () => {
    await finishWith(h, NARRATED);

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.conversationId).toBe('conv-1'); // same conv — the work is still in context
    expect(h.sends[0]!.prompt).toContain('<output name="spike.md">');
    expect(h.sends[0]!.prompt).toContain('Do not redo the work');
    expect(h.sends[0]!.displayText).toContain('spike.md');
    expect(r.state).toEqual({ kind: 'running', currentStepId: 'proof-spike' });
    // The step is still in flight — its attempt has not been closed out.
    expect(r.attempts.filter((a) => a.endedAt != null)).toHaveLength(0);
  });

  it('takes the artifact from the nudge reply and rolls the run forward', async () => {
    await finishWith(h, NARRATED);
    h.sends.length = 0;

    await finishWith(h, WRAPPED);

    expect(r.artifacts['spike.md']?.body).toBe('## Spike\n\nIt works.');
    expect(r.state).toEqual({ kind: 'running', currentStepId: 'review' });
  });

  it('fails the step when the second try still has no block', async () => {
    await finishWith(h, NARRATED);
    h.sends.length = 0;

    await finishWith(h, 'Still just talking about it.');

    expect(h.sends).toHaveLength(0); // one nudge per attempt, not a loop
    expect(r.state).toEqual({ kind: 'paused', nextStepId: 'proof-spike', reason: 'failure' });
    expect(r.attempts.at(-1)?.errorMessage).toContain('produced no <output name="spike.md">');
  });

  it('gives a re-run of the step its own nudge', async () => {
    await finishWith(h, NARRATED);
    await finishWith(h, 'Still just talking about it.');
    expect(r.state).toEqual({ kind: 'paused', nextStepId: 'proof-spike', reason: 'failure' });
    h.sends.length = 0;

    h.rt.rerunFromStep({ runId: RUN_ID, stepId: 'proof-spike' });
    await flush();
    h.sends.length = 0;
    await finishWith(h, NARRATED);

    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.prompt).toContain('Do not redo the work');
  });

  it('falls back to failing the step when the nudge cannot be sent', async () => {
    h.failSends();

    await finishWith(h, NARRATED);

    expect(r.state).toEqual({ kind: 'paused', nextStepId: 'proof-spike', reason: 'failure' });
    expect(r.attempts.at(-1)?.errorMessage).toContain('produced no <output name="spike.md">');
  });
});

describe('missingOutputReaskPrompt', () => {
  // The recoverable case that shows up most: the deliverable is on disk and
  // the model considers the step done. Unless it is told to read the file
  // back, it replies "already written to spike.md" and the step fails again.
  it('tells a model that wrote the artifact to a file to paste it back', () => {
    const prompt = missingOutputReaskPrompt('spike.md');
    expect(prompt).toContain('read that file back');
    expect(prompt).toContain('<output name="spike.md">');
    expect(prompt).toContain('</output>');
  });
});
