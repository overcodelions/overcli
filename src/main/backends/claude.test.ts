import { describe, expect, it } from 'vitest';
import { claudeBackend } from './claude';
import type { BackendCtx, BackendSendArgs } from './types';

const baseArgs: BackendSendArgs = {
  conversationId: 'conv-1',
  prompt: 'do the thing',
  cwd: '/tmp/project',
  model: 'claude-sonnet',
  permissionMode: 'default',
};

const noMcpCtx: BackendCtx = {
  mcpConfigPathFor: () => undefined,
  codexExecTranscriptFor: () => undefined,
};
const withMcpCtx: BackendCtx = {
  mcpConfigPathFor: () => '/tmp/mcp.json',
  codexExecTranscriptFor: () => undefined,
};

describe('claudeBackend.buildArgs', () => {
  it('emits the stream-json scaffold for any send', () => {
    const a = claudeBackend.buildArgs(baseArgs, noMcpCtx);
    expect(a.slice(0, 7)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
    ]);
  });

  it('passes --resume + --model when provided', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, sessionId: 'sess-42' },
      noMcpCtx,
    );
    expect(a).toContain('--resume');
    expect(a).toContain('sess-42');
    expect(a).toContain('--model');
    expect(a).toContain('claude-sonnet');
  });

  it('skips --permission-mode when default', () => {
    const a = claudeBackend.buildArgs(baseArgs, noMcpCtx);
    expect(a).not.toContain('--permission-mode');
  });

  it('emits --permission-mode for non-default', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, permissionMode: 'plan' }, noMcpCtx);
    expect(a).toContain('--permission-mode');
    expect(a).toContain('plan');
  });

  it('wires --mcp-config + --permission-prompt-tool when context supplies a path', () => {
    const a = claudeBackend.buildArgs(baseArgs, withMcpCtx);
    expect(a).toContain('--mcp-config');
    expect(a).toContain('/tmp/mcp.json');
    expect(a).toContain('--permission-prompt-tool');
    expect(a).toContain('mcp__overcli__approve');
  });

  it('skips MCP wiring under bypassPermissions even when path present', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, permissionMode: 'bypassPermissions' },
      withMcpCtx,
    );
    expect(a).not.toContain('--mcp-config');
    expect(a).not.toContain('--permission-prompt-tool');
  });

  it('passes --permission-mode auto and keeps MCP wiring', () => {
    // Claude classifies tool calls itself in auto mode but may still
    // route ambiguous cases through our prompt tool, so we leave the
    // MCP wiring in place.
    const a = claudeBackend.buildArgs({ ...baseArgs, permissionMode: 'auto' }, withMcpCtx);
    expect(a).toContain('--permission-mode');
    expect(a).toContain('auto');
    expect(a).toContain('--mcp-config');
    expect(a).toContain('--permission-prompt-tool');
  });

  it('appends --add-dir for each normalized allowed dir', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, allowedDirs: ['/opt/shared', '/tmp/project', '/tmp/other'] },
      noMcpCtx,
    );
    const addDirIdxs = a.reduce<number[]>((acc, v, i) => (v === '--add-dir' ? [...acc, i] : acc), []);
    // cwd is dropped, two distinct allowed dirs remain.
    expect(addDirIdxs).toHaveLength(2);
  });
});

describe('claudeBackend.buildEnvelope', () => {
  it('serializes a plain user message when no attachments', () => {
    const env = claudeBackend.buildEnvelope({ ...baseArgs, prompt: 'hello' }, noMcpCtx);
    expect(JSON.parse(env)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
  });

  it('switches to a content array when images are attached', () => {
    const env = claudeBackend.buildEnvelope(
      {
        ...baseArgs,
        prompt: 'see this',
        attachments: [
          { id: 'a1', label: 'x.png', mimeType: 'image/png', dataBase64: 'AAAA' },
        ],
      },
      noMcpCtx,
    );
    const parsed = JSON.parse(env);
    expect(parsed.message.content).toHaveLength(2);
    expect(parsed.message.content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(parsed.message.content[1]).toEqual({ type: 'text', text: 'see this' });
  });

  it('falls back to "(no text)" when prompt is empty but images exist', () => {
    const env = claudeBackend.buildEnvelope(
      {
        ...baseArgs,
        prompt: '',
        attachments: [{ id: 'a1', label: 'x.png', mimeType: 'image/png', dataBase64: 'A' }],
      },
      noMcpCtx,
    );
    const parsed = JSON.parse(env);
    expect(parsed.message.content[1]).toEqual({ type: 'text', text: '(no text)' });
  });
});
