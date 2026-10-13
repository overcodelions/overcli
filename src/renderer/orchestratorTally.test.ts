import { describe, expect, it } from 'vitest';

import type { Orchestration, OrchestrationItem } from '@shared/flows/orchestration';
import { liveOrchestratorBatches, movingLine, tallyOf } from './orchestratorTally';

const item = (status: OrchestrationItem['status']) =>
  ({ candidate: { id: status, title: status, prompt: '' }, flowId: 'f', status }) as OrchestrationItem;
const batch = (id: string, items: OrchestrationItem[], extra: Partial<Orchestration> = {}) =>
  ({ id, title: id, projectPath: '/p', maxConcurrent: 1, createdAt: Number(id.slice(1)), items, ...extra }) as Orchestration;

describe('liveOrchestratorBatches', () => {
  it('keeps your own batches that are going or waiting on you, newest first', () => {
    const live = liveOrchestratorBatches({
      b1: batch('b1', [item('running'), item('queued')]),
      b2: batch('b2', [item('done'), item('failed')], { completedAt: 5 }),
      b3: batch('b3', [item('done'), item('cancelled')], { completedAt: 5 }),
      b4: batch('b4', [item('running')], { origin: { kind: 'worker', workerId: 'w', workerName: 'W' } }),
    });
    expect(live.map((b) => b.id)).toEqual(['b2', 'b1']);
  });

  it('says what is moving', () => {
    expect(movingLine(tallyOf([batch('b1', [item('running'), item('queued'), item('queued')])]))).toBe(
      '1 running · 2 queued',
    );
    expect(movingLine(tallyOf([batch('b1', [item('done')])]))).toBe('');
  });
});
