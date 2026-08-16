import { describe, expect, it } from 'vitest';

import { flowDeletionBlocker } from './flowGuards';
import type { Schedule } from '../../shared/flows/schedule';
import type { Worker } from '../../shared/flows/worker';

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'Scout',
    jobDescription: 'Find valuable maintenance work and propose it.',
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 20,
    heartbeatModel: 'cheap',
    flowIds: ['fix-it'],
    enabled: true,
    createdAt: 1,
    ...over,
  };
}

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    name: 'Morning triage',
    enabled: true,
    projectPath: '/repo',
    target: { kind: 'flow', flowId: 'triage', prompt: 'go', runIn: 'worktree' },
    trigger: { kind: 'daily', time: '09:00' },
    onOverlap: 'skip',
    catchUp: 'skip',
    createdAt: 1,
    history: [],
    ...over,
  } as Schedule;
}

describe('flowDeletionBlocker', () => {
  it('lets an unreferenced flow go', () => {
    expect(flowDeletionBlocker('free-flow', [worker()], [schedule()])).toBeNull();
  });

  it('blocks a flow on a worker contract, naming the worker', () => {
    expect(flowDeletionBlocker('fix-it', [worker()], [])).toContain('"Scout"');
  });

  it('blocks even when the worker is paused — a paused contract still holds', () => {
    expect(flowDeletionBlocker('fix-it', [worker({ enabled: false })], [])).toContain('"Scout"');
  });

  it('blocks a flow a schedule targets, naming the schedule', () => {
    expect(flowDeletionBlocker('triage', [], [schedule()])).toContain('"Morning triage"');
  });

  it('names the worker before the schedule when both reference it', () => {
    const both = flowDeletionBlocker(
      'fix-it',
      [worker()],
      [schedule({ target: { kind: 'flow', flowId: 'fix-it', prompt: 'go', runIn: 'worktree' } })],
    );
    expect(both).toContain('"Scout"');
  });
});
