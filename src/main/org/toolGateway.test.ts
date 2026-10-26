import { createHmac, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServerConfig } from '../mcpConfig';
import { bindToolGateway, boundGatewayTools, closeToolGateway, openToolGateway, type GatewayCaller, type ToolGateway } from './toolGateway';
import { credentialRules } from './credentialGuard';

/// The bearer header a bound gateway entry carries.
const bearerOf = (config: { headers?: unknown }): string => (config.headers as Record<string, string>).Authorization;

const TOKEN = 'acme-secret-token-123';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/// A remote MCP server that records what it was sent.
async function upstream(): Promise<{ url: string; seen: Array<{ auth?: string; body: string }> }> {
  const seen: Array<{ auth?: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'from the tool' }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp?key=abc`, seen };
}

function configFile(initial: Record<string, McpServerConfig>) {
  const servers = { ...initial };
  return { servers, read: () => ({ ...servers }), write: (name: string, c: McpServerConfig) => void (servers[name] = c) };
}

async function open(dir: string, file: ReturnType<typeof configFile>, callers: Record<string, GatewayCaller> = {}, calls: unknown[] = []): Promise<ToolGateway> {
  const gw = await openToolGateway({ dir: () => dir, callerFor: (id) => callers[id], onCall: (c) => calls.push(c) }, file);
  cleanup.push(() => gw.stop());
  return gw;
}

const call = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } });

async function post(url: string, auth: string | undefined, body: string): Promise<{ status: number; json: any; session: string | null }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) }, body });
  return { status: r.status, json: await r.json().catch(() => null), session: r.headers.get('mcp-session-id') };
}

describe('tool gateway', () => {
  it('moves a remote tool behind loopback and keeps its token out of the config', async () => {
    const dir = tmpDir();
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } }, local: { command: 'npx', args: ['x'] } });
    const gw = await open(dir, file);

    expect(String(file.servers.crm.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/crm$/);
    expect(JSON.stringify(file.servers)).not.toContain(TOKEN);
    expect(JSON.stringify(file.servers)).not.toContain('key=abc');
    expect(file.servers.local).toEqual({ command: 'npx', args: ['x'] });
    expect(fs.readFileSync(path.join(dir, 'tool-gateway.json'), 'utf8')).not.toContain(TOKEN);
    expect(gw.real('crm')).toEqual({ url: tool.url, headerNames: ['Authorization'] });
  });

  it('forwards with the real headers and hands back the answer', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    await open(tmpDir(), file);
    const auth = bearerOf(boundGatewayTools(() => file.servers, 'conv1').crm);

    const r = await post(String(file.servers.crm.url), auth, call('search_records'));
    expect(r.status).toBe(200);
    expect(r.session).toBe('s1');
    expect(r.json.result.content[0].text).toBe('from the tool');
    expect(tool.seen).toHaveLength(1);
    expect(tool.seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it('refuses a key it did not issue, and no key', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    await open(tmpDir(), file);
    const url = String(file.servers.crm.url);

    expect((await post(url, undefined, call('search_records'))).status).toBe(401);
    expect((await post(url, `Bearer ${TOKEN}`, call('search_records'))).status).toBe(401);
    expect((await post(url, 'Bearer c.someone.forged', call('search_records'))).status).toBe(401);
    expect(tool.seen).toHaveLength(0);
  });

  it('refuses calls on a run key it never handed out, even one signed with its own key file', async () => {
    const dir = tmpDir();
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    const calls: Array<{ allowed: boolean; who: string }> = [];
    const first = await open(dir, file);
    // Signed with the same key file, but for a run the next start never saw:
    // what someone who read the key file could make.
    const minted = `Bearer ${first.keyFor('not-a-run')}`;
    first.stop();
    const gw = await open(dir, file, {}, calls);
    const url = String(file.servers.crm.url);

    // Run keys are signed with what each start keeps in memory: one from an
    // earlier start isn't a key at all now.
    expect((await post(url, minted, call('create_record'))).status).toBe(401);
    expect((await post(url, minted, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(401);
    expect(calls).toEqual([]);
    // A run this start handed a key to, worker or not, still calls.
    expect((await post(url, `Bearer ${gw.keyFor('a-run')}`, call('search_records'))).json.result.content[0].text).toBe('from the tool');
    expect(tool.seen.filter((x) => x.body.includes('tools/call'))).toHaveLength(1);
  });

  it('refuses a live run key made from the key file', async () => {
    const dir = tmpDir();
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    const gw = await open(dir, file);
    const url = String(file.servers.crm.url);
    gw.keyFor('live-run');
    // What a worker that read the key file could sign: the box key's way, for the live run.
    const root = fs.readFileSync(path.join(dir, 'tool-gateway.key'));
    const mac = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'tool-gateway key', 32));
    const forged = `Bearer c.live-run.${createHmac('sha256', mac).update('c.live-run').digest('base64url')}`;
    expect((await post(url, forged, call('create_record'))).status).toBe(401);
    expect(tool.seen).toHaveLength(0);
  });

  it('binds a run to its own key and refuses calls outside its worker scope', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    await open(tmpDir(), file, { conv1: { workerName: 'Dana', scopes: { crm: { mode: 'read' } } } });

    const bound = JSON.parse(bindToolGateway(JSON.stringify({ mcpServers: { crm: file.servers.crm } }), 'conv1'));
    const auth = bound.mcpServers.crm.headers.Authorization as string;
    expect(auth).toMatch(/^Bearer c\.conv1\./);

    const refused = await post(String(file.servers.crm.url), auth, call('create_record'));
    expect(refused.status).toBe(200);
    expect(refused.json.id).toBe(7);
    expect(refused.json.result.isError).toBe(true);
    expect(refused.json.result.content[0].text).toContain('Dana may use crm read only');
    expect(tool.seen).toHaveLength(0);

    const read = await post(String(file.servers.crm.url), auth, call('search_records'));
    expect(read.json.result.content[0].text).toBe('from the tool');
    expect(tool.seen).toHaveLength(1);
  });

  it('refuses a batch whole when one of its calls is out of scope', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: {} } });
    await open(tmpDir(), file, { conv1: { workerName: 'Dana', scopes: { crm: { mode: 'read' } } } });
    const auth = JSON.parse(bindToolGateway(JSON.stringify({ mcpServers: { crm: file.servers.crm } }), 'conv1')).mcpServers.crm.headers.Authorization;
    const batch = `[${call('search_records').replace('"id":7', '"id":1')},${call('delete_record').replace('"id":7', '"id":2')}]`;

    const r = await post(String(file.servers.crm.url), auth, batch);
    expect(r.json.map((m: { id: number }) => m.id)).toEqual([1, 2]);
    expect(r.json.every((m: { error?: unknown }) => m.error)).toBe(true);
    expect(tool.seen).toHaveLength(0);
  });

  it('points tools vaulted by an earlier start at the new port', async () => {
    const dir = tmpDir();
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    const first = await open(dir, file);
    const before = String(file.servers.crm.url);
    first.stop();

    await open(dir, file);
    const after = file.servers.crm;
    expect(String(after.url)).not.toBe(before);
    const r = await post(String(after.url), bearerOf(boundGatewayTools(() => file.servers, 'conv1').crm), call('search_records'));
    expect(r.status).toBe(200);
    expect(tool.seen[0].auth).toBe(`Bearer ${TOKEN}`);
  });

  it('lets the box key list tools but refuses its calls', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    const calls: Array<{ who: string; allowed: boolean }> = [];
    await open(tmpDir(), file, { conv1: { workerName: 'Dana', scopes: { crm: { mode: 'read' } } } }, calls);
    const url = String(file.servers.crm.url);
    const box = (file.servers.crm.headers as Record<string, string>).Authorization;
    expect(box).toMatch(/^Bearer b\./);

    const list = await post(url, box, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(list.status).toBe(200);
    expect(tool.seen).toHaveLength(1);

    for (const name of ['create_record', 'search_records']) {
      const r = await post(url, box, call(name));
      expect(r.json.id).toBe(7);
      expect(r.json.result.isError).toBe(true);
      expect(r.json.result.content[0].text).toContain('shared key');
    }
    const batch = await post(url, box, `[${call('search_records').replace('"id":7', '"id":1')}]`);
    expect(batch.json[0].error.code).toBe(-32001);
    expect(tool.seen).toHaveLength(1);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ who: 'unattributed', allowed: false })]));
  });

  it('never forwards a body it cannot read as JSON', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: {} } });
    await open(tmpDir(), file);
    const box = (file.servers.crm.headers as Record<string, string>).Authorization;

    const r = await post(String(file.servers.crm.url), box, `\uFEFF${call('create_record')}`);
    expect(r.json.error.code).toBe(-32700);
    expect(tool.seen).toHaveLength(0);
  });

  it('gives a run on the whole config its own key for each gateway tool', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } }, local: { command: 'npx', args: ['x'] } });
    await open(tmpDir(), file, { conv1: { workerName: 'Dana', scopes: { crm: { mode: 'read' } } } });
    // Added after the gateway opened, so not behind it.
    file.servers.other = { type: 'http', url: 'https://mcp.acme.example/mcp' };

    const bound = boundGatewayTools(() => file.servers, 'conv1');
    expect(Object.keys(bound)).toEqual(['crm']);
    expect(bound.crm.url).toBe(file.servers.crm.url);
    const auth = bearerOf(bound.crm);
    expect(auth).toMatch(/^Bearer c\.conv1\./);

    const read = await post(String(bound.crm.url), auth, call('search_records'));
    expect(read.json.result.content[0].text).toBe('from the tool');
    const write = await post(String(bound.crm.url), auth, call('create_record'));
    expect(write.json.result.content[0].text).toContain('Dana may use crm read only');
    expect(tool.seen).toHaveLength(1);
  });

  it('keeps a run key scoped after the runtime lets the run go', async () => {
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: {} } });
    const callers: Record<string, GatewayCaller> = { conv1: { workerName: 'Dana', scopes: { crm: { mode: 'read' } } } };
    await open(tmpDir(), file, callers);
    const url = String(file.servers.crm.url);
    const auth = bearerOf(boundGatewayTools(() => file.servers, 'conv1').crm);

    expect((await post(url, auth, call('search_records'))).json.result.content[0].text).toBe('from the tool');
    delete callers.conv1;
    const write = await post(url, auth, call('create_record'));
    expect(write.json.result.content[0].text).toContain('Dana may use crm read only');
    expect(tool.seen).toHaveLength(1);
  });

  it('binds nothing with the gateway off', () => {
    let read = false;
    expect(boundGatewayTools(() => ((read = true), {}), 'conv1')).toEqual({});
    expect(read).toBe(false);
  });

  it('puts the real tool back when the gateway is turned off', async () => {
    const dir = tmpDir();
    const tool = await upstream();
    const file = configFile({ crm: { type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } } });
    const gw = await open(dir, file);
    gw.stop();

    closeToolGateway(dir, file);
    expect(file.servers.crm).toEqual({ type: 'http', url: tool.url, headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  it('leaves a config that names no gateway tool alone', () => {
    const json = JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://mcp.acme.example/mcp' } } });
    expect(bindToolGateway(json, 'conv1')).toBe(json);
  });
});

describe('credential guard', () => {
  it('denies reading and changing the CLI config, sign-ins and server state', () => {
    const rules = credentialRules('/data');
    for (const p of ['~/.claude.json', '~/.codex/**', '~/.ssh/**', '//proc/**', '//data/org/**', '//data/secrets*', '//data/org.json']) {
      expect(rules).toContain(`Read(${p})`);
      expect(rules).toContain(`Edit(${p})`);
    }
    expect(rules.every((r) => !/\s/.test(r))).toBe(true);
  });
});
