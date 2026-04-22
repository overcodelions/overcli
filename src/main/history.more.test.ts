import { describe, expect, it } from 'vitest';
import {
  claudeProjectSlug,
  codexContentText,
  dedupeCodexEvents,
  normalizePathKey,
  normalizeSigText,
  numberOrZero,
  parseClaudeHistoryLine,
  parseCodexHistoryLine,
} from './history';
import type { StreamEvent } from '../shared/types';

describe('claudeProjectSlug', () => {
  it('replaces /, ., and spaces with dashes', () => {
    expect(claudeProjectSlug('/tmp/this.one has spaces')).toBe('-tmp-this-one-has-spaces');
  });

  it('returns the raw slugged string when the path cannot be resolved', () => {
    // A nonexistent path falls through the realpathSync try-catch and uses the raw input.
    const slug = claudeProjectSlug('/does/not/exist/at/all/unique-xyz-12345');
    expect(slug).toBe('-does-not-exist-at-all-unique-xyz-12345');
  });
});

describe('numberOrZero', () => {
  it('returns finite numbers unchanged', () => {
    expect(numberOrZero(0)).toBe(0);
    expect(numberOrZero(42)).toBe(42);
    expect(numberOrZero(-3.5)).toBe(-3.5);
  });

  it('returns 0 for non-numbers, NaN, and infinities', () => {
    expect(numberOrZero(null)).toBe(0);
    expect(numberOrZero(undefined)).toBe(0);
    expect(numberOrZero('42')).toBe(0);
    expect(numberOrZero(NaN)).toBe(0);
    expect(numberOrZero(Infinity)).toBe(0);
    expect(numberOrZero(-Infinity)).toBe(0);
  });
});

describe('normalizePathKey', () => {
  it('lowercases and swaps / for \\ so POSIX/Windows paths compare equal', () => {
    expect(normalizePathKey('/Users/Lionel/Project')).toBe('\\users\\lionel\\project');
  });
});

describe('normalizeSigText', () => {
  it('collapses runs of whitespace to a single space', () => {
    expect(normalizeSigText('  hello   world\t\tfoo  ')).toBe('hello world foo');
  });

  it('handles null and empty strings gracefully', () => {
    expect(normalizeSigText('')).toBe('');
    // @ts-expect-error — exercise the defensive null-guard
    expect(normalizeSigText(null)).toBe('');
  });

  it('caps output at 500 characters', () => {
    const input = 'a'.repeat(1000);
    expect(normalizeSigText(input).length).toBe(500);
  });
});

describe('codexContentText', () => {
  it('flattens text, input_text, and output_text blocks', () => {
    const blocks = [
      { text: 'hello ' },
      { input_text: 'world' },
      { output_text: '!' },
    ];
    expect(codexContentText(blocks)).toBe('hello world!');
  });

  it('ignores blocks with no recognized text field', () => {
    expect(codexContentText([{ foo: 'bar' }, { text: 'only this' }])).toBe('only this');
  });

  it('returns empty string on empty input', () => {
    expect(codexContentText([])).toBe('');
  });
});

describe('parseClaudeHistoryLine', () => {
  it('returns [] on blank or malformed JSON lines', () => {
    expect(parseClaudeHistoryLine('')).toEqual([]);
    expect(parseClaudeHistoryLine('   ')).toEqual([]);
    expect(parseClaudeHistoryLine('not json')).toEqual([]);
  });

  it('parses a plain user message as a localUser event', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: 1000,
      message: { content: 'hi there' },
    });
    const [ev] = parseClaudeHistoryLine(line);
    expect(ev.timestamp).toBe(1000);
    expect(ev.kind).toEqual({ type: 'localUser', text: 'hi there' });
  });

  it('unwraps a system-reminder isMeta user message into a metaReminder', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: 1000,
      isMeta: true,
      message: { content: '<system-reminder>be brief</system-reminder>' },
    });
    const [ev] = parseClaudeHistoryLine(line);
    expect(ev.kind).toEqual({ type: 'metaReminder', text: 'be brief' });
  });

  it('parses an assistant event with text, thinking, and a tool_use block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 2000,
      message: {
        model: 'claude-sonnet',
        content: [
          { type: 'text', text: 'I will read ' },
          { type: 'text', text: 'the file.' },
          { type: 'thinking', thinking: 'planning the read' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: '/src/foo.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    });
    const [assistant] = parseClaudeHistoryLine(line);
    expect(assistant.kind.type).toBe('assistant');
    const info = (assistant.kind as any).info;
    expect(info.model).toBe('claude-sonnet');
    expect(info.text).toBe('I will read the file.');
    expect(info.thinking).toEqual(['planning the read']);
    expect(info.toolUses).toHaveLength(1);
    expect(info.toolUses[0]).toMatchObject({
      id: 'tool-1',
      name: 'Read',
      filePath: '/src/foo.ts',
      oldString: 'a',
      newString: 'b',
    });
  });

  it('synthesizes a result event from message.usage when token counts are non-zero', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 3000,
      message: {
        model: 'claude-sonnet',
        content: [{ type: 'text', text: 'ok' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
    });
    const events = parseClaudeHistoryLine(line);
    expect(events).toHaveLength(2);
    expect(events[1].kind.type).toBe('result');
    const info = (events[1].kind as any).info;
    expect(info.modelUsage['claude-sonnet']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    });
  });

  it('skips the synthetic result event when every usage field is 0', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 3000,
      message: {
        model: 'claude-sonnet',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const events = parseClaudeHistoryLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].kind.type).toBe('assistant');
  });
});

describe('parseCodexHistoryLine', () => {
  it('returns null on blank or malformed lines', () => {
    expect(parseCodexHistoryLine('')).toBeNull();
    expect(parseCodexHistoryLine('not json')).toBeNull();
  });

  it('parses a user message into a localUser event', () => {
    const line = JSON.stringify({
      timestamp: 1000,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ text: 'please do X' }],
      },
    });
    const ev = parseCodexHistoryLine(line);
    expect(ev?.kind).toEqual({ type: 'localUser', text: 'please do X' });
  });

  it('filters out system/developer messages', () => {
    const base = { timestamp: 1000, payload: { type: 'message', content: [{ text: 'x' }] } };
    expect(parseCodexHistoryLine(JSON.stringify({ ...base, payload: { ...base.payload, role: 'system' } }))).toBeNull();
    expect(parseCodexHistoryLine(JSON.stringify({ ...base, payload: { ...base.payload, role: 'developer' } }))).toBeNull();
  });

  it('filters out environment_context probe messages', () => {
    const line = JSON.stringify({
      timestamp: 1000,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ text: 'hi <environment_context>stuff</environment_context>' }],
      },
    });
    expect(parseCodexHistoryLine(line)).toBeNull();
  });

  it('parses a shell function_call into a Bash ToolUseBlock with joined command', () => {
    const line = JSON.stringify({
      timestamp: 2000,
      payload: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'shell',
        arguments: JSON.stringify({ command: ['ls', '-la'] }),
      },
    });
    const ev = parseCodexHistoryLine(line);
    expect(ev?.kind.type).toBe('assistant');
    const toolUse = (ev!.kind as any).info.toolUses[0];
    expect(toolUse.name).toBe('Bash');
    expect(JSON.parse(toolUse.inputJSON)).toEqual({ command: 'ls -la' });
  });

  it('parses a function_call_output into a toolResult event and unwraps nested output', () => {
    const line = JSON.stringify({
      timestamp: 2500,
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: JSON.stringify({ output: 'file listing' }),
      },
    });
    const ev = parseCodexHistoryLine(line);
    expect(ev?.kind).toEqual({
      type: 'toolResult',
      results: [{ id: 'call-1', content: 'file listing', isError: false }],
    });
  });

  it('converts a token_count payload into a result event with usage', () => {
    const line = JSON.stringify({
      timestamp: 3000,
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 200,
            output_tokens: 100,
            cached_input_tokens: 20,
          },
        },
      },
    });
    const ev = parseCodexHistoryLine(line);
    expect(ev?.kind.type).toBe('result');
    const usage = (ev!.kind as any).info.modelUsage.codex;
    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 0,
    });
  });

  it('returns null for unknown payload types', () => {
    const line = JSON.stringify({
      timestamp: 3000,
      payload: { type: 'something_novel', data: 'x' },
    });
    expect(parseCodexHistoryLine(line)).toBeNull();
  });
});

describe('dedupeCodexEvents', () => {
  const mkLocalUser = (ts: number, text: string): StreamEvent => ({
    id: `id-${ts}`,
    timestamp: ts,
    raw: '',
    revision: 0,
    kind: { type: 'localUser', text },
  });

  it('collapses equivalent events within a 1-second bucket', () => {
    const events = [
      mkLocalUser(1000, 'hi'),
      mkLocalUser(1500, 'hi'),
      mkLocalUser(2100, 'hi'),
    ];
    const deduped = dedupeCodexEvents(events);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].timestamp).toBe(1000);
    expect(deduped[1].timestamp).toBe(2100);
  });

  it('keeps events whose content differs even inside the same bucket', () => {
    const events = [mkLocalUser(1000, 'hi'), mkLocalUser(1100, 'hello')];
    expect(dedupeCodexEvents(events)).toHaveLength(2);
  });

  it('keeps events whose signature is null (unrecognized kinds) untouched', () => {
    const sysNotice: StreamEvent = {
      id: 'x',
      timestamp: 1000,
      raw: '',
      revision: 0,
      kind: { type: 'systemNotice', text: 'bump' } as any,
    };
    expect(dedupeCodexEvents([sysNotice, sysNotice])).toHaveLength(2);
  });
});
