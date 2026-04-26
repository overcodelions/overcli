import { describe, expect, it } from 'vitest';
import { claudeBackend } from './claude';

function fresh() {
  const state = claudeBackend.makeParserState!();
  return state;
}

const initLine = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-abc',
  model: 'claude-sonnet',
  cwd: '/tmp',
  apiKeySource: 'env',
  tools: ['Read'],
  slash_commands: ['/help'],
  mcp_servers: [],
});

const resultLine = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 42,
  total_cost_usd: 0,
  modelUsage: {},
});

describe('claudeBackend.parseChunk', () => {
  it('parses a single complete line in one chunk', () => {
    const state = fresh();
    const out = claudeBackend.parseChunk!(initLine + '\n', state);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].kind.type).toBe('systemInit');
    expect(out.sessionConfigured).toEqual({ sessionId: 'sess-abc' });
  });

  it('buffers a partial line until the newline arrives', () => {
    const state = fresh();
    const half = initLine.slice(0, 30);
    const rest = initLine.slice(30) + '\n';
    const first = claudeBackend.parseChunk!(half, state);
    expect(first.events).toEqual([]);
    expect(first.sessionConfigured).toBeUndefined();
    const second = claudeBackend.parseChunk!(rest, state);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].kind.type).toBe('systemInit');
    expect(second.sessionConfigured).toEqual({ sessionId: 'sess-abc' });
  });

  it('parses multiple lines in a single chunk', () => {
    const state = fresh();
    const out = claudeBackend.parseChunk!(initLine + '\n' + resultLine + '\n', state);
    expect(out.events.map((e) => e.kind.type)).toEqual(['systemInit', 'result']);
  });

  it('keeps the trailing partial line across chunks', () => {
    const state = fresh();
    // Send init + half of result.
    const a = claudeBackend.parseChunk!(initLine + '\n' + resultLine.slice(0, 20), state);
    expect(a.events.map((e) => e.kind.type)).toEqual(['systemInit']);
    const b = claudeBackend.parseChunk!(resultLine.slice(20) + '\n', state);
    expect(b.events.map((e) => e.kind.type)).toEqual(['result']);
  });

  it('does not surface sessionConfigured for chunks without systemInit', () => {
    const state = fresh();
    const out = claudeBackend.parseChunk!(resultLine + '\n', state);
    expect(out.sessionConfigured).toBeUndefined();
    expect(out.events.map((e) => e.kind.type)).toEqual(['result']);
  });

  it('skips empty lines without emitting events', () => {
    const state = fresh();
    const out = claudeBackend.parseChunk!('\n\n' + initLine + '\n\n', state);
    expect(out.events).toHaveLength(1);
  });

  it('emits a parseError event for a malformed line without breaking later lines', () => {
    const state = fresh();
    const out = claudeBackend.parseChunk!('not json\n' + initLine + '\n', state);
    expect(out.events.map((e) => e.kind.type)).toEqual(['parseError', 'systemInit']);
    expect(out.sessionConfigured).toEqual({ sessionId: 'sess-abc' });
  });

  it('survives a single byte arriving at a time', () => {
    const state = fresh();
    const all = initLine + '\n';
    let collected: string[] = [];
    let lastSessionId: string | undefined;
    for (const ch of all) {
      const r = claudeBackend.parseChunk!(ch, state);
      for (const e of r.events) collected.push(e.kind.type);
      if (r.sessionConfigured) lastSessionId = r.sessionConfigured.sessionId;
    }
    expect(collected).toEqual(['systemInit']);
    expect(lastSessionId).toBe('sess-abc');
  });
});
