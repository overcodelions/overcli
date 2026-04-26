import { describe, expect, it } from 'vitest';
import { codexBackend } from './codex';
import type { BackendCtx, BackendSendArgs } from './types';

const baseArgs: BackendSendArgs = {
  conversationId: 'conv-1',
  prompt: 'do the thing',
  cwd: '/tmp/project',
  model: 'gpt-5',
  permissionMode: 'default',
};

const noTranscriptCtx: BackendCtx = {
  mcpConfigPathFor: () => undefined,
  codexExecTranscriptFor: () => undefined,
};

describe('codexBackend.buildArgs', () => {
  it('always emits exec - at the end', () => {
    const a = codexBackend.buildArgs(baseArgs, noTranscriptCtx);
    expect(a.slice(-2)).toEqual(['exec', '-']);
  });

  it('includes -m when a model is provided', () => {
    const a = codexBackend.buildArgs(baseArgs, noTranscriptCtx);
    expect(a).toContain('-m');
    expect(a).toContain('gpt-5');
  });

  it('omits -m when no model', () => {
    const a = codexBackend.buildArgs({ ...baseArgs, model: '' }, noTranscriptCtx);
    expect(a).not.toContain('-m');
  });

  it('always forces approval=never on the exec transport', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const) {
      const a = codexBackend.buildArgs({ ...baseArgs, permissionMode: mode }, noTranscriptCtx);
      const aIdx = a.indexOf('-a');
      expect(a[aIdx + 1]).toBe('never');
    }
  });

  it('maps permissionMode → sandbox correctly', () => {
    const cases: Array<[BackendSendArgs['permissionMode'], string]> = [
      ['plan', 'read-only'],
      ['default', 'workspace-write'],
      ['acceptEdits', 'workspace-write'],
      ['bypassPermissions', 'danger-full-access'],
    ];
    for (const [mode, expected] of cases) {
      const a = codexBackend.buildArgs({ ...baseArgs, permissionMode: mode }, noTranscriptCtx);
      const sIdx = a.indexOf('-s');
      expect(a[sIdx + 1]).toBe(expected);
    }
  });
});

describe('codexBackend.buildEnvelope', () => {
  it('returns the bare prompt when there is no prior transcript', () => {
    expect(codexBackend.buildEnvelope(baseArgs, noTranscriptCtx)).toBe('do the thing');
  });

  it('returns the bare prompt when transcript is empty', () => {
    const ctx: BackendCtx = {
      mcpConfigPathFor: () => undefined,
      codexExecTranscriptFor: () => [],
    };
    expect(codexBackend.buildEnvelope(baseArgs, ctx)).toBe('do the thing');
  });

  it('prepends prior turns when transcript exists', () => {
    const ctx: BackendCtx = {
      mcpConfigPathFor: () => undefined,
      codexExecTranscriptFor: () => [
        { user: 'first ask', assistant: 'first reply' },
        { user: 'second ask', assistant: 'second reply' },
      ],
    };
    const env = codexBackend.buildEnvelope(baseArgs, ctx);
    expect(env).toContain('User: first ask');
    expect(env).toContain('Assistant: first reply');
    expect(env).toContain('User: second ask');
    expect(env).toContain('Assistant: second reply');
    expect(env).toContain('do the thing');
    // History block precedes the new user message.
    expect(env.indexOf('first ask')).toBeLessThan(env.indexOf('do the thing'));
  });

  it('separates turns with --- and labels the new message', () => {
    const ctx: BackendCtx = {
      mcpConfigPathFor: () => undefined,
      codexExecTranscriptFor: () => [{ user: 'u', assistant: 'a' }],
    };
    const env = codexBackend.buildEnvelope(baseArgs, ctx);
    expect(env).toMatch(/---/);
    expect(env).toContain('New user message:');
  });
});
