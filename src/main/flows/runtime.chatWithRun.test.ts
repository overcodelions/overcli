// A message to a finished run, answered by whoever ran its last step, in
// that step's own conversation: what a Slack thread carries on with once the
// work it asked for is done.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, UUID } from '../../shared/types';
import type { FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'run-chat' as UUID;

function run(state: FlowRun['state']): FlowRun {
  return {
    id: RUN_ID,
    flowId: 'tally',
    flowSnapshot: {
      id: 'tally',
      name: 'Tally',
      input: 'user_prompt',
      participants: [
        { id: 'planner', name: 'Planner', backend: 'claude', model: 'claude-sonnet-5-5', kind: 'primary' },
        { id: 'writer', name: 'Writer', backend: 'claude', model: 'claude-opus-5-5', kind: 'primary' },
      ],
      steps: [
        { id: 'plan', participantId: 'planner', role: 'planner', inputs: [], tools: ['Read'], output: 'plan.md' },
        { id: 'write', participantId: 'writer', role: 'implementer', inputs: ['plan.md'], tools: ['Read'], output: 'report.md' },
      ],
      source: 'user',
      filePath: '/tmp/tally.yaml',
    },
    projectPath: process.cwd(),
    userPrompt: 'count my tickets',
    conversationIds: { planner: 'conv-plan' as UUID, writer: 'conv-write' as UUID },
    artifacts: {},
    state,
    createdAt: 1,
    attempts: [],
  };
}

function harness(state: FlowRun['state']) {
  const sends: Array<{ conversationId: string; prompt: string; model: string }> = [];
  const rt = new FlowRuntimeImpl(
    { prewarm: () => {}, dropIfPrewarmed: () => {}, send: (a: { conversationId: string; prompt: string; model: string }) => (sends.push(a), { ok: true as const }) } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as unknown as AppSettings,
  );
  (rt as never as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, run(state));
  return { rt, sends };
}

function say(rt: FlowRuntimeImpl, conversationId: string, text: string): void {
  rt.observeEvent({
    type: 'stream',
    conversationId: conversationId as UUID,
    events: [{ id: `e-${text.length}`, timestamp: 1, raw: '', revision: 0, kind: { type: 'assistant', info: { model: 'claude-opus-5-5', text, toolUses: [], thinking: [] } } }],
  } as never);
}

describe('chatting with a finished run', () => {
  it('refuses a swept folder before sending anything to the runner', async () => {
    const { rt, sends } = harness({ kind: 'done', success: true });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-swept-'));
    (rt as unknown as { runs: Map<UUID, FlowRun> }).runs.get(RUN_ID)!.projectPath = folder;
    fs.rmSync(folder, { recursive: true, force: true });
    await expect(rt.chatWithRun({ runId: RUN_ID, text: 'continue' })).resolves.toEqual({ ok: false, error: 'That run’s folders were cleaned up.' });
    expect(sends).toEqual([]);
  });
  it('speaks to whoever ran the last step, and answers with what it said once its turn ends', async () => {
    const { rt, sends } = harness({ kind: 'done', success: true });
    const reply = rt.chatWithRun({ runId: RUN_ID, text: 'which month was worst?' });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ conversationId: 'conv-write', prompt: 'which month was worst?', model: 'claude-opus-5-5' });
    say(rt, 'conv-write', 'Looking.');
    say(rt, 'conv-write', 'September, with 125.');
    rt.observeEvent({ type: 'running', conversationId: 'conv-write' as UUID, isRunning: false } as never);
    await expect(reply).resolves.toEqual({ ok: true, reply: 'September, with 125.' });
    expect(rt.getRun(RUN_ID)?.state).toEqual({ kind: 'done', success: true });
  });

  it('refuses a run that is still going, and a second message while one is answered', async () => {
    expect(await harness({ kind: 'running', currentStepId: 'write' }).rt.chatWithRun({ runId: RUN_ID, text: 'hi' })).toMatchObject({ ok: false });
    const { rt } = harness({ kind: 'done', success: true });
    void rt.chatWithRun({ runId: RUN_ID, text: 'one' });
    expect(await rt.chatWithRun({ runId: RUN_ID, text: 'two' })).toMatchObject({ ok: false, error: 'It is still answering the last message.' });
  });

  it('says so when the turn ends without a word', async () => {
    const { rt } = harness({ kind: 'done', success: true });
    const reply = rt.chatWithRun({ runId: RUN_ID, text: 'hello?' });
    rt.observeEvent({ type: 'running', conversationId: 'conv-write' as UUID, isRunning: false } as never);
    expect(await reply).toMatchObject({ ok: false });
  });
});
