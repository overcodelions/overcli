import { describe, expect, it } from 'vitest';

import { flowRunsForPath } from './FlowRunSidebarRow';
import type { FlowRun } from '@shared/flows/schema';

function run(id: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Maintenance', steps: [], participants: [] },
    projectPath: '/repo',
    userPrompt: 'Fix the flaky spec',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done' },
    createdAt: 1,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

describe('flowRunsForPath', () => {
  it('keeps user runs only, applies query, and sorts newest first', () => {
    const runs = {
      worker: run('worker', { workerId: 'worker-1', createdAt: 30 }),
      other: run('other', { projectPath: '/other', createdAt: 20 }),
      old: run('old', { createdAt: 10 }),
      new: run('new', { createdAt: 20, title: 'Fix CI flake' }),
    };
    expect(flowRunsForPath(runs, '/repo', '')).toMatchObject([{ id: 'new' }, { id: 'old' }]);
    expect(flowRunsForPath(runs, '/repo', 'ci')).toMatchObject([{ id: 'new' }]);
  });
});
