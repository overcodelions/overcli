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

  // The bug this section was reported for: a workspace run whose owner path
  // was persisted with the pre-`productName` spelling of userData. Its sidebar
  // row named the workspace (that lookup already case-folded) while the
  // workspace's own Flows section, filtering with `===`, showed nothing — so
  // the run appeared to belong to a workspace that did not contain it.
  it('matches an owner path stored with the other spelling of userData', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
    try {
      const root = '/Users/bob/Library/Application Support/Overcli/workspaces/ws-1';
      const runs = {
        stale: run('stale', {
          projectPath: '/Users/bob/Library/Application Support/overcli/coordinators/stale',
          sourceProjectPath: root.replace('/Overcli/', '/overcli/'),
        }),
      };
      expect(flowRunsForPath(runs, root, '')).toMatchObject([{ id: 'stale' }]);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});
