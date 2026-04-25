import { describe, it, expect } from 'vitest';
import { makeClaudeParserState, parseClaudeLine } from './claude';

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

  it('drops unknown system subtypes (stop_hook_summary, turn_duration, …)', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'stop_hook_summary' });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('surfaces api_error retries as a systemNotice', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_error',
      error: { status: 500 },
      retryInMs: 547.83,
      retryAttempt: 1,
      maxRetries: 10,
    });
    expect(kindOf(line)).toEqual({
      type: 'systemNotice',
      text: 'API error (status 500) · retrying in 548ms · attempt 1/10',
    });
  });

  it('surfaces compact_boundary as a systemNotice', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
    expect(kindOf(line)).toEqual({ type: 'systemNotice', text: 'Conversation compacted' });
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

  it('streams partial assistant text from content_block_delta lines', () => {
    const state = makeClaudeParserState();
    // Ignore message_start (no visible snapshot yet).
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'message_start', message: { model: 'claude-4' } },
        }),
        state,
      ),
    ).toBeNull();

    // content_block_start flushes (so the user sees an empty bubble open
    // instantly when the first token round-trips).
    const started = parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      }),
      state,
    );
    expect(started?.kind.type).toBe('assistant');
    const startedId = started!.id;

    // Force the throttle gate open — real CLI output paces deltas >50ms
    // apart naturally; the test drives them synchronously.
    state.lastSnapshotAt = 0;
    const deltaOne = parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      }),
      state,
    );
    expect(deltaOne?.kind.type).toBe('assistant');
    if (deltaOne?.kind.type !== 'assistant') throw new Error();
    expect(deltaOne.kind.info.text).toBe('Hello ');
    expect(deltaOne.kind.info.isPartial).toBe(true);
    expect(deltaOne.id).toBe(startedId);

    // Second delta within the throttle window is folded into state but
    // not emitted — the renderer would pick it up on the next flush.
    state.lastSnapshotAt = Date.now(); // simulate "just emitted"
    expect(
      parseClaudeLine(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'world' },
          },
        }),
        state,
      ),
    ).toBeNull();

    // content_block_stop forces a flush, so the suppressed "world" chunk
    // reaches the renderer via the terminal snapshot.
    const stopped = parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
      state,
    );
    if (stopped?.kind.type !== 'assistant') throw new Error('expected assistant snapshot');
    expect(stopped.kind.info.text).toBe('Hello world');
    expect(stopped.id).toBe(startedId);

    // Final non-stream assistant line reuses the same id so the renderer
    // replaces the streaming preview in place instead of appending.
    const finalLine = parseClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-4',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      }),
      state,
    );
    expect(finalLine?.id).toBe(startedId);
    if (finalLine?.kind.type !== 'assistant') throw new Error();
    expect(finalLine.kind.info.isPartial).toBeUndefined();
    // State is cleared so a subsequent message gets a fresh id.
    expect(state.inFlightEventId).toBeNull();
  });

  it('handles thinking deltas and redacted_thinking in the stream', () => {
    const state = makeClaudeParserState();
    parseClaudeLine(
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      state,
    );
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
      }),
      state,
    );
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'step 1' },
        },
      }),
      state,
    );
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'redacted_thinking' },
        },
      }),
      state,
    );
    const snap = parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
      state,
    );
    if (snap?.kind.type !== 'assistant') throw new Error();
    expect(snap.kind.info.thinking).toEqual(['step 1']);
    expect(snap.kind.info.hasOpaqueReasoning).toBe(true);
  });

  it('ignores stream_event lines when no parser state is threaded (history replay)', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
    });
    expect(parseClaudeLine(line)).toBeNull();
  });

  it('ignores subagent stream_events so main-agent state is not reset mid-turn', () => {
    const state = makeClaudeParserState();
    // Main agent starts a message and opens a text block.
    parseClaudeLine(
      JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: {} } }),
      state,
    );
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      }),
      state,
    );
    const mainEventId = state.inFlightEventId;
    expect(mainEventId).not.toBeNull();

    // A subagent's message_start arrives on the same transport with
    // parent_tool_use_id set. Folding it in would reset inFlightEventId.
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        parent_tool_use_id: 'toolu_abc',
        event: { type: 'message_start', message: {} },
      }),
      state,
    );
    expect(state.inFlightEventId).toBe(mainEventId);

    // Same holds for isSidechain-tagged lines (Claude Code's sidechain marker).
    parseClaudeLine(
      JSON.stringify({
        type: 'stream_event',
        isSidechain: true,
        event: { type: 'message_start', message: {} },
      }),
      state,
    );
    expect(state.inFlightEventId).toBe(mainEventId);
  });
});
