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
import { shareWithWorkers } from './workerUser';

/// How a run's relayed tools are started: in the run's folder, and inside
/// the run's write jail when the run itself is jailed. The relay runs in the
/// app, outside any sandbox, so a tool it starts must get the run's jail
/// back, or a run could plant a tool definition and have it run free.
export interface RunLaunch {
  cwd?: string;
  /// HOME for the tool, when the server's own (shared with workers) won't do.
  home?: string;
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
  const at = address;
  listener.listen(at, () => {
    // Workers connect as their own user when there is one. Every call still
    // needs its run's token.
    if (process.platform !== 'win32') {
      try {
        shareWithWorkers(at);
      } catch {
        // A relay workers can't reach fails its tools' calls, and says so there.
      }
    }
  });
}

function strings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/// What a tool started for a run gets on top of its env (workerCloud.ts gives
/// it the worker's cloud role). Throwing fails the tool's start.
type RelayToolEnv = (ctx: { conversationId: string; tool: string }, env: Record<string, string>, toolEnv: Record<string, string>) => Record<string, string>;
let relayToolEnv: RelayToolEnv | null = null;

export function setRelayToolEnv(fn: RelayToolEnv | null): void {
  relayToolEnv = fn;
}

/// The process a stdio tool becomes for this run: its command and args,
/// wrapped in the run's jail when there is one, in the run's folder (or the
/// tool's own `cwd`), with the server's secrets stripped from the
/// environment and the tool's own env added back.
export function relayLaunch(config: McpServerConfig, launch: RunLaunch, ctx?: { conversationId: string; tool: string }): { command: string; args: string[]; cwd?: string; env: Record<string, string> } {
  if (typeof config.command !== 'string') throw new Error('Tool has no transport');
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const spawn = launch.sandboxProfile ? sandboxedCommand(config.command, args, launch.sandboxProfile) : { command: config.command, args };
  const env = Object.fromEntries(Object.entries(stripSecrets(process.env)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const cwd = typeof config.cwd === 'string' ? config.cwd : launch.cwd;
  const toolEnv = strings(config.env);
  const full = { ...env, ...(launch.home ? { HOME: launch.home } : {}), ...toolEnv };
  return { ...spawn, ...(cwd ? { cwd } : {}), env: ctx && relayToolEnv ? relayToolEnv(ctx, full, toolEnv) : full };
}

/// The header that marks an org server's MCP (orgChatTools sets it), lower-cased.
const ORG_CLIENT_HEADER = 'x-overcli-client';

function transport(config: McpServerConfig, launch: RunLaunch, ctx: { conversationId: string; tool: string }): Transport {
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
    // An org server's MCP (marked by the overcli client header) never
    // redirects; refusing keeps its token from following one anywhere.
    // Other tools may redirect, and Node drops credentials across origins.
    const org = Object.keys(headers).some((k) => k.toLowerCase() === ORG_CLIENT_HEADER);
    return new StreamableHTTPClientTransport(url, { requestInit: { headers, ...(org ? { redirect: 'error' as const } : {}) } });
  }
  return new StdioClientTransport({ ...relayLaunch(config, launch, ctx), stderr: 'ignore', maxBufferSize: MAX_FRAME });
}

/// A reply too big to frame fails its own call, not the session: the model
/// hears the tool answered with too much, and its next call still works.
function framed(reply: JSONRPCMessage): string | null {
  const line = JSON.stringify(reply);
  if (Buffer.byteLength(line) <= MAX_FRAME) return line;
  if (!('id' in reply) || reply.id === null || reply.id === undefined || 'method' in reply) return null;
  return JSON.stringify({ jsonrpc: '2.0', id: reply.id, error: { code: -32603, message: `The tool's response was over ${Math.round(MAX_FRAME / 1024 / 1024)} MB and was dropped.` } });
}

/// A say over one relayed tool's calls, for tools that act as the person
/// (overgo, orgChatTools.ts). Consulted for each call to a tool its server
/// didn't mark read-only, and for each tool list. Null from either: this
/// tool isn't covered, carry on as before.
export interface RelayCallGuard {
  /// 'readOnly': the tool list shows only read-only tools.
  listMode(ctx: { conversationId: string; tool: string }): 'all' | 'readOnly' | null;
  checkCall(ctx: { conversationId: string; tool: string; name: string; args: unknown }): Promise<{ allow: true } | { allow: false; message: string }> | null;
}

let callGuard: RelayCallGuard | null = null;

export function setRelayCallGuard(guard: RelayCallGuard | null): void {
  callGuard = guard;
}

/// Why an HTTP tool's request failed, as the chat should hear it: the
/// server's own sentence when it sent one (a 401's "sign in again"), or that
/// it couldn't be reached.
export function relayFailureWords(tool: string, err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const body = JSON.parse(text.slice(brace)) as { error?: { message?: unknown } | string; message?: unknown };
      const said = typeof body.error === 'object' ? body.error?.message : typeof body.error === 'string' ? body.error : body.message;
      if (typeof said === 'string' && said.trim()) return `${tool}: ${said.trim().slice(0, 500)}`;
    } catch {
      // Not JSON after all: fall through to the plain words.
    }
  }
  if (code === 401 || code === 403) return `${tool} refused this app's sign-in (${code}). Sign in to it again.`;
  if (typeof code === 'number') return `${tool} answered with an error (${code}).`;
  return `${tool} couldn't be reached. Check the connection and try again.`;
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
  let stdio = true;
  let tool = '';
  let conv = '';
  /// Tools the server marked read-only in its list, and the ids of list
  /// requests whose answers are still to come (RelayCallGuard).
  const readOnly = new Set<string>();
  const listing = new Set<string | number>();
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
  // HTTP send resolves only when its response arrives. Keep reading frames so
  // cancellation, concurrent calls and server-request replies can reach the
  // upstream while another request is still running. A stdio tool that can't
  // take a message has gone: end the session. An HTTP tool's request can fail
  // on its own (the server down for a moment, a sign-in that expired): that
  // call is answered with why, in words, and the next call is tried afresh.
  const forward = (rpc: JSONRPCMessage) => {
    void upstream!.send(rpc).catch((err: unknown) => {
      if (stdio || !('method' in rpc) || !('id' in rpc) || closed) return void close();
      const line = framed({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: relayFailureWords(tool, err) } });
      if (line) socket.write(line + '\n');
    });
  };
  // A tool list: note which tools the server marked read-only, and with the
  // guard asking for it, leave out every other one.
  const guardedList = (reply: JSONRPCMessage): JSONRPCMessage => {
    const result = (reply as { result?: { tools?: unknown } }).result;
    if (!result || !Array.isArray(result.tools)) return reply;
    const tools = result.tools as Array<{ name?: unknown; annotations?: { readOnlyHint?: unknown } }>;
    for (const t of tools) if (typeof t.name === 'string' && t.annotations?.readOnlyHint === true) readOnly.add(t.name);
    if (callGuard?.listMode({ conversationId: conv, tool }) !== 'readOnly') return reply;
    return { ...reply, result: { ...result, tools: tools.filter((t) => typeof t.name === 'string' && readOnly.has(t.name)) } } as JSONRPCMessage;
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
          upstream = transport(run.tools[hello.tool], run.launch, { conversationId: hello.conversationId as string, tool: hello.tool });
          upstream.onmessage = (reply: JSONRPCMessage) => {
            if (closed) return;
            if ('id' in reply && reply.id === initializeId && 'result' in reply) {
              const result = reply.result as { protocolVersion?: unknown };
              if (typeof result?.protocolVersion === 'string') upstream?.setProtocolVersion?.(result.protocolVersion);
            }
            if ('id' in reply && reply.id !== null && reply.id !== undefined && listing.delete(reply.id) && 'result' in reply) reply = guardedList(reply);
            const line = framed(reply);
            if (line) socket.write(line + '\n');
          };
          upstream.onclose = () => void close();
          // A stdio tool that prints a line that isn't JSON ("Server running
          // on stdio") is still running: the SDK reports the line here and
          // reads on, as Claude Code does when it starts the tool itself. Its
          // exit closes the session through onclose. An HTTP tool reports a
          // failed request here as well as to its send, which answers that
          // call with why (below); the session stays for the next call.
          stdio = typeof run.tools[hello.tool].command === 'string';
          tool = hello.tool;
          conv = hello.conversationId as string;
          upstream.onerror = () => {};
          await upstream.start();
          if (closed) { await upstream.close(); return; }
          socket.write('{"type":"ready"}\n');
        } else {
          const rpc = JSONRPCMessageSchema.parse(message);
          if ('method' in rpc && rpc.method === 'initialize' && 'id' in rpc) initializeId = rpc.id;
          if ('method' in rpc && rpc.method === 'tools/list' && 'id' in rpc) listing.add(rpc.id);
          // A call to a tool its server didn't mark read-only goes through the
          // guard first, when one covers this tool: it may ask the person, or
          // refuse. Read-only calls and every other tool go straight on.
          const name = 'method' in rpc && rpc.method === 'tools/call' && 'id' in rpc ? String((rpc as { params?: { name?: unknown } }).params?.name ?? '') : null;
          const check = name !== null && !readOnly.has(name) ? callGuard?.checkCall({ conversationId: conv, tool, name, args: ((rpc as { params?: { arguments?: unknown } }).params)?.arguments }) : null;
          if (check) {
            void check.then(
              (d) => {
                if (closed) return;
                if (d.allow) return forward(rpc);
                const line = framed({ jsonrpc: '2.0', id: (rpc as { id: string | number }).id, result: { content: [{ type: 'text', text: d.message }], isError: true } });
                if (line) socket.write(line + '\n');
              },
              () => void close(),
            );
          } else forward(rpc);
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
