import { createHmac, hkdfSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../mcpConfig';
import { MAX_NOTIFY_PER_RUN, builtinGatewayTools, openToolGateway, type GatewayCaller, type ToolGateway } from './toolGateway';

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

async function open(dir: string, file: ReturnType<typeof configFile>, callers: Record<string, GatewayCaller> = {}, calls: unknown[] = [], sent: unknown[] = []): Promise<ToolGateway> {
  const gw = await openToolGateway({
    dir: () => dir,
    callerFor: (id) => callers[id],
    onCall: (c) => calls.push(c),
    notify: async (req) => {
      sent.push(req);
      return req.to === 'nobody' ? { ok: false, error: 'Nobody in Slack is called “nobody”.' } : { ok: true, sentTo: req.to === 'manager' ? 'your manager' : req.to };
    },
  }, file);
  cleanup.push(() => gw.stop());
  return gw;
}

const call = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: {} } });

async function post(url: string, auth: string | undefined, body: string): Promise<{ status: number; json: any }> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) }, body });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const rpc = (id: number, method: string, params: unknown = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const notify = (to: string, message: string) => rpc(3, 'tools/call', { name: 'notify', arguments: { to, message } });

describe('the gateway’s built-in notify', () => {
  it('speaks MCP to a worker’s run and sends through the server', async () => {
    const sent: Array<{ to: string; message: string; workerName?: string }> = [];
    const calls: unknown[] = [];
    const gw = await open(tmpDir(), configFile({}), { 'run-1': { workerName: 'Robin' } }, calls, sent);
    const url = `${gw.base()}overgo`;
    const key = `Bearer ${gw.keyFor('run-1')}`;
    expect((await post(url, key, rpc(1, 'initialize', { protocolVersion: '2025-06-18' }))).json.result).toMatchObject({ serverInfo: { name: 'overgo' }, capabilities: { tools: {} } });
    expect((await post(url, key, rpc(2, 'tools/list'))).json.result.tools.map((t: { name: string }) => t.name)).toEqual(['notify']);
    const res = await post(url, key, notify('manager', 'QA done for BILL-123: 6 pass, 0 fail.'));
    expect(res.json.result.content[0].text).toBe('Sent to your manager in Slack.');
    expect(sent).toEqual([{ conversationId: 'run-1', workerName: 'Robin', to: 'manager', message: 'QA done for BILL-123: 6 pass, 0 fail.' }]);
    expect(calls).toContainEqual({ tool: 'overgo', call: 'notify', who: 'Robin', allowed: true });
    expect((await post(url, key, notify('nobody', 'hi'))).json.result).toMatchObject({ isError: true });
    expect((await post(url, key, notify('', 'hi'))).json.result).toMatchObject({ isError: true });
  });

  it('stops at the most one run may send', async () => {
    const gw = await open(tmpDir(), configFile({}), { 'run-2': { workerName: 'Robin' } });
    const url = `${gw.base()}overgo`;
    const key = `Bearer ${gw.keyFor('run-2')}`;
    for (let i = 0; i < MAX_NOTIFY_PER_RUN; i++) expect((await post(url, key, notify('manager', `update ${i}`))).json.result.isError).toBeUndefined();
    expect((await post(url, key, notify('manager', 'one more'))).json.result.content[0].text).toContain('the most one run may');
  });

  it('answers no key but a run’s, and is offered only on a worker’s run', async () => {
    const gw = await open(tmpDir(), configFile({}), { 'run-3': { workerName: 'Robin' } });
    const url = `${gw.base()}overgo`;
    expect((await post(url, `Bearer ${gw.keyFor()}`, rpc(1, 'tools/list'))).status).toBe(401);
    expect((await post(url, undefined, rpc(1, 'tools/list'))).status).toBe(401);
    expect(builtinGatewayTools('run-3')).toMatchObject({ overgo: { type: 'http', url } });
    expect(builtinGatewayTools('not-a-worker-run')).toEqual({});
  });
});
