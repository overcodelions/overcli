import { describe, expect, it } from 'vitest';
import { makeCopilotParserState, normalizeCopilotToolName, parseCopilotLine } from './copilot';

function line(obj: object): string {
  return JSON.stringify(obj);
}

describe('normalizeCopilotToolName', () => {
  it('maps copilot builtins onto overcli canonical names', () => {
    expect(normalizeCopilotToolName('view')).toBe('Read');
    expect(normalizeCopilotToolName('edit')).toBe('Edit');
    expect(normalizeCopilotToolName('create')).toBe('Write');
    expect(normalizeCopilotToolName('bash')).toBe('Bash');
    expect(normalizeCopilotToolName('powershell')).toBe('Bash');
    expect(normalizeCopilotToolName('glob')).toBe('Glob');
    expect(normalizeCopilotToolName('grep')).toBe('Grep');
    expect(normalizeCopilotToolName('rg')).toBe('Grep');
  });
  it('passes unknown tool names through unchanged', () => {
    expect(normalizeCopilotToolName('custom_tool')).toBe('custom_tool');
  });
});

describe('parseCopilotLine', () => {
  it('returns no event for malformed JSON only as a parseError', () => {
    const state = makeCopilotParserState();
    const out = parseCopilotLine('not-json{', state);
    expect(out).toHaveLength(1);
    expect(out[0].kind.type).toBe('parseError');
  });

  it('captures model from session.tools_updated and emits one systemInit', () => {
    const state = makeCopilotParserState();
    const first = parseCopilotLine(
      line({ type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } }),
      state,
    );
    expect(first).toHaveLength(1);
    expect(first[0].kind.type).toBe('systemInit');
    if (first[0].kind.type === 'systemInit') {
      expect(first[0].kind.info.model).toBe('claude-haiku-4.5');
    }
    // A second tools_updated must not re-emit systemInit.
    const second = parseCopilotLine(
      line({ type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } }),
      state,
    );
    expect(second).toEqual([]);
  });

  it('accumulates mcp servers across multiple loaded events without dupes', () => {
    const state = makeCopilotParserState();
    parseCopilotLine(
      line({
        type: 'session.mcp_servers_loaded',
        data: { servers: [{ name: 'github-mcp-server', status: 'connected' }] },
      }),
      state,
    );
    parseCopilotLine(
      line({
        type: 'session.mcp_servers_loaded',
        data: { servers: [{ name: 'github-mcp-server', status: 'connected' }] },
      }),
      state,
    );
    expect(state.mcpServers).toEqual([
      { name: 'github-mcp-server', status: 'connected' },
    ]);
  });

  it('drops user.message and turn_start/turn_end events', () => {
    const state = makeCopilotParserState();
    expect(
      parseCopilotLine(line({ type: 'user.message', data: { content: 'hi' } }), state),
    ).toEqual([]);
    expect(parseCopilotLine(line({ type: 'assistant.turn_start' }), state)).toEqual([]);
    expect(parseCopilotLine(line({ type: 'assistant.turn_end' }), state)).toEqual([]);
  });

  it('emits a streaming snapshot from message_delta and replaces it on the final message', () => {
    const state = makeCopilotParserState();
    parseCopilotLine(line({ type: 'assistant.message_start', data: { messageId: 'msg-1' } }), state);
    // Force the throttle by zeroing lastSnapshotAt manually — first delta after start.
    state.lastSnapshotAt = 0;
    const partial = parseCopilotLine(
      line({ type: 'assistant.message_delta', data: { messageId: 'msg-1', deltaContent: 'Hello' } }),
      state,
    );
    expect(partial).toHaveLength(1);
    expect(partial[0].id).toBe('msg-1');
    if (partial[0].kind.type === 'assistant') {
      expect(partial[0].kind.info.text).toBe('Hello');
      expect(partial[0].kind.info.isPartial).toBe(true);
    }
    const final = parseCopilotLine(
      line({
        type: 'assistant.message',
        data: {
          messageId: 'msg-1',
          content: 'Hello, world.',
          toolRequests: [],
          reasoningText: 'Decide what to do.',
          model: 'claude-haiku-4.5',
        },
      }),
      state,
    );
    expect(final).toHaveLength(1);
    expect(final[0].id).toBe('msg-1');
    if (final[0].kind.type === 'assistant') {
      expect(final[0].kind.info.text).toBe('Hello, world.');
      expect(final[0].kind.info.isPartial).toBeUndefined();
      expect(final[0].kind.info.thinking).toEqual(['Decide what to do.']);
    }
    // In-flight state cleared after the final message.
    expect(state.inFlightMessageId).toBeNull();
    expect(state.inFlightText).toBe('');
  });

  it('extracts tool_use blocks from assistant.message.toolRequests with normalized names', () => {
    const state = makeCopilotParserState();
    const out = parseCopilotLine(
      line({
        type: 'assistant.message',
        data: {
          messageId: 'msg-tools',
          content: '',
          toolRequests: [
            {
              toolCallId: 'tc-1',
              name: 'view',
              arguments: { path: '/tmp/project' },
              type: 'function',
            },
            {
              toolCallId: 'tc-2',
              name: 'edit',
              arguments: { file_path: '/a.ts', old_string: 'x', new_string: 'y' },
              type: 'function',
            },
          ],
          reasoningText: '',
        },
      }),
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind.type).toBe('assistant');
    if (out[0].kind.type !== 'assistant') return;
    expect(out[0].kind.info.toolUses).toHaveLength(2);
    expect(out[0].kind.info.toolUses[0]).toMatchObject({
      id: 'tc-1',
      name: 'Read',
      filePath: '/tmp/project',
    });
    expect(out[0].kind.info.toolUses[1]).toMatchObject({
      id: 'tc-2',
      name: 'Edit',
      filePath: '/a.ts',
      oldString: 'x',
      newString: 'y',
    });
  });

  it('emits a toolResult event from tool.execution_complete', () => {
    const state = makeCopilotParserState();
    const out = parseCopilotLine(
      line({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'tc-1',
          success: true,
          result: { content: '.git\nsrc\npackage.json' },
        },
      }),
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind.type).toBe('toolResult');
    if (out[0].kind.type !== 'toolResult') return;
    expect(out[0].kind.results).toEqual([
      { id: 'tc-1', content: '.git\nsrc\npackage.json', isError: false },
    ]);
  });

  it('marks toolResult as error when success is false', () => {
    const state = makeCopilotParserState();
    const out = parseCopilotLine(
      line({
        type: 'tool.execution_complete',
        data: { toolCallId: 'tc-1', success: false, result: { content: 'permission denied' } },
      }),
      state,
    );
    expect(out[0].kind.type).toBe('toolResult');
    if (out[0].kind.type !== 'toolResult') return;
    expect(out[0].kind.results[0].isError).toBe(true);
  });

  it('maps result event to a result StreamEvent with premiumRequests as outputTokens', () => {
    const state = makeCopilotParserState();
    // Prime the model so result picks it up.
    parseCopilotLine(
      line({ type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } }),
      state,
    );
    const out = parseCopilotLine(
      line({
        type: 'result',
        sessionId: 'sess-xyz',
        exitCode: 0,
        usage: {
          premiumRequests: 1,
          totalApiDurationMs: 5242,
          sessionDurationMs: 6752,
          codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        },
      }),
      state,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind.type).toBe('result');
    if (out[0].kind.type !== 'result') return;
    expect(out[0].kind.info.durationMs).toBe(6752);
    expect(out[0].kind.info.modelUsage['claude-haiku-4.5'].outputTokens).toBe(1);
  });
});
