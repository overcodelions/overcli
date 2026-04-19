import { describe, it, expect } from 'vitest';
import { parseGeminiLine } from './gemini';

function kindOf(line: string) {
  return parseGeminiLine(line)?.kind;
}

describe('parseGeminiLine', () => {
  it('returns null for blank input', () => {
    expect(parseGeminiLine('')).toBeNull();
  });

  it('emits parseError for malformed JSON', () => {
    expect(kindOf('nope')).toEqual({ type: 'parseError', message: 'nope' });
  });

  it('parses init', () => {
    const line = JSON.stringify({
      type: 'init',
      session_id: 's1',
      model: 'gemini-2',
      cwd: '/tmp',
      apiKeySource: 'env',
    });
    const kind = kindOf(line);
    if (kind?.type !== 'systemInit') throw new Error();
    expect(kind.info).toEqual({
      sessionId: 's1',
      model: 'gemini-2',
      cwd: '/tmp',
      apiKeySource: 'env',
      tools: [],
      slashCommands: [],
      mcpServers: [],
    });
  });

  it('emits assistant for assistant messages and labels others', () => {
    const assistant = kindOf(JSON.stringify({ type: 'message', role: 'assistant', content: 'hi' }));
    if (assistant?.type !== 'assistant') throw new Error();
    expect(assistant.info.text).toBe('hi');

    const user = kindOf(JSON.stringify({ type: 'message', role: 'user', content: 'hello' }));
    expect(user).toEqual({ type: 'other', label: 'message' });
  });

  it('remaps gemini tool names to internal names', () => {
    const line = JSON.stringify({
      type: 'tool_use',
      tool_id: 't1',
      tool_name: 'replace',
      parameters: { file_path: '/a', old_string: 'a', new_string: 'b' },
    });
    const kind = kindOf(line);
    if (kind?.type !== 'assistant') throw new Error();
    expect(kind.info.toolUses[0]).toMatchObject({
      id: 't1',
      name: 'Edit',
      filePath: '/a',
      oldString: 'a',
      newString: 'b',
    });
  });

  it('keeps unknown tool names as-is', () => {
    const kind = kindOf(
      JSON.stringify({ type: 'tool_use', tool_id: 't2', tool_name: 'search_the_web', parameters: {} }),
    );
    if (kind?.type !== 'assistant') throw new Error();
    expect(kind.info.toolUses[0].name).toBe('search_the_web');
  });

  it('prefers tool_result output string, falls back to error.message, then empty', () => {
    const ok = kindOf(JSON.stringify({ type: 'tool_result', tool_id: 't1', output: 'out' }));
    if (ok?.type !== 'toolResult') throw new Error();
    expect(ok.results[0]).toMatchObject({ id: 't1', content: 'out', isError: false });

    const errored = kindOf(
      JSON.stringify({ type: 'tool_result', tool_id: 't2', status: 'error', error: { message: 'bad' } }),
    );
    if (errored?.type !== 'toolResult') throw new Error();
    expect(errored.results[0]).toMatchObject({ content: 'bad', isError: true });

    const empty = kindOf(JSON.stringify({ type: 'tool_result', tool_id: 't3' }));
    if (empty?.type !== 'toolResult') throw new Error();
    expect(empty.results[0].content).toBe('');
  });

  it('serializes non-string tool_result output', () => {
    const kind = kindOf(JSON.stringify({ type: 'tool_result', tool_id: 't4', output: { x: 1 } }));
    if (kind?.type !== 'toolResult') throw new Error();
    expect(kind.results[0].content).toBe(JSON.stringify({ x: 1 }));
  });

  it('maps result with model usage', () => {
    const line = JSON.stringify({
      type: 'result',
      status: 'success',
      stats: {
        duration_ms: 42,
        models: {
          'gemini-2': { input_tokens: 5, output_tokens: 7, cached: 2 },
        },
      },
    });
    const kind = kindOf(line);
    if (kind?.type !== 'result') throw new Error();
    expect(kind.info.durationMs).toBe(42);
    expect(kind.info.isError).toBe(false);
    expect(kind.info.modelUsage['gemini-2']).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 0,
    });
  });

  it('flags non-success result status as error', () => {
    const kind = kindOf(JSON.stringify({ type: 'result', status: 'failed' }));
    if (kind?.type !== 'result') throw new Error();
    expect(kind.info.isError).toBe(true);
  });

  it('falls back to "other" with gemini-prefixed label for unknown types', () => {
    expect(kindOf(JSON.stringify({ type: 'mystery' }))).toEqual({ type: 'other', label: 'gemini:mystery' });
  });
});
