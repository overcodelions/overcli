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
      id: 'shell-flow',
      name: 'Ticket tally',
      input: 'user_prompt',
      participants: [{ id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' }],
      steps: [
        { id: 'gather', participantId: 'primary', role: 'researcher', inputs: [], tools: ['Read', 'Bash'], effect: 'local', output: 'issues.json' },
        { id: 'tally', participantId: 'primary', role: 'researcher', inputs: ['issues.json'], tools: ['Read', 'Bash', 'Write'], effect: 'local', output: 'counts.json' },
      ],
      source: 'user',
      filePath: '/tmp/shell.yaml',
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

import { FlowRuntimeImpl, pauseReasonBeforeStep } from './runtime';

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

  it('saves a run the moment it starts, so a restart a second later still has it', async () => {
    const { saveRun } = await import('./runsStore');
    (saveRun as unknown as { mockClear: () => void }).mockClear();
    const runtime = new FlowRuntimeImpl(
      { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );
    const result = await runtime.startRun({ flowId: 'flow-1', projectPath: '/tmp/project', userPrompt: 'Review it.', workerId: 'worker-1', workerName: 'Scout' });
    if (!result.ok) throw new Error(result.error);
    expect((saveRun as unknown as { mock: { calls: Array<[{ id: string }]> } }).mock.calls.some(([r]) => r.id === result.runId)).toBe(true);
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

  it('approving a step for the run lets later steps needing only the same tools through, and just this step does not', async () => {
    const make = () => new FlowRuntimeImpl({ send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never, () => {}, () => [], () => ({ backends: {} }) as never);
    const start = async (runtime: FlowRuntimeImpl) => {
      const r = await runtime.startRun({ flowId: 'shell-flow', projectPath: '/tmp/project', userPrompt: 'Tally my tickets.', workerId: 'worker-1', workerName: 'Ruby' });
      if (!r.ok) throw new Error(r.error);
      expect(runtime.getRun(r.runId)?.state).toMatchObject({ kind: 'paused', nextStepId: 'gather', reason: 'externalAction' });
      return r.runId;
    };
    const tally = (runtime: FlowRuntimeImpl, id: string) => runtime.getRun(id)!.flowSnapshot.steps[1];

    const whole = make();
    const a = await start(whole);
    expect(whole.resumeRun({ runId: a, forRun: true }).ok).toBe(true);
    expect(whole.getRun(a)?.externalActionRunGrant).toEqual(['bash']);
    expect(pauseReasonBeforeStep(whole.getRun(a)!, tally(whole, a))).toBeNull();

    const once = make();
    const b = await start(once);
    expect(once.resumeRun({ runId: b }).ok).toBe(true);
    expect(once.getRun(b)?.externalActionRunGrant).toBeUndefined();
    expect(pauseReasonBeforeStep(once.getRun(b)!, tally(once, b))).toBe('externalAction');
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

describe('the Today digest headline', () => {
  async function workerRun(workerId?: string) {
    const sends: Array<{ prompt: string }> = [];
    const runtime = new FlowRuntimeImpl(
      {
        send: (args: { prompt: string }) => {
          sends.push(args);
          return { ok: true };
        },
        prewarm: () => {},
        dropIfPrewarmed: () => {},
      } as never,
      () => {},
      () => [],
      () => ({ backends: {} }) as never,
    );
    const result = await runtime.startRun({
      flowId: 'flow-1',
      projectPath: '/tmp/project',
      userPrompt: 'Review the latest changes.',
      ...(workerId ? { workerId, workerName: 'Scout' } : {}),
    });
    if (!result.ok) throw new Error(result.error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { runtime, sends, run: runtime.getRun(result.runId)! };
  }

  it('asks a worker run’s last step for a headline, and not an ordinary run', async () => {
    const worker = await workerRun('worker-1');
    expect(worker.sends[0].prompt).toContain('<headline>');
    const plain = await workerRun();
    expect(plain.sends[0].prompt).not.toContain('<headline>');
  });

  it('records the headline the step wrote on the run', async () => {
    const { runtime, run } = await workerRun('worker-1');
    const conversationId = run.conversationIds.primary;
    runtime.observeEvent({
      type: 'stream',
      conversationId,
      events: [
        {
          id: 'final',
          timestamp: Date.now(),
          raw: '',
          revision: 0,
          kind: {
            type: 'assistant',
            info: {
              model: 'claude-sonnet-4-6',
              text: '<output name="review.md">Looks fine.</output>\n<headline>No regressions in the last 3 merges</headline>\n<points>\n- 2 flaky tests\n</points>',
              toolUses: [],
              thinking: [],
            },
          },
        },
      ],
    });
    runtime.observeEvent({ type: 'running', conversationId, isRunning: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run.digest).toEqual({ headline: 'No regressions in the last 3 merges', points: ['2 flaky tests'] });
  });
});

describe('FlowRuntimeImpl browsing', () => {
  const runtime = new FlowRuntimeImpl(
    { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as never,
  );
  const browseFor = (run: object, backend: string): boolean =>
    (runtime as unknown as { browseFor: (r: object, b: string) => boolean }).browseFor(run, backend);

  it('gives a codex worker the network only with the grant for external actions', () => {
    expect(browseFor({ chrome: true, workerId: 'w1' }, 'codex')).toBe(false);
    expect(browseFor({ chrome: true, unattended: true }, 'codex')).toBe(false);
    expect(browseFor({ chrome: true, workerId: 'w1', allowExternalActions: true }, 'codex')).toBe(true);
  });

  it('leaves Claude in Chrome and runs you started yourself as they were', () => {
    expect(browseFor({ chrome: true, workerId: 'w1' }, 'claude')).toBe(true);
    expect(browseFor({ chrome: true }, 'codex')).toBe(true);
    expect(browseFor({ workerId: 'w1', allowExternalActions: true }, 'codex')).toBe(false);
  });
});
