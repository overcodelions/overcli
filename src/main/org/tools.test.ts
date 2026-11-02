import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editTool, exportableArgs, fixAddresses, installTool, listTools, parseTemplates, templateFrom, uninstallTool, updateToolSettings } from './tools';

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
    expect(tools).toEqual([{ name: 'jira', kind: 'command', target: 'npx -y @acme/jira-mcp', command: 'npx', args: ['-y', '@acme/jira-mcp'], secrets: ['JIRA_API_TOKEN'], usedBy: ['Triage'] }]);
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

  it('leaves out a credential in a tool argument or an address path', () => {
    const db = templateFrom('db', { command: 'npx', args: ['-y', '@acme/server-postgres', 'postgresql://app:S3cret@db.acme.example/prod', '--token', 'tok_9f8e7d6c5b4a', '--pool-size', '4', '--password=hunter2', 'https://api.acme.example/v1?key=sekrit'] });
    expect(db).toEqual({ name: 'db', kind: 'command', command: 'npx', args: ['-y', '@acme/server-postgres', '--token', '--pool-size', '4'], envKeys: [], headerKeys: [] });
    const sse = templateFrom('crm', { type: 'http', url: 'https://mcp.acme.example/s/a8f3k2m9x1q7w4e6r5t0/sse', headers: {} });
    expect(sse).toEqual({ name: 'crm', kind: 'http', url: 'https://mcp.acme.example', envKeys: [], headerKeys: [] });
    const basic = templateFrom('wiki', { type: 'http', url: 'https://app:S3cret@wiki.acme.example/mcp' });
    expect(basic?.url).toBe('https://wiki.acme.example');
    expect(JSON.stringify([db, sse, basic])).not.toMatch(/S3cret|tok_9f8e|hunter2|sekrit|a8f3k2m9/);
    // A header holding a key, of any length, and a bare value with a credential word in it.
    const key = `sk_live_${'a1b2c3d4'.repeat(12)}`;
    const remote = templateFrom('remote', { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.acme.example/sse', '--header', `Authorization: Bearer ${key}`, '--header', 'X-Api-Key: ak_live_9', '--header', 'Accept: text/event-stream', 'Bearer abc', `token-${'x'.repeat(76)}`, 'x'.repeat(81)] });
    expect(remote?.args).toEqual(['-y', 'mcp-remote', 'https://mcp.acme.example/sse', '--header', '--header', '--header', 'Accept: text/event-stream']);
    expect(JSON.stringify(remote)).not.toMatch(/sk_live|ak_live|Bearer abc/);
    // A plain address keeps its path; a flag's value that is another flag is not swallowed.
    expect(templateFrom('docs', { type: 'http', url: 'https://mcp.acme.example/v1/mcp' })?.url).toBe('https://mcp.acme.example/v1/mcp');
    expect(templateFrom('x', { command: 'uvx', args: ['acme-mcp', '--token', '--verbose'] })?.args).toEqual(['acme-mcp', '--token', '--verbose']);
  });

  it('leaves out a token split over a path, in base64, or in a short flag, a cookie or a fragment', () => {
    // Split across segments each too short to read as a token on its own.
    expect(templateFrom('crm', { type: 'http', url: 'https://mcp.acme.example/s/a8f3k2m9x1/q7w4e6r5t0/sse' })?.url).toBe('https://mcp.acme.example');
    expect(templateFrom('crm', { type: 'http', url: 'https://mcp.acme.example/api/v1/mcp/sse' })?.url).toBe('https://mcp.acme.example/api/v1/mcp/sse');
    const b64 = 'c2VjcmV0LWtleS9mb3IrYWNtZQ==';
    const args = exportableArgs(['-y', '@acme/crm-mcp@1.2.0', b64, 'aGVsbG8vd29y+bGQxMjM0NTY', '--pw', 'hunter2', '-p', 'S3cretPass', '-p', '5432', '-p', '8080:80', '--header', 'Cookie: session=abc123', 'https://mcp.acme.example/sse#token=abc123', 'app:S3cret@db.acme.example:5432/prod', 'mysql://app:S3cret@db/prod', `--db=app:S3cret@db.acme.example`, './dist/index.js', '/opt/acme/servers/mcp-v2/index.js']);
    expect(args).toEqual(['-y', '@acme/crm-mcp@1.2.0', '--pw', '-p', '-p', '5432', '-p', '8080:80', '--header', './dist/index.js', '/opt/acme/servers/mcp-v2/index.js']);
    expect(JSON.stringify(args)).not.toMatch(/c2VjcmV0|aGVsbG8|hunter2|S3cret|abc123/);
  });

  it('keeps a long package name with a version in it', () => {
    expect(exportableArgs(['-y', 'acme-crm-mcp-server-v2', '@acme/enterprise-connector-mcp-server@2.10.3', 'acme_analytics_reporting_server2'])).toEqual(['-y', 'acme-crm-mcp-server-v2', '@acme/enterprise-connector-mcp-server@2.10.3', 'acme_analytics_reporting_server2']);
    // Still not a token that happens to have dashes in it.
    expect(exportableArgs(['550e8400-e29b-41d4-a716-4466554400ab', 'tok_9f8e7d6c5b4a', 'Zx81kQ0pLmN2bV7cXs4dRt6yUi9oPa3s'])).toEqual([]);
  });

  it('offers it on the missing list, pre-filled', () => {
    const template = parseTemplates([{ name: 'acme-crm', kind: 'command', command: 'uvx', args: ['acme-crm-mcp'], envKeys: ['CRM_TOKEN'] }, { name: '../bad' }]);
    expect(template).toHaveLength(1);
    const { missing } = listTools([{ name: 'Triage', mcpServers: ['acme-crm'] }], {}, { 'acme-crm': template[0] });
    expect(missing[0]).toMatchObject({ name: 'acme-crm', template: { command: 'uvx', envKeys: ['CRM_TOKEN'] } });
  });
});

describe('a tool\'s settings', () => {
  it('adds https:// to an address given without it, at install', () => {
    expect(installTool({ name: 'tracker', kind: 'command', command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_URL: 'acme.example.net', TRACKER_TOKEN: 'sekrit' } })).toEqual({ ok: true, fixed: ['TRACKER_URL'] });
    const file = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(file.mcpServers.tracker.env).toEqual({ TRACKER_URL: 'https://acme.example.net', TRACKER_TOKEN: 'sekrit' });
  });

  it('changes some settings in place and keeps the rest', () => {
    installTool({ name: 'tracker', kind: 'command', command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_URL: 'https://old.example.net', TRACKER_TOKEN: 'sekrit' } });
    expect(updateToolSettings('tracker', { TRACKER_URL: 'new.example.net', TRACKER_TOKEN: '  ' })).toEqual({ ok: true, changed: ['TRACKER_URL'], fixed: ['TRACKER_URL'] });
    const file = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(file.mcpServers.tracker).toEqual({ command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_URL: 'https://new.example.net', TRACKER_TOKEN: 'sekrit' } });
    expect(updateToolSettings('tracker', { NOPE: 'x' })).toMatchObject({ ok: false, error: 'tracker has no setting called NOPE.' });
    expect(updateToolSettings('tracker', {})).toMatchObject({ ok: false });
    expect(updateToolSettings('missing', { A: 'b' })).toMatchObject({ ok: false, error: 'No tool by that name.' });
  });

  it('edits a command tool as a whole: command, a kept secret, a new setting, a dropped one', () => {
    installTool({ name: 'tracker', kind: 'command', command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_URL: 'https://old.example.net', TRACKER_TOKEN: 'sekrit', TRACKER_DEBUG: '1' } });
    expect(editTool('tracker', { command: 'npx', args: ['-y', '@acme/tracker-mcp@2'], env: { TRACKER_URL: 'new.example.net', TRACKER_TOKEN: '', TRACKER_TEAM: 'core' } }))
      .toEqual({ ok: true, changed: ['command', 'TRACKER_URL', 'TRACKER_TEAM', 'TRACKER_DEBUG'], fixed: ['TRACKER_URL'] });
    const file = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(file.mcpServers.tracker).toEqual({ command: 'npx', args: ['-y', '@acme/tracker-mcp@2'], env: { TRACKER_URL: 'https://new.example.net', TRACKER_TOKEN: 'sekrit', TRACKER_TEAM: 'core' } });
    const listed = listTools([]).tools.find((t) => t.name === 'tracker');
    expect(listed).toMatchObject({ command: 'npx', args: ['-y', '@acme/tracker-mcp@2'] });
  });

  it('refuses an edit it can\'t make sense of', () => {
    installTool({ name: 'tracker', kind: 'command', command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_TOKEN: 'sekrit' } });
    expect(editTool('tracker', { command: ' ', args: [], env: {} })).toMatchObject({ ok: false });
    expect(editTool('tracker', { command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_TOKEN: '', NEW_ONE: '' } })).toMatchObject({ ok: false, error: 'Give NEW_ONE a value: it\'s new.' });
    expect(editTool('tracker', { command: 'uvx', args: ['acme-tracker-mcp'], env: { TRACKER_TOKEN: '' } })).toMatchObject({ ok: false, error: 'Nothing changed.' });
    expect(editTool('tracker', { command: 'uvx', args: [], env: { 'BAD NAME': 'x' } })).toMatchObject({ ok: false });
    expect(editTool('missing', { command: 'uvx', args: [], env: {} })).toMatchObject({ ok: false, error: 'No tool by that name.' });
  });

  it('only touches settings that hold an address, and leaves full ones alone', () => {
    expect(fixAddresses({ JIRA_URL: 'acme.example.net', API_ENDPOINT: 'http://x.example', NAME: 'acme.example.net', EMPTY_URL: '', LOCAL_URL: 'localhost' })).toEqual({
      env: { JIRA_URL: 'https://acme.example.net', API_ENDPOINT: 'http://x.example', NAME: 'acme.example.net', EMPTY_URL: '', LOCAL_URL: 'localhost' },
      fixed: ['JIRA_URL'],
    });
  });
});
