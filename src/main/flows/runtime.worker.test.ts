import { describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'flow-1',
      name: 'Review flow',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Primary',
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'primary',
        },
      ],
      steps: [
        {
          id: 'review',
          participantId: 'primary',
          role: 'implementer',
          inputs: [],
          tools: ['Read'],
          output: 'review.md',
        },
      ],
      source: 'user',
      filePath: '/tmp/review.yaml',
    },
    {
      id: 'external-flow',
      name: 'Send update',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Primary',
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'primary',
        },
      ],
      steps: [
        {
          id: 'send-dm',
          participantId: 'primary',
          role: 'custom',
          systemPromptOverride: 'Send the approved brief in a Slack DM.',
          inputs: ['user_prompt'],
          tools: ['Read'],
          effect: 'external',
          output: 'receipt.md',
        },
      ],
      source: 'user',
      filePath: '/tmp/external.yaml',
    },
  ],
}));

vi.mock('./preflight', () => ({
  preflightRun: async () => ({ ok: true, problems: [] }),
  formatPreflight: () => '',
}));

vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  createWorktreeAsync: vi.fn(),
  detectBaseBranchAsync: vi.fn(),
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';

describe('FlowRuntimeImpl.startRun', () => {
  it('stamps worker attribution onto the launched run', async () => {
    const runtime = new FlowRuntimeImpl(
      { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );

    const result = await runtime.startRun({
      flowId: 'flow-1',
      projectPath: '/tmp/project',
      userPrompt: 'Review the latest changes.',
      workerId: 'worker-1',
      workerName: 'Scout',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(runtime.getRun(result.runId)).toMatchObject({
      workerId: 'worker-1',
      workerName: 'Scout',
    });
  });

  it('refuses a worker worktree run that names the persistent source as an output', async () => {
    const runtime = new FlowRuntimeImpl(
      { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );

    const result = await runtime.startRun({
      flowId: 'flow-1',
      projectPath: '/tmp/project',
      userPrompt: 'Create a corrected report named /tmp/project/report.html.',
      runIn: 'worktree',
      workerId: 'worker-1',
      workerName: 'Scout',
    });

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('persistent project/workspace'),
    });
    expect(runtime.listRuns()).toEqual([]);
  });

  it('pauses a worker before an external first step without starting it', async () => {
    const send = vi.fn(() => ({ ok: true as const }));
    const runtime = new FlowRuntimeImpl(
      { send, prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );

    const result = await runtime.startRun({
      flowId: 'external-flow',
      projectPath: '/tmp/project',
      userPrompt: 'Send the update.',
      workerId: 'worker-1',
      workerName: 'Scout',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(runtime.getRun(result.runId)?.state).toEqual({
      kind: 'paused',
      nextStepId: 'send-dm',
      reason: 'externalAction',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('starts an external first step when the worker explicitly allows external actions', async () => {
    const send = vi.fn(() => ({ ok: true as const }));
    const runtime = new FlowRuntimeImpl(
      { send, prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );

    const result = await runtime.startRun({
      flowId: 'external-flow',
      projectPath: '/tmp/project',
      userPrompt: 'Send the update.',
      workerId: 'worker-1',
      workerName: 'Scout',
      allowExternalActions: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(runtime.getRun(result.runId)).toMatchObject({
      allowExternalActions: true,
      state: { kind: 'running', currentStepId: 'send-dm' },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('shows a flow question, lets the owning Worker answer, and resumes the step', async () => {
    const sends: Array<{ conversationId: string; prompt: string }> = [];
    const runtime = new FlowRuntimeImpl(
      {
        send: (args: { conversationId: string; prompt: string }) => {
          sends.push(args);
          return { ok: true as const };
        },
        prewarm: () => {},
        dropIfPrewarmed: () => {},
      } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );
    runtime.setWorkerSupervisor(async () => ({
      kind: 'answer',
      answer: 'Use Unknown; it is explicit and accessible.',
    }));

    const result = await runtime.startRun({
      flowId: 'flow-1',
      projectPath: '/tmp/project',
      userPrompt: 'Choose the missing-value label.',
      workerId: 'worker-1',
      workerName: 'Scout',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const run = runtime.getRun(result.runId)!;
    const conversationId = run.conversationIds.primary;

    runtime.observeEvent({
      type: 'stream',
      conversationId,
      events: [
        {
          id: 'answer-1',
          timestamp: Date.now(),
          raw: '',
          revision: 0,
          kind: {
            type: 'assistant',
            info: {
              model: 'claude-sonnet-4-6',
              text: '<worker_question>Blank or Unknown?</worker_question>',
              toolUses: [],
              thinking: [],
            },
          },
        },
      ],
    });
    runtime.observeEvent({ type: 'running', conversationId, isRunning: false });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(run.workerExchanges).toMatchObject([
      {
        stepId: 'review',
        question: 'Blank or Unknown?',
        answer: 'Use Unknown; it is explicit and accessible.',
        status: 'answered',
      },
    ]);
    expect(run.attempts[0].outcome).toBe('question');
    expect(sends).toHaveLength(2);
    expect(sends[1].prompt).toContain('<worker_answer>Use Unknown; it is explicit and accessible.</worker_answer>');
    expect(run.state).toEqual({ kind: 'running', currentStepId: 'review' });
  });
});
