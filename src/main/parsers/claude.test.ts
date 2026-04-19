import { describe, it, expect } from 'vitest';
import { parseClaudeLine } from './claude';

function kindOf(line: string) {
  const ev = parseClaudeLine(line);
  return ev?.kind;
}

describe('parseClaudeLine', () => {
  it('returns null for blank input', () => {
    expect(parseClaudeLine('')).toBeNull();
    expect(parseClaudeLine('   \n')).toBeNull();
  });

  it('emits a parseError event for malformed JSON', () => {
    const kind = kindOf('not json');
    expect(kind).toEqual({ type: 'parseError', message: 'not json' });
  });

  it('parses system init with full field set', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'abc',
      model: 'claude-4',
      cwd: '/tmp',
      apiKeySource: 'env',
      tools: ['Read', 'Write'],
      slash_commands: ['/help'],
      mcp_servers: [{ name: 'github', status: 'ok' }],
    });
    expect(kindOf(line)).toEqual({
      type: 'systemInit',
      info: {
        sessionId: 'abc',
        model: 'claude-4',
        cwd: '/tmp',
        apiKeySource: 'env',
        tools: ['Read', 'Write'],
        slashCommands: ['/help'],
        mcpServers: [{ name: 'github', status: 'ok' }],
      },
    });
  });

  it('labels unknown system subtypes', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'api_retry' });
    expect(kindOf(line)).toEqual({ type: 'other', label: 'system:api_retry' });
  });

  it('collects assistant text, thinking, and tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-4',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
          { type: 'thinking', thinking: 'meta' },
          { type: 'redacted_thinking' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Edit',
            input: { file_path: '/x.ts', old_string: 'a', new_string: 'b' },
          },
        ],
      },
    });
    const kind = kindOf(line);
    expect(kind?.type).toBe('assistant');
    if (kind?.type !== 'assistant') throw new Error();
    expect(kind.info.model).toBe('claude-4');
    expect(kind.info.text).toBe('Hello world');
    expect(kind.info.thinking).toEqual(['meta']);
    expect(kind.info.hasOpaqueReasoning).toBe(true);
    expect(kind.info.toolUses).toHaveLength(1);
    expect(kind.info.toolUses[0]).toMatchObject({
      id: 'tool-1',
      name: 'Edit',
      filePath: '/x.ts',
      oldString: 'a',
      newString: 'b',
    });
    expect(JSON.parse(kind.info.toolUses[0].inputJSON)).toEqual({
      file_path: '/x.ts',
      old_string: 'a',
      new_string: 'b',
    });
  });

  it('returns null for plain user echoes (no tool_result blocks)', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] },
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('extracts tool_result blocks, supporting string / array / object content', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'plain' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ text: 'a' }, 'b', { other: 'ignored' }],
            is_error: true,
          },
          { type: 'tool_result', tool_use_id: 't3', content: { text: 'obj' } },
        ],
      },
    });
    const kind = kindOf(line);
    expect(kind).toEqual({
      type: 'toolResult',
      results: [
        { id: 't1', content: 'plain', isError: false },
        { id: 't2', content: 'a\nb\n', isError: true },
        { id: 't3', content: 'obj', isError: false },
      ],
    });
  });

  it('normalizes result event modelUsage', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1234,
      total_cost_usd: 0.02,
      modelUsage: {
        'claude-4': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 1,
        },
        sparse: {},
      },
    });
    const kind = kindOf(line);
    if (kind?.type !== 'result') throw new Error('expected result');
    expect(kind.info.durationMs).toBe(1234);
    expect(kind.info.totalCostUSD).toBe(0.02);
    expect(kind.info.modelUsage['claude-4']).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 1,
    });
    expect(kind.info.modelUsage.sparse).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('maps rate_limit_event', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      status: 'warning',
      rate_limit_type: 'tokens',
      remaining: 100,
      resets_at: 9999,
      limit: 1000,
    });
    expect(kindOf(line)).toEqual({
      type: 'rateLimit',
      info: { status: 'warning', rateLimitType: 'tokens', remaining: 100, resetsAt: 9999, limit: 1000 },
    });
  });

  it('maps permission_request and stringifies non-string tool_input', () => {
    const line = JSON.stringify({
      type: 'permission_request',
      request_id: 'req-1',
      tool_name: 'Bash',
      description: 'run ls',
      tool_input: { command: 'ls' },
    });
    const kind = kindOf(line);
    if (kind?.type !== 'permissionRequest') throw new Error();
    expect(kind.info.backend).toBe('claude');
    expect(kind.info.requestId).toBe('req-1');
    expect(JSON.parse(kind.info.toolInput)).toEqual({ command: 'ls' });
  });

  it('falls back to "other" for unknown type', () => {
    expect(kindOf(JSON.stringify({ type: 'whatever' }))).toEqual({
      type: 'other',
      label: 'whatever',
    });
  });
});
