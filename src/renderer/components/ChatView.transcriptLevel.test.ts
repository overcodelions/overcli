import { describe, expect, it } from 'vitest';
import type { StreamEvent, ToolUseBlock } from '@shared/types';
import { filterRendered } from './ChatView';
import { turnActivityByResult } from './TurnActivity';

// A turn that only ran tools: no prose, nothing that stays visible at Quiet.
const read: ToolUseBlock = { id: 't1', name: 'Read', inputJSON: '{"file_path":"/a.ts"}' };
const events = [
  { id: 'u', timestamp: 0, raw: '', revision: 0, kind: { type: 'localUser', text: 'look' } },
  {
    id: 'a',
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: { type: 'assistant', info: { text: '', thinking: [], toolUses: [read], isPartial: false } },
  },
  { id: 'r', timestamp: 0, raw: '', revision: 0, kind: { type: 'result', info: { isError: false } } },
] as unknown as StreamEvent[];
const uses = new Map([[read.id, read]]);
const ids = (evs: StreamEvent[]) => evs.map((e) => e.id);

describe('filterRendered by transcript level', () => {
  it('drops a tools-only turn entirely at quiet', () => {
    expect(ids(filterRendered(events, 'quiet', uses, new Map()))).toEqual(['u']);
  });

  it("keeps the turn's closing row at summary, where its activity line lives", () => {
    expect(ids(filterRendered(events, 'summary', uses, new Map(), turnActivityByResult(events)))).toEqual(['u', 'r']);
  });

  it('shows the tool call itself at detailed', () => {
    expect(ids(filterRendered(events, 'detailed', uses, new Map()))).toEqual(['u', 'a', 'r']);
  });
});
