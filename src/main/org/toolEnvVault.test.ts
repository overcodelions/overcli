import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readClaudeMcpServers,
  readMcpServer,
  removeMcpServer,
  restoreClaudeStdioEnv,
  sealClaudeStdioEnv,
  sealedClaudeTools,
  useClaudeEnvVault,
  writeMcpServer,
} from '../mcpConfig';
import { ToolEnvVault, toolEnvVaultExists } from './toolEnvVault';

const TOKEN = 'acme-jira-token-0123456789abcdef';

let tmp: string;
let orgDir: string;
let paths: { claude: string; codex: string; gemini: string };

const file = () => fs.readFileSync(paths.claude, 'utf8');
const writeConfig = (servers: Record<string, unknown>) => {
  fs.mkdirSync(path.dirname(paths.claude), { recursive: true });
  fs.writeFileSync(paths.claude, JSON.stringify({ numStartups: 3, mcpServers: servers }, null, 2));
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-env-'));
  orgDir = path.join(tmp, 'org');
  paths = { claude: path.join(tmp, 'home', '.claude.json'), codex: path.join(tmp, 'home', '.codex', 'config.toml'), gemini: path.join(tmp, 'home', '.gemini', 'settings.json') };
});

afterEach(() => {
  useClaudeEnvVault(null);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the command tools\' env vault', () => {
  it('seals, keeps across starts and forgets, in a file of its own that holds no token in the clear', () => {
    const vault = new ToolEnvVault(orgDir);
    vault.seal('jira', { JIRA_API_TOKEN: TOKEN });
    expect(toolEnvVaultExists(orgDir)).toBe(true);
    expect(fs.readFileSync(path.join(orgDir, 'tool-env.json'), 'utf8')).not.toContain(TOKEN);
    expect(fs.statSync(path.join(orgDir, 'tool-env.json')).mode & 0o777).toBe(0o600);
    const again = new ToolEnvVault(orgDir);
    expect(again.envFor('jira')).toEqual({ JIRA_API_TOKEN: TOKEN });
    again.forget('jira');
    expect(new ToolEnvVault(orgDir).has('jira')).toBe(false);
  });

  it('moves every command tool\'s env out of the config, leaving remote tools and env-less ones as they were', () => {
    writeConfig({
      jira: { command: 'npx', args: ['acme-jira-mcp'], env: { JIRA_API_TOKEN: TOKEN, JIRA_URL: 'https://acme.example' } },
      browser: { command: 'npx', args: ['acme-browser-mcp'] },
      issues: { type: 'http', url: 'http://127.0.0.1:4100/t/issues' },
    });
    useClaudeEnvVault(new ToolEnvVault(orgDir));
    expect(sealClaudeStdioEnv(paths)).toEqual(['jira']);
    const onDisk = JSON.parse(file());
    expect(file()).not.toContain(TOKEN);
    expect(onDisk.numStartups).toBe(3);
    expect(onDisk.mcpServers.jira).toEqual({ command: 'npx', args: ['acme-jira-mcp'] });
    expect(onDisk.mcpServers.browser).toEqual({ command: 'npx', args: ['acme-browser-mcp'] });
    expect(onDisk.mcpServers.issues).toEqual({ type: 'http', url: 'http://127.0.0.1:4100/t/issues' });
    // A second start finds nothing left to seal.
    expect(sealClaudeStdioEnv(paths)).toEqual([]);
  });

  it('gives the server its tools whole, so health checks, settings and runs work as before', () => {
    writeConfig({ jira: { command: 'npx', args: ['acme-jira-mcp'], env: { JIRA_API_TOKEN: TOKEN } } });
    useClaudeEnvVault(new ToolEnvVault(orgDir));
    sealClaudeStdioEnv(paths);
    expect(readClaudeMcpServers(undefined, paths).jira).toEqual({ command: 'npx', args: ['acme-jira-mcp'], env: { JIRA_API_TOKEN: TOKEN } });
    expect(readMcpServer('claude', 'jira', paths)).toEqual({ command: 'npx', args: ['acme-jira-mcp'], env: { JIRA_API_TOKEN: TOKEN } });
    // Only sealed command tools need the relay.
    expect(Object.keys(sealedClaudeTools(readClaudeMcpServers(undefined, paths)))).toEqual(['jira']);
  });

  it('seals what is installed or changed later, and forgets what is removed', () => {
    writeConfig({});
    useClaudeEnvVault(new ToolEnvVault(orgDir));
    writeMcpServer('claude', 'tickets', { command: 'npx', args: ['acme-tickets-mcp'], env: { TICKETS_TOKEN: TOKEN } }, paths);
    expect(file()).not.toContain(TOKEN);
    expect(readClaudeMcpServers(undefined, paths).tickets.env).toEqual({ TICKETS_TOKEN: TOKEN });
    // A settings change writes the whole entry back, still sealed.
    const current = readClaudeMcpServers(undefined, paths).tickets;
    writeMcpServer('claude', 'tickets', { ...current, env: { ...(current.env as Record<string, string>), TICKETS_TOKEN: 'acme-rotated-token-9876543210' } }, paths);
    expect(file()).not.toContain('acme-rotated-token');
    expect(readClaudeMcpServers(undefined, paths).tickets.env).toEqual({ TICKETS_TOKEN: 'acme-rotated-token-9876543210' });
    removeMcpServer('claude', 'tickets', paths);
    expect(new ToolEnvVault(orgDir).has('tickets')).toBe(false);
  });

  it('takes the env out of the config\'s backups too, leaving files that aren\'t JSON alone', () => {
    writeConfig({ jira: { command: 'npx', env: { JIRA_API_TOKEN: TOKEN } } });
    const dir = path.dirname(paths.claude);
    fs.copyFileSync(paths.claude, path.join(dir, '.claude.json.bak'));
    fs.copyFileSync(paths.claude, path.join(dir, '.claude.json.backup.1793352938140'));
    fs.writeFileSync(path.join(dir, '.claude.json.notes'), `not json ${TOKEN}`);
    useClaudeEnvVault(new ToolEnvVault(orgDir));
    sealClaudeStdioEnv(paths);
    expect(fs.readFileSync(path.join(dir, '.claude.json.bak'), 'utf8')).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(dir, '.claude.json.backup.1793352938140'), 'utf8')).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(dir, '.claude.json.notes'), 'utf8')).toContain(TOKEN);
    // The backup written before each later write is of the sealed file.
    writeMcpServer('claude', 'browser', { command: 'npx' }, paths);
    expect(fs.readFileSync(path.join(dir, '.claude.json.bak'), 'utf8')).not.toContain(TOKEN);
  });

  it('puts the env back when the server stops sealing it', () => {
    writeConfig({ jira: { command: 'npx', env: { JIRA_API_TOKEN: TOKEN } } });
    const vault = new ToolEnvVault(orgDir);
    useClaudeEnvVault(vault);
    sealClaudeStdioEnv(paths);
    useClaudeEnvVault(null);
    expect(readClaudeMcpServers(undefined, paths).jira.env).toBeUndefined();
    expect(restoreClaudeStdioEnv(new ToolEnvVault(orgDir), paths)).toEqual(['jira']);
    expect(JSON.parse(file()).mcpServers.jira.env).toEqual({ JIRA_API_TOKEN: TOKEN });
    expect(new ToolEnvVault(orgDir).names()).toEqual([]);
  });

  it('changes nothing when no vault is in use (the desktop app)', () => {
    writeConfig({});
    writeMcpServer('claude', 'jira', { command: 'npx', env: { JIRA_API_TOKEN: TOKEN } }, paths);
    expect(file()).toContain(TOKEN);
    expect(sealClaudeStdioEnv(paths)).toEqual([]);
    expect(sealedClaudeTools(readClaudeMcpServers(undefined, paths))).toEqual({});
  });
});
