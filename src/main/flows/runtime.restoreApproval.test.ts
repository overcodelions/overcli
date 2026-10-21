import { describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ runs: [] as unknown[] }));

vi.mock('./runsStore', () => ({
  loadAllRuns: () => saved.runs,
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

import { FlowRuntimeImpl } from './runtime';
import type { FlowRun } from '../../shared/flows/schema';

const run = (id: string, tools: string[], approved: boolean): FlowRun =>
  ({
    id,
    flowId: 'f',
    flowSnapshot: { id: 'f', name: 'piece', input: 'user_prompt', participants: [], steps: [{ id: 'piece', role: 'custom', tools, output: 'piece.md' }] },
    projectPath: '/tmp/p',
    userPrompt: 'x',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'paused', nextStepId: 'piece', reason: 'interrupted' },
    createdAt: Date.now(),
    attempts: [],
    workerId: 'w1',
    ...(approved ? { externalActionApprovedStepId: 'piece' } : {}),
  }) as unknown as FlowRun;

describe('a restart in the middle of an approved step', () => {
  it('keeps the approval for research, and asks again for a step that writes to a service', () => {
    saved.runs = [
      run('research', ['Read', 'Bash', 'WebSearch', 'mcp__tracker__search_issues'], true),
      run('writes', ['Read', 'mcp__tracker__create_issue'], true),
      run('never-approved', ['Read', 'Bash'], false),
    ];
    const rt = new FlowRuntimeImpl({ send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never, () => {}, () => [], () => ({ backends: {} }) as never);
    expect(rt.getRun('research')?.state).toMatchObject({ kind: 'paused', reason: 'interrupted' });
    expect(rt.getRun('writes')?.state).toMatchObject({ kind: 'paused', reason: 'externalAction' });
    expect(rt.getRun('never-approved')?.state).toMatchObject({ kind: 'paused', reason: 'externalAction' });
  });
});

describe("a team piece's readable folders", () => {
  it("include the task's shared folder", () => {
    saved.runs = [];
    const rt = new FlowRuntimeImpl({ send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never, () => {}, () => [], () => ({ backends: {} }) as never);
    const dirs = (rt as unknown as { runAllowedDirs: (r: unknown) => string[] }).runAllowedDirs({ id: 'r-team', team: { teamId: 't', teamName: 'Council', taskId: 'task-9' } });
    expect(dirs.some((d) => /task-9$/.test(d))).toBe(true);
    const solo = (rt as unknown as { runAllowedDirs: (r: unknown) => string[] }).runAllowedDirs({ id: 'r-solo' });
    expect(solo.some((d) => /task-9$/.test(d))).toBe(false);
  });
});
