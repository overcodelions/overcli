import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import { receiverBatch, senderBatch } from './handoffLinks';

function batch(
  id: string,
  workerId: string,
  createdAt: number,
  from?: { workerId: string; workerName: string; orchestrationId?: string },
): Orchestration {
  return {
    id,
    title: id,
    items: [],
    createdAt,
    origin: { kind: 'worker', workerId, workerName: workerId, task: 'errand', ...(from ? { from } : {}) },
  } as unknown as Orchestration;
}

describe('handoff links', () => {
  it('follows a recorded sender batch both ways', () => {
    const all = {
      a1: batch('a1', 'ann', 100),
      a2: batch('a2', 'ann', 200),
      b1: batch('b1', 'bob', 300, { workerId: 'ann', workerName: 'Ann', orchestrationId: 'a1' }),
    };
    expect(senderBatch(all.b1, all)?.id).toBe('a1');
    expect(receiverBatch(all.a1, 'bob', all)?.id).toBe('b1');
    expect(receiverBatch(all.a2, 'bob', all)).toBeUndefined();
  });

  it('falls back to the sender turn that began just before, for older handoffs', () => {
    const all = {
      a1: batch('a1', 'ann', 100),
      a2: batch('a2', 'ann', 200),
      a3: batch('a3', 'ann', 400),
      b1: batch('b1', 'bob', 300, { workerId: 'ann', workerName: 'Ann' }),
    };
    expect(senderBatch(all.b1, all)?.id).toBe('a2');
    expect(receiverBatch(all.a2, 'bob', all)?.id).toBe('b1');
  });

  it('has no sender for work a person asked for', () => {
    const all = { b1: batch('b1', 'bob', 300) };
    expect(senderBatch(all.b1, all)).toBeUndefined();
  });
});
