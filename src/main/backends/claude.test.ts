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

  it('passes effort through verbatim — turbo pinning happens upstream', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, effortLevel: 'max' }, noMcpCtx);
    expect(a[a.indexOf('--effort') + 1]).toBe('max');
  });

  it('turbo adds --strict-mcp-config so the global MCP config is ignored', () => {
    expect(claudeBackend.buildArgs({ ...baseArgs, turbo: true }, noMcpCtx)).toContain(
      '--strict-mcp-config',
    );
    expect(claudeBackend.buildArgs(baseArgs, noMcpCtx)).not.toContain('--strict-mcp-config');
  });

  it('appends the fewer-larger-tool-calls directive with or without turbo', () => {
    // No longer turbo-gated. Batching does not trade away answer quality the
    // way turbo's low-effort half does, so every conversation gets it — and
    // because the value never varies, it never trips `paramsChanged` into a
    // respawn the way a conditional flag would.
    for (const turbo of [true, false]) {
      const a = claudeBackend.buildArgs({ ...baseArgs, turbo }, noMcpCtx);
      const appended = a[a.indexOf('--append-system-prompt') + 1];
      expect(appended).toMatch(/fewer, larger tool calls/i);
      // The correctness caveat must survive any future edit to the wording.
      expect(appended).toMatch(/never skip a check/i);
    }
  });

  it('passes an identical directive either way, so toggling turbo cannot respawn on it', () => {
    const on = claudeBackend.buildArgs({ ...baseArgs, turbo: true }, noMcpCtx);
    const off = claudeBackend.buildArgs({ ...baseArgs, turbo: false }, noMcpCtx);
    expect(on[on.indexOf('--append-system-prompt') + 1]).toBe(
      off[off.indexOf('--append-system-prompt') + 1],
    );
  });

  it('turbo keeps the permission broker config while dropping the rest', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, turbo: true }, withMcpCtx);
    expect(a).toContain('--mcp-config');
    expect(a).toContain('/tmp/mcp.json');
    expect(a).toContain('--strict-mcp-config');
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

  // Regression: we used to emit `--thinking-effort`, which the CLI has
  // never accepted. Picking any effort other than the default killed the
  // subprocess on turn one with
  // `error: unknown option '--thinking-effort'`.
  it('passes the effort level as --effort, never --thinking-effort', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, effortLevel: 'max' }, noMcpCtx);
    expect(a).not.toContain('--thinking-effort');
    expect(a[a.indexOf('--effort') + 1]).toBe('max');
  });

  it('omits --effort entirely when no effort level is set', () => {
    const a = claudeBackend.buildArgs(baseArgs, noMcpCtx);
    expect(a).not.toContain('--effort');
  });

  it('drops --effort when the installed CLI does not advertise it', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, effortLevel: 'high' },
      { ...noMcpCtx, claudeSupportsEffort: () => false },
    );
    expect(a).not.toContain('--effort');
    expect(a).not.toContain('high');
  });

  it('keeps --effort when the probe says the CLI supports it', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, effortLevel: 'high' },
      { ...noMcpCtx, claudeSupportsEffort: () => true },
    );
    expect(a[a.indexOf('--effort') + 1]).toBe('high');
  });

  it('wires --mcp-config + --permission-prompt-tool when context supplies a path', () => {
    const a = claudeBackend.buildArgs(baseArgs, withMcpCtx);
    expect(a).toContain('--mcp-config');
    expect(a).toContain('/tmp/mcp.json');
    expect(a).toContain('--permission-prompt-tool');
    expect(a).toContain('mcp__overcli__approve');
  });

  it('keeps MCP servers but skips the permission prompt tool under bypassPermissions', () => {
    const a = claudeBackend.buildArgs(
      { ...baseArgs, permissionMode: 'bypassPermissions' },
      withMcpCtx,
    );
    expect(a).toContain('--mcp-config');
    expect(a).toContain('/tmp/mcp.json');
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

  it('omits --debug by default', () => {
    const a = claudeBackend.buildArgs(baseArgs, noMcpCtx);
    expect(a).not.toContain('--debug');
  });

  it('emits --debug mcp when mcpDebug is set', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, mcpDebug: true }, noMcpCtx);
    const i = a.indexOf('--debug');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a[i + 1]).toBe('mcp');
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

  it('emits --allowedTools with a space-joined list when allowedTools is set', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, allowedTools: ['Read', 'Grep'] }, noMcpCtx);
    const i = a.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a[i + 1]).toBe('Read Grep');
  });

  it('emits an explicit empty --allowedTools allowlist', () => {
    const a = claudeBackend.buildArgs({ ...baseArgs, allowedTools: [] }, noMcpCtx);
    expect(a.slice(a.indexOf('--allowedTools'), a.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', '']);
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
