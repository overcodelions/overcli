import { describe, expect, it } from 'vitest';
import { withBatchingDirective } from './turbo';
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
  it('emits the exec subcommand with - as the final stdin marker', () => {
    const a = codexBackend.buildArgs(baseArgs, noTranscriptCtx);
    expect(a).toContain('exec');
    expect(a[a.length - 1]).toBe('-');
  });

  it('passes --skip-git-repo-check so non-repo coordinator cwds work', () => {
    const a = codexBackend.buildArgs(baseArgs, noTranscriptCtx);
    expect(a).toContain('--skip-git-repo-check');
    // must come after the exec subcommand, not as a top-level flag
    expect(a.indexOf('--skip-git-repo-check')).toBeGreaterThan(a.indexOf('exec'));
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

  it('passes a fixed reasoning effort through the exec compatibility transport', () => {
    const a = codexBackend.buildArgs(
      { ...baseArgs, effortLevel: 'high' },
      noTranscriptCtx,
    );
    expect(a[a.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"');
  });

  it('maps Overcli max effort to Codex xhigh', () => {
    const a = codexBackend.buildArgs(
      { ...baseArgs, effortLevel: 'max' },
      noTranscriptCtx,
    );
    expect(a[a.indexOf('-c') + 1]).toBe('model_reasoning_effort="xhigh"');
  });

  it('omits the reasoning override in Auto mode', () => {
    const a = codexBackend.buildArgs(
      { ...baseArgs, effortLevel: '' },
      noTranscriptCtx,
    );
    expect(a).not.toContain('-c');
  });

  it('always forces approval=never on the exec transport', () => {
    for (const mode of ['default', 'plan', 'auto', 'acceptEdits', 'bypassPermissions'] as const) {
      const a = codexBackend.buildArgs({ ...baseArgs, permissionMode: mode }, noTranscriptCtx);
      const aIdx = a.indexOf('-a');
      expect(a[aIdx + 1]).toBe('never');
    }
  });

  it('maps permissionMode → sandbox correctly', () => {
    const cases: Array<[BackendSendArgs['permissionMode'], string]> = [
      ['plan', 'read-only'],
      ['default', 'workspace-write'],
      // `auto` is Claude-only; codex falls back to default sandbox.
      ['auto', 'workspace-write'],
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
  // Codex has no `--append-system-prompt`, so the batching directive rides in
  // the envelope on every turn — the counterpart to the flag claude passes on
  // every spawn. The prompt itself must still come through untouched, and
  // must still lead the envelope so ChatGPT-side conversation titles stay
  // distinct, which is what these pin.
  it('carries only the directive and the prompt when there is no prior transcript', () => {
    const env = codexBackend.buildEnvelope(baseArgs, noTranscriptCtx);
    expect(env).toBe(withBatchingDirective('do the thing'));
    expect(env.split('\n')[0]).toBe('do the thing');
  });

  it('carries only the directive and the prompt when transcript is empty', () => {
    const ctx: BackendCtx = {
      mcpConfigPathFor: () => undefined,
      codexExecTranscriptFor: () => [],
    };
    expect(codexBackend.buildEnvelope(baseArgs, ctx)).toBe(withBatchingDirective('do the thing'));
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
