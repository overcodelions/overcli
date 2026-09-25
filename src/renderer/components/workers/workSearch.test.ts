import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';
import { searchWork } from './workSearch';

function batch(id: string, workerName: string, items: Array<{ id: string; title: string; prompt?: string; at: number; runId?: string }>, over: Partial<Orchestration> = {}): Orchestration {
  return {
    id,
    title: `[Shift 1] ${workerName}`,
    projectPath: '/repo',
    maxConcurrent: 1,
    createdAt: 0,
    origin: { kind: 'worker', workerId: `w-${workerName}`, workerName, task: 'shift' },
    items: items.map((i) => ({
      candidate: { id: i.id, title: i.title, prompt: i.prompt ?? '' },
      flowId: 'f',
      status: 'done',
      finishedAt: i.at,
      ...(i.runId ? { runId: i.runId } : {}),
    })),
    ...over,
  } as Orchestration;
}

const orchestrations = {
  a: batch('a', 'Soraya', [
    { id: '1', title: 'Weekly gap review', prompt: 'find hotel and car gaps', at: 300, runId: 'r1' },
    { id: '2', title: 'Pre-departure check', at: 200 },
  ]),
  b: batch('b', 'Triage', [{ id: '1', title: 'Fix hotel booking page crash', at: 100 }]),
  c: {
    ...batch('c', 'Ahana', [{ id: '1', title: 'Sweep', at: 50 }]),
    origin: { kind: 'worker', workerId: 'w-Ahana', workerName: 'Ahana', task: 'errand', errand: 'check the staging deploy' },
  } as Orchestration,
  sched: { ...batch('s', 'x', [{ id: '1', title: 'hotel', at: 999 }]), origin: { kind: 'schedule', scheduleId: 's', scheduleName: 'n' } } as Orchestration,
};
const runs = { r1: { digest: { headline: 'London hotel not booked — 3 options' } } as FlowRun };

describe('searchWork', () => {
  it('finds jobs by any field, newest first, and only worker jobs', () => {
    expect(searchWork(orchestrations, runs, 'hotel').map((m) => m.title)).toEqual([
      'Weekly gap review',
      'Fix hotel booking page crash',
    ]);
  });

  it('needs every word, in any field and any order', () => {
    expect(searchWork(orchestrations, runs, 'hotel soraya').map((m) => m.title)).toEqual(['Weekly gap review']);
    expect(searchWork(orchestrations, runs, 'LONDON').map((m) => m.headline)).toEqual([
      'London hotel not booked — 3 options',
    ]);
  });

  it('matches what you asked an errand to do', () => {
    expect(searchWork(orchestrations, runs, 'staging deploy')).toMatchObject([{ workerName: 'Ahana', task: 'errand' }]);
  });

  it('returns nothing for an empty query, and respects the limit', () => {
    expect(searchWork(orchestrations, runs, '   ')).toEqual([]);
    expect(searchWork(orchestrations, runs, 'e', 2)).toHaveLength(2);
  });
});
