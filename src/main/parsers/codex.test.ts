import { describe, it, expect } from 'vitest';
import { makeCodexParserState, parseCodexProtoLine } from './codex';

function parse(line: string, state = makeCodexParserState()) {
  return { result: parseCodexProtoLine(line, state), state };
}

describe('parseCodexProtoLine', () => {
  it('ignores blank lines', () => {
    expect(parseCodexProtoLine('', makeCodexParserState())).toEqual({ events: [] });
  });

  it('emits parseError on malformed JSON', () => {
    const { result } = parse('not json');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toEqual({ type: 'parseError', message: 'not json' });
  });

  it('returns sessionConfigured metadata without streaming an event', () => {
    const line = JSON.stringify({ msg: { type: 'session_configured', session_id: 'sess-1', rollout_path: '/p' } });
    const { result } = parse(line);
    expect(result.events).toEqual([]);
    expect(result.sessionConfigured).toEqual({ sessionId: 'sess-1', rolloutPath: '/p' });
  });

  it('accumulates reasoning and message deltas across lines', () => {
    const state = makeCodexParserState();
    parse(JSON.stringify({ msg: { type: 'agent_reasoning_delta', delta: 'think ' } }), state);
    parse(JSON.stringify({ msg: { type: 'agent_reasoning_delta', delta: 'more' } }), state);
    parse(JSON.stringify({ msg: { type: 'agent_message_delta', delta: 'hi ' } }), state);
    parse(JSON.stringify({ msg: { type: 'agent_message_delta', delta: 'there' } }), state);
    expect(state.thinkingText).toBe('think more');
    expect(state.messageText).toBe('hi there');
  });

  it('flushes message + thinking on task_complete and emits a result event', () => {
    const state = makeCodexParserState();
    parse(JSON.stringify({ msg: { type: 'agent_message_delta', delta: 'final' } }), state);
    parse(JSON.stringify({ msg: { type: 'agent_reasoning_delta', delta: 'why' } }), state);
    const { result } = parse(JSON.stringify({ msg: { type: 'task_complete' } }), state);
    expect(result.events).toHaveLength(2);
    const [assistant, done] = result.events;
    if (assistant.kind.type !== 'assistant') throw new Error();
    expect(assistant.kind.info.text).toBe('final');
    expect(assistant.kind.info.thinking).toEqual(['why']);
    expect(done.kind.type).toBe('result');
    // State resets for next turn.
    expect(state.messageText).toBe('');
    expect(state.thinkingText).toBe('');
  });

  it('exec_command_begin emits an assistant tool_use and records the call_id', () => {
    const state = makeCodexParserState();
    const { result } = parse(
      JSON.stringify({ msg: { type: 'exec_command_begin', call_id: 'c1', command: ['ls', '-la'] } }),
      state,
    );
    expect(state.toolNames).toEqual({ c1: 'Bash' });
    expect(state.pendingToolUses).toHaveLength(1);
    const ev = result.events[0];
    if (ev.kind.type !== 'assistant') throw new Error();
    expect(ev.kind.info.toolUses[0]).toMatchObject({
      id: 'c1',
      name: 'Bash',
      inputJSON: JSON.stringify({ command: 'ls -la' }),
    });
  });

  it('exec_command_end combines stdout + stderr and flags non-zero exit as error', () => {
    const { result } = parse(
      JSON.stringify({
        msg: {
          type: 'exec_command_end',
          call_id: 'c1',
          stdout: 'out',
          stderr: 'err',
          exit_code: 1,
        },
      }),
    );
    const ev = result.events[0];
    if (ev.kind.type !== 'toolResult') throw new Error();
    expect(ev.kind.results).toEqual([{ id: 'c1', content: 'out\n\n[stderr]\nerr', isError: true }]);
  });

  it('normalizes object-shaped patch changes (update/create/delete)', () => {
    const { result } = parse(
      JSON.stringify({
        msg: {
          type: 'patch_apply_end',
          call_id: 'p1',
          success: true,
          changes: {
            'a.ts': { update: { unified_diff: '--- a\n+++ b\n@@\n+new\n-old\n' } },
            'b.ts': { create: { content: 'hello' } },
            'c.ts': { delete: {} },
          },
        },
      }),
    );
    const ev = result.events[0];
    if (ev.kind.type !== 'patchApply') throw new Error();
    const byPath = Object.fromEntries(ev.kind.info.files.map((f) => [f.path, f]));
    expect(byPath['a.ts']).toMatchObject({ kind: 'modify', additions: 1, deletions: 1 });
    expect(byPath['b.ts']).toMatchObject({ kind: 'add', diff: 'hello' });
    expect(byPath['c.ts']).toMatchObject({ kind: 'delete' });
    expect(ev.kind.info.success).toBe(true);
  });

  it('normalizes array-shaped patch changes from older fixtures', () => {
    const { result } = parse(
      JSON.stringify({
        msg: {
          type: 'patch_apply_begin',
          call_id: 'p2',
          changes: [{ path: 'x.ts', kind: 'modify', additions: 3, deletions: 2, diff: 'd' }],
        },
      }),
    );
    const ev = result.events[0];
    if (ev.kind.type !== 'patchApply') throw new Error();
    expect(ev.kind.info.files).toHaveLength(1);
    expect(ev.kind.info.files[0]).toMatchObject({
      path: 'x.ts',
      kind: 'modify',
      additions: 3,
      deletions: 2,
      diff: 'd',
    });
    expect(ev.kind.info.success).toBe(true);
  });

  it('emits codexApproval for exec and patch approval requests', () => {
    const execEv = parse(
      JSON.stringify({
        msg: { type: 'exec_approval_request', call_id: 'e1', command: ['rm', '-rf', '/'], reason: 'danger' },
      }),
    ).result.events[0];
    if (execEv.kind.type !== 'codexApproval') throw new Error();
    expect(execEv.kind.info).toMatchObject({ callId: 'e1', kind: 'exec', command: 'rm -rf /', reason: 'danger' });

    const patchEv = parse(
      JSON.stringify({
        msg: {
          type: 'apply_patch_approval_request',
          call_id: 'p1',
          changes: { 'a.ts': { update: { unified_diff: '@@\n+x\n' } } },
        },
      }),
    ).result.events[0];
    if (patchEv.kind.type !== 'codexApproval') throw new Error();
    expect(patchEv.kind.info.kind).toBe('patch');
    expect(patchEv.kind.info.changesSummary).toBe('modify a.ts');
  });

  it('maps error events to systemNotice', () => {
    const { result } = parse(JSON.stringify({ msg: { type: 'error', message: 'boom' } }));
    expect(result.events[0].kind).toEqual({ type: 'systemNotice', text: 'boom' });
  });

  it('labels unknown msg types', () => {
    const { result } = parse(JSON.stringify({ msg: { type: 'mystery' } }));
    expect(result.events[0].kind).toEqual({ type: 'other', label: 'codex:mystery' });
  });

  it('flags missing msg as codex:unknown', () => {
    const { result } = parse(JSON.stringify({ id: 1 }));
    expect(result.events[0].kind).toEqual({ type: 'other', label: 'codex:unknown' });
  });
});
