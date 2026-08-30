import { beforeEach, describe, expect, it, vi } from 'vitest';

let resolveDiff: ((value: { exitCode: number; stdout: string }) => void) | undefined;
let diffCalls = 0;
vi.mock('../git', () => ({
  runGitAsync: vi.fn(() => {
    diffCalls += 1;
    if (diffCalls > 1) return Promise.resolve({ exitCode: 0, stdout: '' });
    return new Promise<{ exitCode: number; stdout: string }>((resolve) => { resolveDiff = resolve; });
  }),
  runGit: vi.fn(() => ({ exitCode: 1, stdout: '' })), baseBranchExistsAsync: vi.fn(), checkoutAgentLocally: vi.fn(), createWorktreeAsync: vi.fn(),
  currentBranch: vi.fn(), detectBaseBranchAsync: vi.fn(), removeWorktreeAsync: vi.fn(), worktreeNameTaken: vi.fn(),
}));
vi.mock('./runsStore', () => ({ loadAllRuns: () => [], saveRun: vi.fn(), deleteRun: vi.fn() }));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, UUID } from '../../shared/types';
import type { Flow, FlowRun } from '../../shared/flows/schema';

const RUN_ID = 'abort-race' as UUID;
const flow: Flow = {
  id: 'abort-race-flow', name: 'Abort race', input: 'user_prompt', source: 'user', filePath: '/tmp/abort-race.yaml',
  participants: [{ id: 'p', name: 'P', backend: 'claude', model: 'claude-opus-5', kind: 'primary' }],
  steps: [
    { id: 'consume', participantId: 'p', role: 'reviewer', inputs: ['diff'], tools: ['Read'], output: 'review.md' },
    { id: 'produce', participantId: 'p', role: 'implementer', inputs: ['user_prompt'], tools: ['Write'], output: 'diff' },
    { id: 'next', participantId: 'p', role: 'reviewer', inputs: ['diff'], tools: ['Read'], output: 'next.md' },
  ],
};

function harness(stepId: string): { rt: FlowRuntimeImpl; run: FlowRun; sends: unknown[] } {
  const sends: unknown[] = [];
  const runner = { send: (args: unknown) => { sends.push(args); return { ok: true as const }; }, stop: () => {}, prewarm: () => {}, dropIfPrewarmed: () => {} };
  const rt = new FlowRuntimeImpl(runner as never, () => {}, () => [], () => ({ backends: {} }) as AppSettings);
  const run = {
    id: RUN_ID, flowId: flow.id, flowSnapshot: flow, projectPath: '/tmp', userPrompt: 'test', conversationIds: {}, artifacts: { diff: { name: 'diff', kind: 'diff', body: 'old', producedByStepId: 'produce', producedAt: 0 } },
    state: { kind: 'running', currentStepId: stepId }, createdAt: 0, attempts: [], baselineCommit: 'base',
  } as unknown as FlowRun;
  (rt as unknown as { runs: Map<UUID, FlowRun> }).runs.set(RUN_ID, run);
  return { rt, run, sends };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('diff abort races', () => {
  beforeEach(() => {
    diffCalls = 0;
    resolveDiff = undefined;
  });

  it('does not send after aborting while a consumed diff refreshes', async () => {
    const h = harness('consume');
    const pending = (h.rt as unknown as { executeStep: (id: UUID, step: string) => Promise<void> }).executeStep(RUN_ID, 'consume');
    await tick();
    h.rt.abortRun({ runId: RUN_ID });
    resolveDiff?.({ exitCode: 0, stdout: 'diff --git a/a b/a' });
    await pending;
    expect(h.sends).toEqual([]);
    expect(h.run.state.kind).toBe('aborted');
  });

  it('does not record or advance after aborting while a diff step finishes', async () => {
    const h = harness('produce');
    (h.rt as unknown as { stepBuffers: Map<UUID, unknown> }).stepBuffers.set(RUN_ID, { assistantText: '<output name="diff">ignored</output>', usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUSD: 0 });
    const pending = (h.rt as unknown as { onStepFinished: (id: UUID, step: string) => Promise<void> }).onStepFinished(RUN_ID, 'produce');
    await tick();
    h.rt.abortRun({ runId: RUN_ID });
    resolveDiff?.({ exitCode: 0, stdout: 'diff --git a/a b/a' });
    await pending;
    expect(h.run.state.kind).toBe('aborted');
    expect(h.sends).toEqual([]);
  });

  it('does not advance an aborted run', () => {
    const h = harness('produce');
    h.run.state = { kind: 'aborted' };
    (h.rt as unknown as { advanceAfterStep: (id: UUID, step: string) => void }).advanceAfterStep(RUN_ID, 'produce');
    expect(h.run.state.kind).toBe('aborted');
  });
});
