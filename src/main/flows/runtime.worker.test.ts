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
});
