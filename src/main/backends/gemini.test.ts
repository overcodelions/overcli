import { describe, expect, it } from 'vitest';
import { geminiBackend } from './gemini';
import type { BackendCtx, BackendSendArgs } from './types';

const baseArgs: BackendSendArgs = {
  conversationId: 'conv-1',
  prompt: 'hi gemini',
  cwd: '/tmp/project',
  model: 'gemini-2.5-pro',
  permissionMode: 'default',
};

const ctx: BackendCtx = {
  mcpConfigPathFor: () => undefined,
  codexExecTranscriptFor: () => undefined,
};

describe('geminiBackend.buildArgs', () => {
  it('always emits -p - -o stream-json', () => {
    const a = geminiBackend.buildArgs(baseArgs, ctx);
    expect(a.slice(0, 4)).toEqual(['-p', '-', '-o', 'stream-json']);
  });

  it('passes -m + --resume when provided', () => {
    const a = geminiBackend.buildArgs({ ...baseArgs, sessionId: 'sess-7' }, ctx);
    expect(a).toContain('-m');
    expect(a).toContain('gemini-2.5-pro');
    expect(a).toContain('--resume');
    expect(a).toContain('sess-7');
  });

  it('omits -m and --resume when not provided', () => {
    const a = geminiBackend.buildArgs({ ...baseArgs, model: '' }, ctx);
    expect(a).not.toContain('-m');
    expect(a).not.toContain('--resume');
  });

  it('always emits --approval-mode', () => {
    const cases: Array<[BackendSendArgs['permissionMode'], string]> = [
      ['default', 'default'],
      ['plan', 'plan'],
      // `auto` is Claude-only; gemini falls back to default approval.
      ['auto', 'default'],
      ['acceptEdits', 'auto_edit'],
      ['bypassPermissions', 'yolo'],
    ];
    for (const [mode, expected] of cases) {
      const a = geminiBackend.buildArgs({ ...baseArgs, permissionMode: mode }, ctx);
      const idx = a.indexOf('--approval-mode');
      expect(a[idx + 1]).toBe(expected);
    }
  });
});

describe('geminiBackend.buildEnvelope', () => {
  it('returns the prompt unchanged', () => {
    expect(geminiBackend.buildEnvelope(baseArgs, ctx)).toBe('hi gemini');
  });

  it('drops attachments (text-only headless mode)', () => {
    const env = geminiBackend.buildEnvelope(
      {
        ...baseArgs,
        prompt: 'see this',
        attachments: [{ id: 'a1', mimeType: 'image/png', dataBase64: 'AAAA' }],
      },
      ctx,
    );
    expect(env).toBe('see this');
  });
});
