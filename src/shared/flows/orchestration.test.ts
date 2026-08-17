import { describe, expect, it } from 'vitest';

import {
  isOrchestrationComplete,
  isResidueOrchestration,
  ledgerBatches,
  parseCandidates,
  type Orchestration,
} from './orchestration';

describe('parseCandidates', () => {
  it('parses a clean tagged block', () => {
    const reply = [
      'Here are the small asks I found.',
      '',
      '<candidates>',
      JSON.stringify([
        { id: 'PB-1', title: 'Fix empty state', prompt: 'Add a fallback string', size: 'small' },
        { id: 'PB-2', title: 'Copy run id', prompt: 'Add a copy button', note: '5 votes' },
      ]),
      '</candidates>',
    ].join('\n');
    const out = parseCandidates(reply);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'PB-1', title: 'Fix empty state', size: 'small' });
    expect(out[1].note).toBe('5 votes');
  });

  it('accepts a { candidates: [...] } wrapper object', () => {
    const reply =
      '<candidates>{"candidates":[{"id":"a","title":"T","prompt":"P"}]}</candidates>';
    const out = parseCandidates(reply);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });

  it('falls back to a fenced json array with no wrapper', () => {
    const reply = 'prose\n```json\n[{"title":"Only title here"}]\n```\nmore prose';
    const out = parseCandidates(reply);
    expect(out).toHaveLength(1);
    // prompt falls back to title when only one is present
    expect(out[0].prompt).toBe('Only title here');
    // id synthesized when absent
    expect(out[0].id).toBe('cand-1');
  });

  it('falls back to the first balanced top-level array', () => {
    const reply = 'Found these: [{"id":"x","title":"X","prompt":"do x"}] — done.';
    const out = parseCandidates(reply);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('x');
  });

  it('maps a producer-suggested flowId onto suggestedFlowId', () => {
    const reply =
      '<candidates>[{"id":"d","title":"Docs","prompt":"update readme","flowId":"docs-tidy"}]</candidates>';
    const out = parseCandidates(reply);
    expect(out[0].suggestedFlowId).toBe('docs-tidy');
  });

  it('dedups colliding ids', () => {
    const reply =
      '<candidates>[{"id":"same","title":"A","prompt":"a"},{"id":"same","title":"B","prompt":"b"}]</candidates>';
    const out = parseCandidates(reply);
    expect(out).toHaveLength(2);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it('returns [] on empty array, junk, or no block', () => {
    expect(parseCandidates('<candidates>[]</candidates>')).toEqual([]);
    expect(parseCandidates('<candidates>not json</candidates>')).toEqual([]);
    expect(parseCandidates('just prose, no list at all')).toEqual([]);
  });

  it('skips entries with neither title nor prompt', () => {
    const reply = '<candidates>[{"id":"empty"},{"id":"ok","title":"keep","prompt":"p"}]</candidates>';
    const out = parseCandidates(reply);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('ok');
  });
});

describe('isOrchestrationComplete', () => {
  const base: Orchestration = {
    id: 'o1',
    title: 'b',
    projectPath: '/p',
    maxConcurrent: 2,
    items: [],
    createdAt: 0,
  };

  it('is true when every item is terminal', () => {
    const o: Orchestration = {
      ...base,
      items: [
        { candidate: { id: 'a', title: 'a', prompt: 'a' }, flowId: 'f', status: 'done' },
        { candidate: { id: 'b', title: 'b', prompt: 'b' }, flowId: 'f', status: 'failed' },
        { candidate: { id: 'c', title: 'c', prompt: 'c' }, flowId: 'f', status: 'cancelled' },
      ],
    };
    expect(isOrchestrationComplete(o)).toBe(true);
  });

  it('is false while any item is queued or running', () => {
    const o: Orchestration = {
      ...base,
      items: [
        { candidate: { id: 'a', title: 'a', prompt: 'a' }, flowId: 'f', status: 'done' },
        { candidate: { id: 'b', title: 'b', prompt: 'b' }, flowId: 'f', status: 'running' },
      ],
    };
    expect(isOrchestrationComplete(o)).toBe(false);
  });
});


describe('ledgerBatches', () => {
  const batch = (
    id: string,
    createdAt: number,
    items: Orchestration['items'],
    origin?: Orchestration['origin'],
  ): Orchestration => ({
    id,
    title: id,
    projectPath: '/p',
    maxConcurrent: 2,
    items,
    origin,
    createdAt,
  });
  const item = (status: Orchestration['items'][number]['status']) => ({
    candidate: { id: 'a', title: 'a', prompt: 'a' },
    flowId: 'f',
    status,
  });

  it('orders newest first, with no exception for a parked batch', () => {
    const parked = batch('old-parked', 10, [item('proposed')]);
    const fresh = batch('new-done', 20, [item('done')]);
    expect(ledgerBatches({ a: parked, b: fresh }).map((o) => o.id)).toEqual([
      'new-done',
      'old-parked',
    ]);
  });

  it('drops item-less batches — a worker answering in prose is not a run', () => {
    const errand = batch('errand', 30, [], {
      kind: 'worker',
      workerId: 'w1',
      workerName: 'Warden',
      task: 'errand',
    });
    const real = batch('real', 20, [item('running')]);
    expect(ledgerBatches({ a: errand, b: real }).map((o) => o.id)).toEqual(['real']);
  });
});

describe('isResidueOrchestration', () => {
  const empty = (origin?: Orchestration['origin']): Orchestration => ({
    id: 'x',
    title: 'x',
    projectPath: '/p',
    maxConcurrent: 1,
    items: [],
    origin,
    createdAt: 0,
  });

  it('is true for an item-less schedule or manual batch', () => {
    expect(isResidueOrchestration(empty())).toBe(true);
    expect(
      isResidueOrchestration(
        empty({ kind: 'schedule', scheduleId: 's1', scheduleName: 'Morning triage' }),
      ),
    ).toBe(true);
  });

  // Deleting this record would eat the worker's reply along with it.
  it('is false for an item-less worker batch — that record is a desk turn', () => {
    expect(
      isResidueOrchestration(empty({ kind: 'worker', workerId: 'w1', workerName: 'Warden' })),
    ).toBe(false);
  });

  it('is false whenever there are items at all', () => {
    const o = empty();
    o.items = [{ candidate: { id: 'a', title: 'a', prompt: 'a' }, flowId: 'f', status: 'done' }];
    expect(isResidueOrchestration(o)).toBe(false);
  });
});
