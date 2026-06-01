import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addMcpServerToTargets,
  extractTomlSection,
  formatTomlPairs,
  parseTomlPairs,
  readMcpServer,
  removeTomlSection,
  writeMcpServer,
} from './mcpConfig';

let tmp: string;
let paths: { claude: string; codex: string; gemini: string };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-mcp-'));
  paths = {
    claude: path.join(tmp, '.claude', 'settings.json'),
    codex: path.join(tmp, '.codex', 'config.toml'),
    gemini: path.join(tmp, '.gemini', 'settings.json'),
  };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('TOML helpers', () => {
  it('extracts a section body until the next [...] header', () => {
    const text = [
      '[other]',
      'foo = "x"',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      'args = ["-y", "@linear/mcp"]',
      '',
      '[mcp_servers.linear.env]',
      'LINEAR_API_KEY = "secret"',
    ].join('\n');

    const body = extractTomlSection(text, 'mcp_servers.linear');
    expect(body).toContain('command = "npx"');
    expect(body).toContain('args = ["-y", "@linear/mcp"]');
    expect(body).not.toContain('LINEAR_API_KEY');
  });

  it('parses strings, arrays, and inline tables', () => {
    const pairs = parseTomlPairs(
      [
        'command = "npx"',
        'args = ["-y", "pkg"]',
        'env = { KEY = "v", OTHER = "w" }',
      ].join('\n'),
    );
    expect(pairs).toEqual([
      ['command', 'npx'],
      ['args', ['-y', 'pkg']],
      ['env', { KEY: 'v', OTHER: 'w' }],
    ]);
  });

  it('formats a config back to TOML using inline tables for env', () => {
    const out = formatTomlPairs({
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { KEY: 'v' },
    });
    expect(out).toBe(
      ['command = "npx"', 'args = ["-y", "pkg"]', 'env = { KEY = "v" }'].join('\n'),
    );
  });

  it('removes a section without disturbing surrounding sections', () => {
    const text = [
      '[a]',
      'x = 1',
      '',
      '[mcp_servers.linear]',
      'command = "npx"',
      '',
      '[b]',
      'y = 2',
      '',
    ].join('\n');
    const after = removeTomlSection(text, 'mcp_servers.linear');
    expect(after).toContain('[a]');
    expect(after).toContain('[b]');
    expect(after).not.toContain('mcp_servers.linear');
  });
});

describe('readMcpServer / writeMcpServer round-trip', () => {
  it('reads a server from Claude JSON', () => {
    fs.mkdirSync(path.dirname(paths.claude), { recursive: true });
    fs.writeFileSync(
      paths.claude,
      JSON.stringify({
        mcpServers: {
          linear: { command: 'npx', args: ['-y', '@linear/mcp'], env: { LINEAR_API_KEY: 'k' } },
        },
      }),
    );
    const got = readMcpServer('claude', 'linear', paths);
    expect(got).toEqual({
      command: 'npx',
      args: ['-y', '@linear/mcp'],
      env: { LINEAR_API_KEY: 'k' },
    });
  });

  it('returns null when server is absent', () => {
    expect(readMcpServer('claude', 'missing', paths)).toBeNull();
    expect(readMcpServer('codex', 'missing', paths)).toBeNull();
  });

  it('copies Claude → Codex (JSON to TOML), preserving fields', () => {
    fs.mkdirSync(path.dirname(paths.claude), { recursive: true });
    fs.writeFileSync(
      paths.claude,
      JSON.stringify({
        mcpServers: {
          linear: { command: 'npx', args: ['-y', '@linear/mcp'], env: { LINEAR_API_KEY: 'k' } },
        },
      }),
    );

    const config = readMcpServer('claude', 'linear', paths)!;
    writeMcpServer('codex', 'linear', config, paths);

    const written = fs.readFileSync(paths.codex, 'utf-8');
    expect(written).toContain('[mcp_servers.linear]');
    expect(written).toContain('command = "npx"');
    expect(written).toContain('args = ["-y", "@linear/mcp"]');
    expect(written).toContain('env = { LINEAR_API_KEY = "k" }');

    // And the reader recovers the same shape from what we wrote.
    expect(readMcpServer('codex', 'linear', paths)).toEqual(config);
  });

  it('copies Codex → Gemini (TOML to JSON)', () => {
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(
      paths.codex,
      [
        '[mcp_servers.linear]',
        'command = "npx"',
        'args = ["-y", "@linear/mcp"]',
        'env = { LINEAR_API_KEY = "k" }',
        '',
      ].join('\n'),
    );
    const config = readMcpServer('codex', 'linear', paths)!;
    writeMcpServer('gemini', 'linear', config, paths);
    const parsed = JSON.parse(fs.readFileSync(paths.gemini, 'utf-8'));
    expect(parsed.mcpServers.linear).toEqual({
      command: 'npx',
      args: ['-y', '@linear/mcp'],
      env: { LINEAR_API_KEY: 'k' },
    });
  });

  it('reads a Codex server with an env subtable', () => {
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(
      paths.codex,
      [
        '[mcp_servers.linear]',
        'command = "npx"',
        'args = ["-y", "@linear/mcp"]',
        '',
        '[mcp_servers.linear.env]',
        'LINEAR_API_KEY = "k"',
        '',
      ].join('\n'),
    );
    expect(readMcpServer('codex', 'linear', paths)).toEqual({
      command: 'npx',
      args: ['-y', '@linear/mcp'],
      env: { LINEAR_API_KEY: 'k' },
    });
  });

  it('replaces an existing Codex section instead of duplicating', () => {
    fs.mkdirSync(path.dirname(paths.codex), { recursive: true });
    fs.writeFileSync(
      paths.codex,
      [
        '[other]',
        'preserved = true',
        '',
        '[mcp_servers.linear]',
        'command = "old"',
        '',
      ].join('\n'),
    );
    writeMcpServer('codex', 'linear', { command: 'new', args: ['-y'] }, paths);
    const text = fs.readFileSync(paths.codex, 'utf-8');
    expect(text).toContain('[other]');
    expect(text).toContain('preserved = true');
    expect(text).toContain('command = "new"');
    expect(text).not.toContain('command = "old"');
    expect(text.match(/\[mcp_servers\.linear\]/g)?.length).toBe(1);
  });

  it('drops a .bak when overwriting an existing file', () => {
    fs.mkdirSync(path.dirname(paths.claude), { recursive: true });
    fs.writeFileSync(paths.claude, JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
    writeMcpServer('claude', 'b', { command: 'y' }, paths);
    expect(fs.existsSync(`${paths.claude}.bak`)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(paths.claude, 'utf-8'));
    expect(parsed.mcpServers).toEqual({ a: { command: 'x' }, b: { command: 'y' } });
  });
});

describe('addMcpServerToTargets', () => {
  const config = { command: 'npx', args: ['-y', '@linear/mcp'] };

  it('rejects an empty or whitespace name', () => {
    expect(addMcpServerToTargets({ name: '', config, targets: ['claude'] }, paths)).toEqual({
      ok: false,
      error: 'Server name is required.',
    });
    expect(addMcpServerToTargets({ name: '   ', config, targets: ['claude'] }, paths)).toEqual({
      ok: false,
      error: 'Server name is required.',
    });
  });

  it('rejects a non-object config', () => {
    expect(
      addMcpServerToTargets({ name: 'linear', config: null, targets: ['claude'] }, paths),
    ).toEqual({ ok: false, error: 'Config must be a JSON object.' });
    expect(
      addMcpServerToTargets({ name: 'linear', config: 'oops', targets: ['claude'] }, paths),
    ).toEqual({ ok: false, error: 'Config must be a JSON object.' });
  });

  it('rejects when no targets are MCP-capable (copilot/ollama dropped)', () => {
    expect(
      addMcpServerToTargets({ name: 'linear', config, targets: ['copilot', 'ollama'] }, paths),
    ).toEqual({ ok: false, error: 'Pick at least one MCP-capable CLI.' });
    expect(
      addMcpServerToTargets({ name: 'linear', config, targets: [] }, paths),
    ).toEqual({ ok: false, error: 'Pick at least one MCP-capable CLI.' });
  });

  it('writes to all three MCP-capable CLIs and ignores non-MCP targets', () => {
    const res = addMcpServerToTargets(
      { name: 'linear', config, targets: ['claude', 'codex', 'gemini', 'copilot'] },
      paths,
    );
    expect(res).toEqual({ ok: true, written: ['claude', 'codex', 'gemini'], errors: [] });

    expect(readMcpServer('claude', 'linear', paths)).toEqual(config);
    expect(readMcpServer('codex', 'linear', paths)).toEqual(config);
    expect(readMcpServer('gemini', 'linear', paths)).toEqual(config);
  });

  it('trims whitespace from the name before writing', () => {
    const res = addMcpServerToTargets(
      { name: '  linear  ', config, targets: ['claude'] },
      paths,
    );
    expect(res.ok).toBe(true);
    expect(readMcpServer('claude', 'linear', paths)).toEqual(config);
  });

  it('reports partial success when one CLI write fails', () => {
    // Pre-create the claude path as a directory so writeFileSync throws on it,
    // while codex and gemini still succeed.
    fs.mkdirSync(paths.claude, { recursive: true });

    const res = addMcpServerToTargets(
      { name: 'linear', config, targets: ['claude', 'codex', 'gemini'] },
      paths,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.written).toEqual(['codex', 'gemini']);
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toMatch(/^claude: /);
    }
    expect(readMcpServer('codex', 'linear', paths)).toEqual(config);
    expect(readMcpServer('gemini', 'linear', paths)).toEqual(config);
  });

  it('returns ok:false when every write fails', () => {
    fs.mkdirSync(paths.claude, { recursive: true });
    fs.mkdirSync(paths.codex, { recursive: true });
    fs.mkdirSync(paths.gemini, { recursive: true });

    const res = addMcpServerToTargets(
      { name: 'linear', config, targets: ['claude', 'codex', 'gemini'] },
      paths,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/claude: /);
      expect(res.error).toMatch(/codex: /);
      expect(res.error).toMatch(/gemini: /);
    }
  });
});
