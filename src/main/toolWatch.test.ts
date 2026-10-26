import { afterEach, describe, expect, it } from 'vitest';
import { setToolWatcher, watchToolEvents, type ToolOutcome } from './toolWatch';

afterEach(() => setToolWatcher(null));

describe('watching tool results', () => {
  it('pairs each MCP result with its call, and ignores built-in tools', () => {
    const seen: ToolOutcome[] = [];
    setToolWatcher((o) => seen.push(o));
    const stream = (events: unknown[]) => ({ type: 'stream', conversationId: 'c1', events }) as never;
    watchToolEvents(stream([{ kind: { type: 'assistant', info: { toolUses: [{ id: 't1', name: 'mcp__acme_tracker__search', inputJSON: '{}' }, { id: 't2', name: 'Read', inputJSON: '{}' }] } } }]));
    watchToolEvents(stream([{ kind: { type: 'toolResult', results: [{ id: 't1', content: '403 Forbidden', isError: true }, { id: 't2', content: 'file', isError: false }] } }]));
    expect(seen).toEqual([{ conversationId: 'c1', server: 'acme_tracker', call: 'search', ok: false, text: '403 Forbidden' }]);
  });
});
