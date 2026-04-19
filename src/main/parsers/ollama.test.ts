import { describe, it, expect } from 'vitest';
import {
  makeAssistantEvent,
  makeErrorEvent,
  makeResultEvent,
  makeSystemInitEvent,
} from './ollama';

describe('ollama event builders', () => {
  it('builds a systemInit event with fixed apiKeySource=none', () => {
    const ev = makeSystemInitEvent('llama3', '/cwd', 'sess-1');
    if (ev.kind.type !== 'systemInit') throw new Error();
    expect(ev.kind.info).toEqual({
      sessionId: 'sess-1',
      model: 'llama3',
      cwd: '/cwd',
      apiKeySource: 'none',
      tools: [],
      slashCommands: [],
      mcpServers: [],
    });
  });

  it('reuses a stable id across assistant snapshots and bumps revision', () => {
    const a = makeAssistantEvent('llama3', 'hel', 'id-1', 0);
    const b = makeAssistantEvent('llama3', 'hello', 'id-1', 1);
    expect(a.id).toBe('id-1');
    expect(b.id).toBe('id-1');
    expect(b.revision).toBe(1);
    if (b.kind.type !== 'assistant') throw new Error();
    expect(b.kind.info.text).toBe('hello');
  });

  it('builds a success result with model usage when eval counts are provided', () => {
    const ev = makeResultEvent({ durationMs: 100, evalCount: 9, promptEvalCount: 3 });
    if (ev.kind.type !== 'result') throw new Error();
    expect(ev.kind.info.isError).toBe(false);
    expect(ev.kind.info.subtype).toBe('success');
    expect(ev.kind.info.durationMs).toBe(100);
    expect(ev.kind.info.modelUsage.ollama).toEqual({
      inputTokens: 3,
      outputTokens: 9,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('omits model usage when no eval count is present', () => {
    const ev = makeResultEvent({ durationMs: 10 });
    if (ev.kind.type !== 'result') throw new Error();
    expect(ev.kind.info.modelUsage).toEqual({});
  });

  it('flags errors and passes through the message', () => {
    const ev = makeResultEvent({ error: 'boom' });
    if (ev.kind.type !== 'result') throw new Error();
    expect(ev.kind.info.isError).toBe(true);
    expect(ev.kind.info.subtype).toBe('error');
    expect(ev.raw).toBe('boom');
  });

  it('wraps error events as systemNotice with an Ollama prefix', () => {
    const ev = makeErrorEvent('connection refused');
    expect(ev.kind).toEqual({ type: 'systemNotice', text: 'Ollama error: connection refused' });
  });
});
