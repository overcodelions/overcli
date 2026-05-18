import { describe, expect, it } from 'vitest';
import { copilotBackend } from './copilot';
import type { BackendCtx, BackendSendArgs } from './types';

const noCtx: BackendCtx = {
  mcpConfigPathFor: () => undefined,
  codexExecTranscriptFor: () => undefined,
};

const baseArgs: BackendSendArgs = {
  conversationId: 'conv-1',
  prompt: 'list files',
  cwd: '/tmp/project',
  model: '',
  permissionMode: 'default',
};

describe('copilotBackend.buildArgs', () => {
  it('puts the prompt in argv with json+stream flags', () => {
    const a = copilotBackend.buildArgs(baseArgs, noCtx);
    expect(a.slice(0, 6)).toEqual(['-p', 'list files', '--output-format', 'json', '--stream', 'on']);
  });

  it('appends --resume when a sessionId is provided', () => {
    const a = copilotBackend.buildArgs({ ...baseArgs, sessionId: 'sess-xyz' }, noCtx);
    expect(a).toContain('--resume');
    expect(a).toContain('sess-xyz');
  });

  it('appends --model when a model override is provided', () => {
    const a = copilotBackend.buildArgs({ ...baseArgs, model: 'claude-sonnet-4.6' }, noCtx);
    expect(a).toContain('--model');
    expect(a).toContain('claude-sonnet-4.6');
  });

  it('does not emit --model when empty', () => {
    const a = copilotBackend.buildArgs(baseArgs, noCtx);
    expect(a).not.toContain('--model');
  });

  it('passes --allow-all-tools by default (overcli does not broker copilot approvals)', () => {
    const a = copilotBackend.buildArgs(baseArgs, noCtx);
    expect(a).toContain('--allow-all-tools');
    const b = copilotBackend.buildArgs({ ...baseArgs, permissionMode: 'bypassPermissions' }, noCtx);
    expect(b).toContain('--allow-all-tools');
    const c = copilotBackend.buildArgs({ ...baseArgs, permissionMode: 'acceptEdits' }, noCtx);
    expect(c).toContain('--allow-all-tools');
  });

  it('plan mode narrows to read-only tools (view/glob/grep) without --allow-all-tools', () => {
    const a = copilotBackend.buildArgs({ ...baseArgs, permissionMode: 'plan' }, noCtx);
    expect(a).not.toContain('--allow-all-tools');
    expect(a).toContain('--available-tools');
    expect(a).toContain('view');
    expect(a).toContain('glob');
    expect(a).toContain('grep');
  });

  it('appends --add-dir for each normalized allowed dir', () => {
    const a = copilotBackend.buildArgs(
      { ...baseArgs, allowedDirs: ['/opt/shared', '/tmp/project', '/tmp/other'] },
      noCtx,
    );
    const addDirCount = a.filter((v) => v === '--add-dir').length;
    expect(addDirCount).toBe(2);
  });
});

describe('copilotBackend.buildEnvelope', () => {
  it('returns an empty string (prompt rides in argv)', () => {
    expect(copilotBackend.buildEnvelope(baseArgs, noCtx)).toBe('');
  });
});

describe('copilotBackend.parseChunk', () => {
  function fresh() {
    return copilotBackend.makeParserState!();
  }

  it('buffers a partial line until the newline arrives', () => {
    const state = fresh();
    const initLine = JSON.stringify({
      type: 'session.tools_updated',
      data: { model: 'claude-haiku-4.5' },
    });
    const half = initLine.slice(0, 20);
    const rest = initLine.slice(20) + '\n';
    const a = copilotBackend.parseChunk!(half, state);
    expect(a.events).toEqual([]);
    const b = copilotBackend.parseChunk!(rest, state);
    expect(b.events).toHaveLength(1);
    expect(b.events[0].kind.type).toBe('systemInit');
  });

  it('surfaces sessionConfigured on the result line', () => {
    const state = fresh();
    const resultLine = JSON.stringify({
      type: 'result',
      sessionId: 'sess-abc',
      exitCode: 0,
      usage: { premiumRequests: 2, sessionDurationMs: 1000 },
    });
    const out = copilotBackend.parseChunk!(resultLine + '\n', state);
    expect(out.sessionConfigured).toEqual({ sessionId: 'sess-abc' });
    expect(out.events).toHaveLength(1);
    expect(out.events[0].kind.type).toBe('result');
  });

  it('parses a realistic 3-line slice in one chunk', () => {
    const state = fresh();
    const chunk =
      JSON.stringify({ type: 'session.tools_updated', data: { model: 'claude-haiku-4.5' } }) +
      '\n' +
      JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: 'm1',
          content: 'Here you go.',
          toolRequests: [],
          reasoningText: '',
        },
      }) +
      '\n' +
      JSON.stringify({
        type: 'result',
        sessionId: 'sess-x',
        exitCode: 0,
        usage: { premiumRequests: 1, sessionDurationMs: 500 },
      }) +
      '\n';
    const out = copilotBackend.parseChunk!(chunk, state);
    expect(out.events.map((e) => e.kind.type)).toEqual(['systemInit', 'assistant', 'result']);
    expect(out.sessionConfigured?.sessionId).toBe('sess-x');
  });
});
