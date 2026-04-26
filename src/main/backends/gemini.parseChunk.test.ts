import { describe, expect, it } from 'vitest';
import { geminiBackend } from './gemini';

function fresh() {
  return geminiBackend.makeParserState!();
}

const initLine = JSON.stringify({
  type: 'init',
  session_id: 'sess-g',
  model: 'gemini-2.5',
  cwd: '/tmp',
});

function deltaLine(text: string) {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    delta: true,
    content: text,
  });
}

function finalAssistant(text: string) {
  return JSON.stringify({
    type: 'message',
    role: 'assistant',
    content: text,
  });
}

const toolResultLine = JSON.stringify({
  type: 'tool_result',
  tool_call_id: 'tc1',
  output: 'ok',
});

describe('geminiBackend.parseChunk', () => {
  it('extracts sessionConfigured from init', () => {
    const s = fresh();
    const out = geminiBackend.parseChunk!(initLine + '\n', s);
    expect(out.events.map((e) => e.kind.type)).toEqual(['systemInit']);
    expect(out.sessionConfigured).toEqual({ sessionId: 'sess-g' });
  });

  it('coalesces deltas into a single growing assistant snapshot with stable id', () => {
    const s = fresh();
    const out = geminiBackend.parseChunk!(deltaLine('hello ') + '\n' + deltaLine('world') + '\n', s);
    expect(out.events).toHaveLength(2);
    expect(out.events[0].id).toBe(out.events[1].id);
    expect((out.events[1].kind as any).info.text).toBe('hello world');
  });

  it('replaces (does not append) on a non-delta assistant message', () => {
    const s = fresh();
    geminiBackend.parseChunk!(deltaLine('partial ') + '\n', s);
    const out = geminiBackend.parseChunk!(finalAssistant('full final answer') + '\n', s);
    expect((out.events[0].kind as any).info.text).toBe('full final answer');
  });

  it('toolResult marks the next assistant message as a fresh coalesce', () => {
    const s = fresh();
    geminiBackend.parseChunk!(deltaLine('first ') + '\n', s);
    geminiBackend.parseChunk!(toolResultLine + '\n', s);
    const out = geminiBackend.parseChunk!(deltaLine('second turn') + '\n', s);
    expect((out.events[0].kind as any).info.text).toBe('second turn');
  });

  it('survives partial lines split across chunks', () => {
    const s = fresh();
    const half = initLine.slice(0, 20);
    const rest = initLine.slice(20) + '\n';
    expect(geminiBackend.parseChunk!(half, s).events).toEqual([]);
    const out = geminiBackend.parseChunk!(rest, s);
    expect(out.events.map((e) => e.kind.type)).toEqual(['systemInit']);
  });
});
