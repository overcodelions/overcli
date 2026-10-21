import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installTool, listTools, parseTemplates, templateFrom, uninstallTool } from './tools';

let home = '';
const savedHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-tools-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
});

describe('tools on the server', () => {
  it('installs into the CLI config, lists it without its secrets, and removes it', () => {
    expect(installTool({ name: 'jira', kind: 'command', command: 'npx', args: ['-y', '@acme/jira-mcp'], env: { JIRA_API_TOKEN: 'sekrit' } })).toEqual({ ok: true });
    const file = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(file.mcpServers.jira).toEqual({ command: 'npx', args: ['-y', '@acme/jira-mcp'], env: { JIRA_API_TOKEN: 'sekrit' } });
    const { tools, missing } = listTools([{ name: 'Triage', mcpServers: ['jira', 'acme-crm'] }]);
    expect(tools).toEqual([{ name: 'jira', kind: 'command', target: 'npx -y @acme/jira-mcp', secrets: ['JIRA_API_TOKEN'], usedBy: ['Triage'] }]);
    expect(JSON.stringify(tools)).not.toContain('sekrit');
    expect(missing).toEqual([{ name: 'acme-crm', workers: ['Triage'] }]);
    expect(uninstallTool('jira')).toEqual({ ok: true });
    expect(listTools([]).tools).toEqual([]);
  });

  it('takes remote servers by URL, and refuses bad names and addresses', () => {
    expect(installTool({ name: 'docs', kind: 'http', url: 'https://mcp.acme.example/mcp', headers: { Authorization: 'Bearer x' } })).toEqual({ ok: true });
    expect(listTools([]).tools[0]).toMatchObject({ kind: 'http', target: 'https://mcp.acme.example/mcp', secrets: ['Authorization'] });
    expect(installTool({ name: '../evil', kind: 'command', command: 'x' }).ok).toBe(false);
    expect(installTool({ name: 'ok', kind: 'http', url: 'file:///etc/passwd' }).ok).toBe(false);
    expect(installTool({ name: 'ok', kind: 'command', command: '' }).ok).toBe(false);
  });
});

describe('what a published worker brings', () => {
  it('keeps the shape of a tool and none of its secrets', () => {
    const t = templateFrom('jira', { command: 'npx', args: ['-y', '@acme/jira-mcp', 'Zx81kQ0pLmN2bV7cXs4dRt6yUi9oPa3s'], env: { JIRA_API_TOKEN: 'sekrit', JIRA_URL: 'https://acme.atlassian.example' } });
    expect(t).toEqual({ name: 'jira', kind: 'command', command: 'npx', args: ['-y', '@acme/jira-mcp'], envKeys: ['JIRA_API_TOKEN', 'JIRA_URL'], headerKeys: [] });
    const r = templateFrom('docs', { type: 'http', url: 'https://mcp.acme.example/mcp?key=sekrit', headers: { Authorization: 'Bearer sekrit' } });
    expect(r).toEqual({ name: 'docs', kind: 'http', url: 'https://mcp.acme.example/mcp', envKeys: [], headerKeys: ['Authorization'] });
    expect(JSON.stringify([t, r])).not.toContain('sekrit');
  });

  it('offers it on the missing list, pre-filled', () => {
    const template = parseTemplates([{ name: 'acme-crm', kind: 'command', command: 'uvx', args: ['acme-crm-mcp'], envKeys: ['CRM_TOKEN'] }, { name: '../bad' }]);
    expect(template).toHaveLength(1);
    const { missing } = listTools([{ name: 'Triage', mcpServers: ['acme-crm'] }], {}, { 'acme-crm': template[0] });
    expect(missing[0]).toMatchObject({ name: 'acme-crm', template: { command: 'uvx', envKeys: ['CRM_TOKEN'] } });
  });
});
