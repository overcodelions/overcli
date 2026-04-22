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
