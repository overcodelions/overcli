import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../mcpConfig';
import { sandboxedCommand } from '../sandbox/seatbeltProfile';
import { stripSecrets } from './secrets';

/// How a run's relayed tools are started: in the run's folder, and inside
/// the run's write jail when the run itself is jailed. The relay runs in the
/// app, outside any sandbox, so a tool it starts must get the run's jail
/// back, or a run could plant a tool definition and have it run free.
export interface RunLaunch {
  cwd?: string;
  sandboxProfile?: string;
}

/// The most one frame (a JSON-RPC message on one line) may be, either way.
/// Tests set OVERCLI_TOOL_RELAY_MAX_FRAME lower; the helper reads the same.
export const MAX_FRAME = Number(process.env.OVERCLI_TOOL_RELAY_MAX_FRAME) || 8 * 1024 * 1024;
type Run = { token: string; tools: Record<string, McpServerConfig>; launch: RunLaunch; sockets: Set<net.Socket> };
const runs = new Map<string, Run>();
const sockets = new Set<net.Socket>();
let server: net.Server | null = null;
let address = '';

function ensureServer(): void {
  if (server) return;
  address = process.platform === 'win32'
    ? `\\\\.\\pipe\\overcli-relay-${process.pid}-${randomBytes(8).toString('hex')}`
    : path.join(os.tmpdir(), `overcli-relay-${process.pid}-${randomBytes(8).toString('hex')}.sock`);
  const listener = net.createServer(serve);
  listener.on('error', () => {
    // A failed listener must fail its clients, not the whole desktop app.
    if (server === listener) closeRunToolRelay();
  });
  server = listener;
  listener.listen(address);
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/// The process a stdio tool becomes for this run: its command and args,
/// wrapped in the run's jail when there is one, in the run's folder (or the
/// tool's own `cwd`), with the server's secrets stripped from the
/// environment and the tool's own env added back.
export function relayLaunch(config: McpServerConfig, launch: RunLaunch): { command: string; args: string[]; cwd?: string; env: Record<string, string> } {
  if (typeof config.command !== 'string') throw new Error('Tool has no transport');
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const spawn = launch.sandboxProfile ? sandboxedCommand(config.command, args, launch.sandboxProfile) : { command: config.command, args };
  const env = Object.fromEntries(Object.entries(stripSecrets(process.env)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const cwd = typeof config.cwd === 'string' ? config.cwd : launch.cwd;
  return { ...spawn, ...(cwd ? { cwd } : {}), env: { ...env, ...strings(config.env) } };
}

function transport(config: McpServerConfig, launch: RunLaunch): Transport {
  if (typeof config.url === 'string') {
    const headers = strings(config.headers);
    const url = new URL(config.url);
    if (config.type === 'sse') {
      // The stream is opened with a GET the SDK makes through its own fetch;
      // the headers have to ride along on that request too.
      return new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...headers } }) },
      });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  return new StdioClientTransport({ ...relayLaunch(config, launch), stderr: 'ignore', maxBufferSize: MAX_FRAME });
}

/// A reply too big to frame fails its own call, not the session: the model
/// hears the tool answered with too much, and its next call still works.
function framed(reply: JSONRPCMessage): string | null {
  const line = JSON.stringify(reply);
  if (Buffer.byteLength(line) <= MAX_FRAME) return line;
  if (!('id' in reply) || reply.id === null || reply.id === undefined || 'method' in reply) return null;
  return JSON.stringify({ jsonrpc: '2.0', id: reply.id, error: { code: -32603, message: `The tool's response was over ${Math.round(MAX_FRAME / 1024 / 1024)} MB and was dropped.` } });
}

function serve(socket: net.Socket): void {
  sockets.add(socket);
  socket.setEncoding('utf8');
  let buffer = '';
  let upstream: Transport | null = null;
  let run: Run | null = null;
  let closed = false;
  let processing = false;
  let initializeId: string | number | undefined;
  let bufferedBytes = 0;
  let scanned = 0;
  const close = async () => {
    if (closed) return;
    closed = true;
    sockets.delete(socket);
    run?.sockets.delete(socket);
    socket.destroy();
    try { await upstream?.close(); } catch { /* already disconnected */ }
  };
  socket.on('close', () => void close());
  socket.on('error', () => void close());

  const drain = async () => {
    if (processing || closed) return;
    processing = true;
    try {
      let at: number;
      // `scanned` is an index no newline sits before; it advances as chunks
      // without one arrive, so a frame is searched once however it arrives.
      while (!closed && (at = buffer.indexOf('\n', scanned)) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        scanned = 0;
        bufferedBytes = Buffer.byteLength(buffer);
        if (!line) continue;
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid frame');
        if (!run) {
          const hello = message as Record<string, unknown>;
          const candidate = typeof hello.conversationId === 'string' ? runs.get(hello.conversationId) : undefined;
          if (hello.type !== 'hello' || !candidate || hello.token !== candidate.token || typeof hello.tool !== 'string'
            || !Object.hasOwn(candidate.tools, hello.tool)) throw new Error('Invalid session');
          run = candidate;
          run.sockets.add(socket);
          upstream = transport(run.tools[hello.tool], run.launch);
          upstream.onmessage = (reply: JSONRPCMessage) => {
            if (closed) return;
            if ('id' in reply && reply.id === initializeId && 'result' in reply) {
              const result = reply.result as { protocolVersion?: unknown };
              if (typeof result?.protocolVersion === 'string') upstream?.setProtocolVersion?.(result.protocolVersion);
            }
            const line = framed(reply);
            if (line) socket.write(line + '\n');
          };
          upstream.onclose = () => void close();
          upstream.onerror = () => void close();
          await upstream.start();
          if (closed) { await upstream.close(); return; }
          socket.write('{"type":"ready"}\n');
        } else {
          const rpc = JSONRPCMessageSchema.parse(message);
          if ('method' in rpc && rpc.method === 'initialize' && 'id' in rpc) initializeId = rpc.id;
          // HTTP send resolves only when its response arrives. Keep reading
          // frames so cancellation, concurrent calls and server-request replies
          // can reach the upstream while another request is still running.
          // Startup stays sequenced above; each send owns its error handling.
          void upstream!.send(rpc).catch(() => void close());
        }
      }
      scanned = buffer.length;
    } catch {
      await close();
    } finally {
      processing = false;
    }
  };
  // Bytes and newlines are counted as chunks arrive, never by rescanning
  // what already waits in the buffer: a multi-megabyte frame costs its own
  // length once, not once per chunk.
  socket.on('data', (chunk: string) => {
    bufferedBytes += Buffer.byteLength(chunk);
    if (bufferedBytes > MAX_FRAME) { void close(); return; }
    const before = buffer.length;
    buffer += chunk;
    if (chunk.indexOf('\n') < 0) {
      if (scanned === before) scanned = buffer.length;
      return;
    }
    void drain();
  });
}

// Canonicalize configuration order so merely reading/reordering settings does
// not revoke a live session. Clone the source so later edits remain detectable.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  return value;
}

/// Register the complete effective set once, after collecting app-owned configs.
/// Descriptors contain no credentials; unchanged registrations retain their token.
/// `launch` says where and inside what jail the run's stdio tools start; a
/// change to it is a new registration too.
export function bindRunTools(configs: Record<string, McpServerConfig>, conversationId: string, launch: RunLaunch = {}): Record<string, McpServerConfig> {
  if (!Object.keys(configs).length) { releaseRunTools(conversationId); return {}; }
  ensureServer();
  const helper = path.join(__dirname, '..', 'runToolRelayHelper.js');
  const previous = runs.get(conversationId);
  const source = Object.fromEntries(Object.entries(configs).map(([name, config]) => {
    if (config.command === process.execPath && Array.isArray(config.args) && config.args[0] === helper) {
      if (!previous || !Object.hasOwn(previous.tools, name)) throw new Error('Relay session is no longer available');
      return [name, previous.tools[name]];
    }
    return [name, config];
  }));
  const encoded = JSON.stringify(canonical(source));
  const launchEncoded = JSON.stringify(canonical({ cwd: launch.cwd ?? '', sandboxProfile: launch.sandboxProfile ?? '' }));
  const unchanged = previous && JSON.stringify(previous.tools) === encoded && JSON.stringify(canonical({ cwd: previous.launch.cwd ?? '', sandboxProfile: previous.launch.sandboxProfile ?? '' })) === launchEncoded;
  if (!unchanged) {
    releaseRunTools(conversationId);
    runs.set(conversationId, { token: randomBytes(32).toString('hex'), tools: JSON.parse(encoded), launch: { ...launch }, sockets: new Set() });
  }
  const env = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
  return Object.fromEntries(Object.keys(configs).map(name => [name, {
    command: process.execPath, args: [helper, address, conversationId, name], ...(env ? { env } : {}),
  }]));
}

/// How a run's tools are launched, for whoever checks a registration.
export function runToolLaunch(conversationId: string): RunLaunch | undefined {
  const run = runs.get(conversationId);
  return run ? { ...run.launch } : undefined;
}

export function runToolRelayEnv(conversationId: string): Record<string, string> {
  const run = runs.get(conversationId);
  return run ? { OVERCLI_TOOL_RELAY_TOKEN: run.token } : {};
}

export function releaseRunTools(conversationId: string): void {
  const run = runs.get(conversationId);
  runs.delete(conversationId);
  for (const socket of run?.sockets ?? []) socket.destroy();
}

export function closeRunToolRelay(): void {
  for (const id of [...runs.keys()]) releaseRunTools(id);
  for (const socket of sockets) socket.destroy();
  const listener = server;
  const oldAddress = address;
  server = null;
  address = '';
  try { listener?.close(); } catch { /* not listening */ }
  if (process.platform !== 'win32' && oldAddress) try { fs.unlinkSync(oldAddress); } catch { /* already removed */ }
}
