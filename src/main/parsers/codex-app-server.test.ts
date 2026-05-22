import { describe, expect, it } from 'vitest';
import {
  makeCodexAppServerParserState,
  parseCodexAppServerNotification,
  translateUserInputRequest,
} from './codex-app-server';

function parse(method: string, params: any, state = makeCodexAppServerParserState()) {
  return { result: parseCodexAppServerNotification(method, params, state, `${method}:raw`), state };
}

describe('parseCodexAppServerNotification', () => {
  it('returns sessionConfigured for thread/started', () => {
    const { result } = parse('thread/started', { thread: { id: 'thread-1' } });
    expect(result.events).toEqual([]);
    expect(result.sessionConfigured).toEqual({ sessionId: 'thread-1' });
  });

  it('streams agent message deltas and final completion through one event id', () => {
    const state = makeCodexAppServerParserState();
    const delta = parse('item/agentMessage/delta', { itemId: 'msg-1', delta: 'hello' }, state).result.events[0];
    const completed = parse(
      'item/completed',
      { item: { type: 'agentMessage', id: 'msg-1', text: 'hello world' } },
      state,
    ).result.events[0];
    if (delta.kind.type !== 'assistant' || completed.kind.type !== 'assistant') throw new Error();
    expect(delta.id).toBe(completed.id);
    expect(delta.kind.info.text).toBe('hello');
    expect(completed.kind.info.text).toBe('hello world');
    expect(completed.revision).toBeGreaterThan(delta.revision);
  });

  it('maps command execution start + complete into tool use and tool result', () => {
    const started = parse('item/started', {
      item: { type: 'commandExecution', id: 'cmd-1', command: 'ls -la' },
    }).result.events[0];
    const completed = parse('item/completed', {
      item: {
        type: 'commandExecution',
        id: 'cmd-1',
        aggregatedOutput: 'file.txt',
        status: 'completed',
      },
    }).result.events[0];
    if (started.kind.type !== 'assistant' || completed.kind.type !== 'toolResult') throw new Error();
    expect(started.kind.info.toolUses[0]).toMatchObject({
      id: 'cmd-1',
      name: 'Bash',
      inputJSON: JSON.stringify({ command: 'ls -la' }),
    });
    expect(completed.kind.results).toEqual([{ id: 'cmd-1', content: 'file.txt', isError: false }]);
  });

  it('maps file changes into patchApply with normalized change counts', () => {
    const completed = parse('item/completed', {
      item: {
        type: 'fileChange',
        id: 'patch-1',
        status: 'completed',
        changes: [
          { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@\n+add\n-del\n' },
          { path: 'b.ts', kind: { type: 'add' }, diff: '+new\n' },
        ],
      },
    }).result.events[0];
    if (completed.kind.type !== 'patchApply') throw new Error();
    expect(completed.kind.info.success).toBe(true);
    expect(completed.kind.info.files).toEqual([
      expect.objectContaining({ path: 'a.ts', kind: 'modify', additions: 1, deletions: 1 }),
      expect.objectContaining({ path: 'b.ts', kind: 'add', additions: 1, deletions: 0 }),
    ]);
  });

  it('maps turn completion status into a result event', () => {
    const ev = parse('turn/completed', { turn: { status: 'failed', durationMs: 42 } }).result.events[0];
    if (ev.kind.type !== 'result') throw new Error();
    expect(ev.kind.info).toMatchObject({ subtype: 'failed', isError: true, durationMs: 42 });
  });

  it('emits thread token usage on a text-less assistant event', () => {
    const events = parse('thread/tokenUsage/updated', {
      threadId: 't1',
      turnId: 'turn-1',
      tokenUsage: {
        total: { totalTokens: 1540, inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340, reasoningOutputTokens: 120 },
        last: { totalTokens: 1540, inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340, reasoningOutputTokens: 120 },
        modelContextWindow: 258400,
      },
    }).result.events;
    expect(events).toHaveLength(1);
    if (events[0].kind.type !== 'assistant') throw new Error();
    expect(events[0].kind.info.text).toBe('');
    expect(events[0].kind.info.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 0,
    });
  });

  it('emits cumulative-total deltas so repeated updates sum to the true spend', () => {
    const state = makeCodexAppServerParserState();
    const first = parse('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 0 } },
    }, state).result.events;
    if (first[0].kind.type !== 'assistant') throw new Error();
    expect(first[0].kind.info.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 });
    // Second update reports the running cumulative total, not a fresh delta.
    const second = parse('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 1500, outputTokens: 250, cachedInputTokens: 0 } },
    }, state).result.events;
    if (second[0].kind.type !== 'assistant') throw new Error();
    expect(second[0].kind.info.usage).toMatchObject({ inputTokens: 500, outputTokens: 150 });
  });

  it('skips the usage event when the cumulative total has not advanced', () => {
    const state = makeCodexAppServerParserState();
    parse('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, outputTokens: 5 } } }, state);
    const repeat = parse('thread/tokenUsage/updated', {
      tokenUsage: { total: { inputTokens: 10, outputTokens: 5 } },
    }, state).result.events;
    expect(repeat).toHaveLength(0);
  });

  it('reads snake_case token usage fields too', () => {
    const events = parse('thread/tokenUsage/updated', {
      tokenUsage: { total: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3 } },
    }).result.events;
    if (events[0].kind.type !== 'assistant') throw new Error();
    expect(events[0].kind.info.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
    });
  });

  it('maps turn completion with no usage to just a result event', () => {
    const events = parse('turn/completed', { turn: { status: 'completed', durationMs: 42 } }).result.events;
    expect(events).toHaveLength(1);
    expect(events[0].kind.type).toBe('result');
  });

  it('surfaces turn/completed error.message as a system notice before the result', () => {
    const events = parse('turn/completed', {
      turn: {
        status: 'failed',
        durationMs: 15028,
        error: {
          message: "You've hit your usage limit. Upgrade to Pro …",
          codexErrorInfo: 'usageLimitExceeded',
        },
      },
    }).result.events;
    expect(events).toHaveLength(2);
    if (events[0].kind.type !== 'systemNotice') throw new Error();
    expect(events[0].kind.text).toContain('usage limit');
    if (events[1].kind.type !== 'result') throw new Error();
    expect(events[1].kind.info.isError).toBe(true);
  });

  it('extracts nested error.message from a standalone error notification', () => {
    const ev = parse('error', { error: { code: -32603, message: 'boom' } }).result.events[0];
    if (ev.kind.type !== 'systemNotice') throw new Error();
    expect(ev.kind.text).toBe('boom');
  });

  it('dedupes the same error text across error and turn/completed notifications', () => {
    const state = makeCodexAppServerParserState();
    const text = "You've hit your usage limit. Upgrade to Pro …";
    const first = parse('error', { message: text }, state).result.events;
    expect(first).toHaveLength(1);
    const second = parse(
      'turn/completed',
      { turn: { status: 'failed', durationMs: 10, error: { message: text } } },
      state,
    ).result.events;
    // result event still fires; the duplicated systemNotice does not.
    expect(second.map((e) => e.kind.type)).toEqual(['result']);
  });
});

describe('translateUserInputRequest', () => {
  it('maps Codex requestUserInput into a userInputRequest event and response builder', () => {
    const translated = translateUserInputRequest('item/tool/requestUserInput', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      questions: [
        {
          id: 'confirm_path',
          header: 'Confirm path',
          question: 'Which path should I use?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'yes', description: 'Proceed with this path.' }],
        },
      ],
    });
    expect(translated).not.toBeNull();
    expect(translated!.requestId).toBe('call-1');
    expect(translated!.buildResult({ confirm_path: { answers: ['yes'] } })).toEqual({
      answers: { confirm_path: { answers: ['yes'] } },
    });
    if (translated!.event.kind.type !== 'userInputRequest') throw new Error();
    expect(translated!.event.kind.info).toMatchObject({
      backend: 'codex',
      requestId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      questions: [
        {
          id: 'confirm_path',
          header: 'Confirm path',
          question: 'Which path should I use?',
          isOther: true,
          isSecret: false,
          options: [{ label: 'yes', description: 'Proceed with this path.' }],
        },
      ],
    });
  });
});
