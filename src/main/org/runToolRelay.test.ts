import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindRunTools, closeRunToolRelay, relayLaunch, releaseRunTools, runToolLaunch, runToolRelayEnv } from './runToolRelay';
import { SANDBOX_EXEC } from '../sandbox/seatbeltProfile';
import { overdbToolsForRun, useOverdbWorkerLookup } from './overdbBinding';

const cleanup: Array<() => void> = [];
afterEach(() => {
  closeRunToolRelay();
  for (const fn of cleanup.splice(0)) fn();
  useOverdbWorkerLookup(() => undefined);
});

const echo = `
require('readline').createInterface({input:process.stdin}).on('line', line => {
  const m=JSON.parse(line);
  if (m.method==='notifications/cancelled') {
    console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'cancelled',progress:1}}));
  } else if (m.id !== undefined) {
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({password:process.env.PASSWORD,worker:process.env.OVERCLI_WORKER,conversation:process.env.OVERCLI_CONVERSATION,gh:process.env.GH_TOKEN,connectionsKey:process.env.OVERCLI_CONNECTIONS_KEY,home:process.env.HOME,args:m.params})}]}}));
  }
});`;
const db = { command: process.execPath, args: ['-e', echo], env: { PASSWORD: 'db-secret' } };

async function connect(descriptor: { args?: unknown }, conversationId: string, tool: string, token = runToolRelayEnv(conversationId).OVERCLI_TOOL_RELAY_TOKEN) {
  const socket = net.createConnection((descriptor.args as string[])[1]);
  cleanup.push(() => socket.destroy());
  socket.on('error', () => {});
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  await once(socket, 'connect');
  socket.write(JSON.stringify({ type: 'hello', token, conversationId, tool }) + '\n');
  return {
    socket,
    next: async () => { const line = await lines.next(); return line.done ? undefined : JSON.parse(line.value); },
    send: (message: unknown) => socket.write(JSON.stringify(message) + '\n'),
  };
}

describe('run tool relay', () => {
  it('retains the complete database/gateway session across repeated launch inspections', () => {
    useOverdbWorkerLookup(() => 'Triage');
    const gateway = { url: 'http://127.0.0.1:123/t/issues', headers: { Authorization: 'Bearer gateway-secret' } };
    const bind = () => bindRunTools({ gateway, ...overdbToolsForRun(() => ({ overdb: db }), 'one') }, 'one');
    const first = bind();
    const token = runToolRelayEnv('one');
    expect(bind()).toEqual(first);
    expect(runToolRelayEnv('one')).toEqual(token);
    expect(JSON.stringify(first)).not.toContain('db-secret');
    expect(JSON.stringify(first)).not.toContain('gateway-secret');
    bindRunTools({ ...first }, 'one');
    expect(runToolRelayEnv('one')).toEqual(token);
    bindRunTools({ overdb: db }, 'two');
    expect(runToolRelayEnv('two')).not.toEqual(token);
  });

  it('delivers credentials and attribution only to the app-owned process, preserving results and notifications', async () => {
    useOverdbWorkerLookup(() => 'Triage');
    const config = bindRunTools(overdbToolsForRun(() => ({ overdb: db }), 'one'), 'one');
    const client = await connect(config.overdb, 'one', 'overdb');
    expect(await client.next()).toEqual({ type: 'ready' });
    client.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'query', arguments: { sql: 'select 1' } } });
    const reply = await client.next();
    expect(reply.id).toBe(7);
    expect(JSON.parse(reply.result.content[0].text)).toMatchObject({ password: 'db-secret', worker: 'Triage', conversation: 'one', args: { name: 'query' } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
    expect(await client.next()).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'cancelled' } });
    const closed = once(client.socket, 'close');
    releaseRunTools('one');
    await closed;
    expect(runToolRelayEnv('one')).toEqual({});
  });

  it('starts a stdio tool in the run\'s folder and inside the run\'s jail, and rebinds when the jail changes', async () => {
    const plain = relayLaunch({ command: 'npx', args: ['acme-mcp'], env: { KEY: 'k' } }, { cwd: '/repo' });
    expect(plain).toMatchObject({ command: 'npx', args: ['acme-mcp'], cwd: '/repo', env: expect.objectContaining({ KEY: 'k' }) });
    const jailed = relayLaunch({ command: 'npx', args: ['acme-mcp'] }, { cwd: '/repo', sandboxProfile: '/data/seatbelt/abc.sb' });
    expect(jailed).toMatchObject({ command: SANDBOX_EXEC, args: ['-f', '/data/seatbelt/abc.sb', 'npx', 'acme-mcp'], cwd: '/repo' });
    // A tool's own cwd is kept; a run with none is started where the app is.
    expect(relayLaunch({ command: 'node', cwd: '/tool' }, { cwd: '/repo' }).cwd).toBe('/tool');
    expect(relayLaunch({ command: 'node' }, {}).cwd).toBeUndefined();
    const first = bindRunTools({ acme: db }, 'one', { cwd: '/repo' });
    const token = runToolRelayEnv('one');
    expect(runToolLaunch('one')).toEqual({ cwd: '/repo' });
    expect(bindRunTools({ acme: db }, 'one', { cwd: '/repo' })).toEqual(first);
    expect(runToolRelayEnv('one')).toEqual(token);
    bindRunTools({ acme: db }, 'one', { cwd: '/repo', sandboxProfile: '/data/seatbelt/abc.sb' });
    expect(runToolRelayEnv('one')).not.toEqual(token);
    expect(runToolLaunch('one')).toEqual({ cwd: '/repo', sandboxProfile: '/data/seatbelt/abc.sb' });
  });

  it('starts a tool without the server\'s secrets, keeping its own env and the ordinary environment', async () => {
    const before = { GH_TOKEN: process.env.GH_TOKEN, OVERCLI_CONNECTIONS_KEY: process.env.OVERCLI_CONNECTIONS_KEY };
    process.env.GH_TOKEN = 'server-github-token';
    process.env.OVERCLI_CONNECTIONS_KEY = 'sealed-store-key';
    cleanup.push(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const config = bindRunTools({ acme: db }, 'one');
    const client = await connect(config.acme, 'one', 'acme');
    expect(await client.next()).toEqual({ type: 'ready' });
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: {} } });
    const seen = JSON.parse((await client.next()).result.content[0].text);
    expect(seen).toMatchObject({ password: 'db-secret', home: process.env.HOME });
    expect(seen.gh).toBeUndefined();
    expect(seen.connectionsKey).toBeUndefined();
  });

  it('fails one call whose reply is over the frame cap and keeps the session', async () => {
    const upstream = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/call'
        ? { content: [{ type: 'text', text: 'x'.repeat(9 * 1024 * 1024) }] }
        : { tools: [] } }));
    });
    cleanup.push(() => { upstream.closeAllConnections(); upstream.close(); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as net.AddressInfo).port;
    const config = bindRunTools({ gateway: { url: `http://127.0.0.1:${port}` } }, 'one');
    const client = await connect(config.gateway, 'one', 'gateway');
    expect(await client.next()).toEqual({ type: 'ready' });
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'big', arguments: {} } });
    expect(await client.next()).toMatchObject({ id: 1, error: { code: -32603, message: expect.stringContaining('8 MB') } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(await client.next()).toMatchObject({ id: 2, result: { tools: [] } });
  });

  it('refuses another conversation, unknown tools, revoked tokens and malformed frames without losing the listener', async () => {
    const config = bindRunTools({ overdb: db }, 'one');
    bindRunTools({ overdb: db }, 'two');
    const token = runToolRelayEnv('one').OVERCLI_TOOL_RELAY_TOKEN;
    for (const [conversation, tool, key] of [['two', 'overdb', token], ['one', 'missing', token], ['one', 'overdb', 'revoked']]) {
      const client = await connect(config.overdb, conversation, tool, key);
      expect(await client.next()).toBeUndefined();
    }
    const socket = net.createConnection((config.overdb.args as string[])[1]);
    cleanup.push(() => socket.destroy());
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    socket.write('null\n');
    await closed;
    const good = await connect(config.overdb, 'one', 'overdb');
    expect(await good.next()).toEqual({ type: 'ready' });
  });

  it('revokes connected clients when credentials or the effective tool set change', async () => {
    const configs = { overdb: db };
    const first = bindRunTools(configs, 'one');
    const client = await connect(first.overdb, 'one', 'overdb');
    await client.next();
    const oldToken = runToolRelayEnv('one');
    const closed = once(client.socket, 'close');
    configs.overdb = { ...db, env: { PASSWORD: 'replacement' } };
    bindRunTools(configs, 'one');
    await closed;
    expect(runToolRelayEnv('one')).not.toEqual(oldToken);
    bindRunTools({}, 'one');
    expect(runToolRelayEnv('one')).toEqual({});
  });

  it('passes the negotiated protocol version and private bearer header on subsequent HTTP calls', async () => {
    const seen: Array<{ version?: string; auth?: string }> = [];
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString());
      seen.push({ version: req.headers['mcp-protocol-version'] as string | undefined, auth: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : { tools: [] } }));
    });
    cleanup.push(() => { upstream.closeAllConnections(); upstream.close(); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as net.AddressInfo).port;
    const config = bindRunTools({ gateway: { url: `http://127.0.0.1:${port}`, headers: { Authorization: 'Bearer private' } } }, 'one');
    const client = await connect(config.gateway, 'one', 'gateway');
    await client.next();
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(await client.next()).toMatchObject({ id: 1, result: { protocolVersion: '2025-11-25' } });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(await client.next()).toMatchObject({ id: 2, result: { tools: [] } });
    expect(seen[1]).toEqual({ version: '2025-11-25', auth: 'Bearer private' });
  });

  it('forwards cancellation and concurrent requests while an HTTP call is still running', async () => {
    const received: string[] = [];
    let slowResponse: http.ServerResponse | undefined;
    const upstream = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.method === 'tools/call') {
        received.push('slow');
        slowResponse = res;
        return; // Deliberately withhold even the response headers.
      }
      if (message.method === 'notifications/cancelled') {
        received.push('cancel');
        res.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') received.push('list');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : { tools: [] } }));
    });
    cleanup.push(() => { upstream.closeAllConnections(); upstream.close(); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as net.AddressInfo).port;
    const config = bindRunTools({ gateway: { url: `http://127.0.0.1:${port}` } }, 'one');
    const client = await connect(config.gateway, 'one', 'gateway');
    expect(await client.next()).toEqual({ type: 'ready' });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    expect(await client.next()).toMatchObject({ id: 1 });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
    await vi.waitFor(() => expect(slowResponse).toBeDefined());
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await vi.waitFor(() => expect(received).toEqual(expect.arrayContaining(['slow', 'list', 'cancel'])));
    expect(slowResponse!.writableEnded).toBe(false);
    expect(await client.next()).toMatchObject({ id: 3, result: { tools: [] } });
    slowResponse!.writeHead(200, { 'Content-Type': 'application/json' });
    slowResponse!.end(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [] } }));
    expect(await client.next()).toMatchObject({ id: 2, result: { content: [] } });
  });

  it('contains an asynchronous HTTP send failure without losing the relay listener', async () => {
    const upstream = http.createServer((_req, res) => res.writeHead(503).end('unavailable'));
    cleanup.push(() => { upstream.closeAllConnections(); upstream.close(); });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as net.AddressInfo).port;
    const config = bindRunTools({ gateway: { url: `http://127.0.0.1:${port}` } }, 'one');
    const client = await connect(config.gateway, 'one', 'gateway');
    expect(await client.next()).toEqual({ type: 'ready' });
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(await client.next()).toBeUndefined();
    const next = await connect(config.gateway, 'one', 'gateway');
    expect(await next.next()).toEqual({ type: 'ready' });
  });

  it('buffers initialization across failed startup attempts and until the ready handshake', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'runToolRelayHelper.ts'), 'utf8');
    const js = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-helper-'));
    const address = path.join(dir, 'test.sock');
    const frames: unknown[] = [];
    const listener = net.createServer(socket => {
      cleanup.push(() => socket.destroy());
      const lines = createInterface({ input: socket });
      lines.on('line', line => {
        const message = JSON.parse(line);
        frames.push(message);
        if (message.type === 'hello') socket.write('{"type":"ready"}\n');
        else socket.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
      });
    });
    cleanup.push(() => { listener.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const child = spawn(process.execPath, ['-e', js, 'helper', address, 'one', 'overdb'], { env: { ...process.env, OVERCLI_TOOL_RELAY_TOKEN: 'token' }, stdio: ['pipe', 'pipe', 'pipe'] });
    cleanup.push(() => child.kill());
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    child.stdin.write('{"jsonrpc":"2.0","id":9,"method":"initialize","params":{}}\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    listener.listen(address);
    const reply = await lines.next();
    expect(JSON.parse(reply.value!)).toMatchObject({ id: 9 });
    expect(frames).toEqual([
      { type: 'hello', token: 'token', conversationId: 'one', tool: 'overdb' },
      { jsonrpc: '2.0', id: 9, method: 'initialize', params: {} },
    ]);
  });
});
