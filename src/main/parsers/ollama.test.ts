import { describe, it, expect } from 'vitest';
import {
  makeAssistantEvent,
  makeErrorEvent,
  makeResultEvent,
  makeSystemInitEvent,
  ollamaUsage,
} from './ollama';

describe('ollamaUsage', () => {
  it('maps eval counts onto ModelUsage with zeroed cache fields', () => {
    expect(ollamaUsage({ promptEvalCount: 23040, evalCount: 512 })).toEqual({
      inputTokens: 23040,
      outputTokens: 512,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('returns undefined rather than a misleading zero usage', () => {
    expect(ollamaUsage(undefined)).toBeUndefined();
    expect(ollamaUsage({})).toBeUndefined();
    expect(ollamaUsage({ promptEvalCount: 0, evalCount: 0 })).toBeUndefined();
  });
});

describe('assistant snapshots carry thinking and usage', () => {
  it('attaches reasoning so the bubble is not blank while the model thinks', () => {
    const ev = makeAssistantEvent('gemma4:26b', '', 'id-1', 3, { thinking: 'weighing options' });
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.text).toBe('');
    expect(ev.kind.info.thinking).toEqual(['weighing options']);
  });

  it('omits usage entirely when the round reported none', () => {
    const ev = makeAssistantEvent('gemma4:26b', 'hi', 'id-1', 0);
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.usage).toBeUndefined();
    expect(ev.kind.info.thinking).toEqual([]);
  });

  it('carries usage through onto the settled snapshot', () => {
    const ev = makeAssistantEvent('gemma4:26b', 'done', 'id-1', 4, {
      usage: ollamaUsage({ promptEvalCount: 10, evalCount: 2 }),
    });
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.usage?.inputTokens).toBe(10);
    expect(ev.kind.info.usage?.outputTokens).toBe(2);
  });
});

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

describe('streaming snapshots are marked partial', () => {
  // `isPartial` means "cumulative snapshot of the message currently
  // streaming — replace what you had". Its absence means "a message
  // finished — append it" (runner.ts oneShotWaiter, runtime.ts step
  // buffer). Every Ollama delta carries the round's cumulative text, so
  // emitting them unmarked made both consumers append the message once per
  // token: "h", "he", "hel", … all concatenated into the step's artifact.
  it('marks a mid-stream delta so consumers replace rather than append', () => {
    const ev = makeAssistantEvent('gemma4:26b', 'hel', 'id-1', 2, { isPartial: true });
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.isPartial).toBe(true);
  });

  it('leaves the settled end-of-round snapshot unmarked so it is appended once', () => {
    const ev = makeAssistantEvent('gemma4:26b', 'hello', 'id-1', 3, {
      usage: ollamaUsage({ promptEvalCount: 10, evalCount: 2 }),
    });
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.isPartial).toBeUndefined();
  });
});
