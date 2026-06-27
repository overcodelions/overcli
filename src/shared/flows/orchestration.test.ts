import { describe, expect, it } from 'vitest';

import {
  isOrchestrationComplete,
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
