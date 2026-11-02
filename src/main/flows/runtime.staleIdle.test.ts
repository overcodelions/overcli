// A "turn over" that isn't about the step's turn must not end the step.
//
// A step sent to a participant that already has a process (an earlier step's)
// can relaunch it: a turbo step, or a different allowlist, is a launch-param
// change. Around that relaunch the conversation can see "idle" from what is
// not the step's turn, and the runtime used to take it as the step finishing:
// an empty buffer, so "produced no <output>", the one nudge spent, a second
// stray idle failing the step, and the model's real reply arriving on a
// paused run. The runner knows whether the conversation still owes a turn;
// while it does, idle is ignored.
//
// Lives in its own file for the same reason runtime.reask.test.ts does:
// driving the class needs the runs store mocked out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-1' as UUID;
const CONV = 'conv-1' as UUID;

function flow(): Flow {
  return {
    id: 'acme-sweep',
    name: 'Acme sweep',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-5', kind: 'primary' }],
    steps: [
      { id: 'report', participantId: 'primary', role: 'custom', inputs: ['user_prompt'], tools: ['Read'], turbo: true, output: 'report.md' },
    ],
    source: 'user',
    filePath: '/tmp/acme.yaml',
  } as Flow;
}

function run(): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'acme-sweep',
    flowSnapshot: flow(),
    projectPath: '/tmp/project',
    userPrompt: 'sweep the acme logs',
    conversationIds: { primary: CONV },
    artifacts: {},
    state: { kind: 'running', currentStepId: 'report' },
    createdAt: 1,
    attempts: [{ stepId: 'report', startedAt: 1, conversationId: CONV }],
  };
}

function harness(pending: { value: boolean }) {
  const sends: Array<{ prompt: string; turbo?: boolean; enabledTools?: string[] }> = [];
  const runner = {
    prewarm: () => {},
    dropIfPrewarmed: () => {},
    isTurnPending: () => pending.value,
    send: (args: { prompt: string; turbo?: boolean; enabledTools?: string[] }) => {
      sends.push({ prompt: args.prompt, turbo: args.turbo, enabledTools: args.enabledTools });
      return { ok: true as const };
    },
  };
  const rt = new FlowRuntimeImpl(
    runner as never,
    (_e: MainToRendererEvent) => {},
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  const r = run();
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, r);
  (rt as never as { convIdToRun: Map<UUID, UUID> }).convIdToRun.set(CONV, RUN_ID);
  (rt as never as { stepBuffers: Map<UUID, unknown> }).stepBuffers.set(RUN_ID, {
    assistantText: '',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    costUSD: 0,
  });
  return { rt, r, sends };
}

const idle = { type: 'running', conversationId: CONV, isRunning: false } as MainToRendererEvent;
const flush = () => new Promise((res) => setTimeout(res, 0));

describe('an idle the step does not own', () => {
  it('is ignored while the runner still owes the conversation a turn', async () => {
    const pending = { value: true };
    const h = harness(pending);

    // Two stray idles, as in the field: before the guard, the first spent the
    // nudge and the second failed the step.
    h.rt.observeEvent(idle);
    await flush();
    h.rt.observeEvent(idle);
    await flush();

    expect(h.sends).toHaveLength(0);
    expect(h.r.state).toEqual({ kind: 'running', currentStepId: 'report' });
    expect(h.r.attempts[0].outcome).toBeUndefined();
  });

  it('ends the step once no turn is owed', async () => {
    const pending = { value: false };
    const h = harness(pending);

    h.rt.observeEvent(idle);
    await flush();

    // Nothing in the buffer: the step's one nudge goes out.
    expect(h.sends).toHaveLength(1);
  });
});

describe('the missing-output nudge', () => {
  it("launches the way the step did, so the step's process is reused", async () => {
    const h = harness({ value: false });

    h.rt.observeEvent(idle);
    await flush();

    // The step's turbo and allowlist. Without them the nudge was a launch
    // change: the runner killed the step's process, relaunched it, and ran
    // the nudge outside the step's tools.
    expect(h.sends[0].turbo).toBe(true);
    expect(h.sends[0].enabledTools).toEqual(['Read']);
  });
});

describe("a finished run's follow-up", () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-followup-'));
  afterAll(() => fs.rmSync(project, { recursive: true, force: true }));

  // A CI fix handed back to the run that made the change waits for the turn's
  // end. A relaunch's stray idle, 70 ms in, used to end it there: "added no
  // new commit", the manager told, while the worker went on working unheard.
  it('is not ended by an idle while the turn is still pending', async () => {
    const pending = { value: true };
    const h = harness(pending);
    h.r.projectPath = project;
    h.r.state = { kind: 'done', success: true };
    let settled = false;
    const said = h.rt.chatWithRun({ runId: RUN_ID, text: 'CI failed: fix it', timeoutMs: 60_000 }).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    expect(h.sends).toHaveLength(1);

    h.rt.observeEvent(idle);
    await flush();
    expect(settled).toBe(false);

    // The turn's own end.
    pending.value = false;
    (h.rt as never as { latestAssistantTextByParticipant: Map<string, string> }).latestAssistantTextByParticipant.set(`${RUN_ID}:primary`, 'Fixed the failing test.');
    h.rt.observeEvent(idle);
    await expect(said).resolves.toEqual({ ok: true, reply: 'Fixed the failing test.' });
  });
});
