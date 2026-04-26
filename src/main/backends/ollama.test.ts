import { describe, expect, it } from 'vitest';
import { ollamaBackend } from './ollama';
import type { BackendCtx, BackendSendArgs } from './types';

const args: BackendSendArgs = {
  conversationId: 'c',
  prompt: 'p',
  cwd: '/tmp',
  model: 'llama',
  permissionMode: 'default',
};

const ctx: BackendCtx = {
  mcpConfigPathFor: () => undefined,
  codexExecTranscriptFor: () => undefined,
};

describe('ollamaBackend', () => {
  it('throws on buildArgs (HTTP-only — runner takes a different path)', () => {
    expect(() => ollamaBackend.buildArgs(args, ctx)).toThrow(/HTTP path/);
  });

  it('throws on buildEnvelope (HTTP-only — runner takes a different path)', () => {
    expect(() => ollamaBackend.buildEnvelope(args, ctx)).toThrow(/sendOllama/);
  });
});
