// The server's door to remote tools: workers never hold a tool's credentials.
//
// Without it, a remote MCP server is installed in the CLIs' config with its
// real address and its bearer token (a pasted one, or a sign-in's access
// token), and every worker process can read that file. With it:
//
//   vault      each remote tool's real address and headers, sealed in the
//              org dir (tool-gateway.json) under a key of its own
//   config     the CLIs' config points the tool at this gateway, on loopback,
//              with a key that is worthless anywhere else
//   per run    a run's own config carries a key bound to its conversation,
//              so every call is known by worker, and a scoped worker's calls
//              outside its scope are refused here as well as by the CLI
//   forward    the gateway adds the real headers and streams the answer back
//
// Turned on for a hosted server (OVERCLI_TOOL_GATEWAY=1). Turning it off
// puts the real entries back on the next start (`restoreToolsFromVault`).

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { McpServerConfig } from '../mcpConfig';
import { inToolScope, mcpServerKey, scopeRefusal, type ToolScopes } from '../../shared/flows/toolScope';

const AAD = Buffer.from('overcli-tool-gateway-v1');
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/// Headers a CLI sends that the tool needs to see; everything else stays here.
const FORWARD_UP = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];
const FORWARD_DOWN = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control'];
/// Why a call on the shared config's key is refused.
const BOX_REFUSAL = 'Refused: this tool is called through the server, and this call came on the shared key rather than a run of its own.';

export interface VaultedTool {
  url: string;
  headers: Record<string, string>;
}

/// Who a call came from, when the key names a run.
export interface GatewayCaller {
  workerName: string;
  scopes?: ToolScopes;
}

export interface ToolGatewayDeps {
  /// The org dir: the key and the vault live here.
  dir(): string;
  /// The worker behind a conversation, when it is a worker's run.
  callerFor?(conversationId: string): GatewayCaller | undefined;
  /// Every call, allowed or refused.
  onCall?(call: { tool: string; call: string; who: string; allowed: boolean }): void;
  log?(message: string): void;
  fetchImpl?: typeof fetch;
}

type Doc = { tools: Record<string, VaultedTool> };

let active: ToolGateway | null = null;

/// The running gateway, for the runner to bind a run's config to it.
export function activeToolGateway(): ToolGateway | null {
  return active;
}

/// Swap the loopback key in a run's selected MCP config for one bound to the
/// run's conversation. Configs that name no gateway tool pass through.
export function bindToolGateway(configJson: string, conversationId: string): string {
  const gw = active;
  if (!gw || !configJson) return configJson;
  let parsed: { mcpServers?: Record<string, McpServerConfig> };
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return configJson;
  }
  let changed = false;
  for (const config of Object.values(parsed.mcpServers ?? {})) {
    if (typeof config.url !== 'string' || !gw.owns(config.url)) continue;
    config.headers = { Authorization: `Bearer ${gw.keyFor(conversationId)}` };
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : configJson;
}

/// For a run that loads the CLIs' whole config: its gateway tools again, each
/// with a key bound to the run. Passed as the run's own `--mcp-config`, they
/// win over the config's entries of the same name, so the run never calls on
/// the box key. Empty with the gateway off; the config is only read with it on.
export function boundGatewayTools(configured: () => Record<string, McpServerConfig>, conversationId: string): Record<string, McpServerConfig> {
  const gw = active;
  if (!gw) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(configured())) {
    if (typeof config.url !== 'string' || !gw.owns(config.url)) continue;
    out[name] = { ...config, headers: { Authorization: `Bearer ${gw.keyFor(conversationId)}` } };
  }
  return out;
}

function loadKey(dir: string): Buffer {
  const file = path.join(dir, 'tool-gateway.key');
  try {
    const key = fs.readFileSync(file);
    if (key.length === 32) return key;
  } catch {
    // First start: made below.
  }
  const key = randomBytes(32);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

function vaultFile(dir: string): string {
  return path.join(dir, 'tool-gateway.json');
}

function readVault(dir: string, sealKey: Buffer): Doc {
  let raw: string;
  try {
    raw = fs.readFileSync(vaultFile(dir), 'utf8');
  } catch {
    return { tools: {} };
  }
  const sealed = JSON.parse(raw) as { iv: string; tag: string; data: string };
  const decipher = createDecipheriv('aes-256-gcm', sealKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const text = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  const doc = JSON.parse(text) as Doc;
  return { tools: doc.tools ?? {} };
}

function writeVault(dir: string, sealKey: Buffer, doc: Doc): void {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey, iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(JSON.stringify(doc), 'utf8'), cipher.final()]);
  const file = vaultFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function keys(dir: string): { seal: Buffer; mac: Buffer } {
  const root = loadKey(dir);
  return {
    seal: Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'tool-gateway seal', 32)),
    mac: Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'tool-gateway key', 32)),
  };
}

/// A gateway address from any start: the port changes each time.
const GATEWAY_URL = /^http:\/\/127\.0\.0\.1:\d+\/t\//;

/// The CLIs' config, as the gateway reads and rewrites it.
export interface ToolConfigFile {
  read(): Record<string, McpServerConfig>;
  write(name: string, config: McpServerConfig): void;
}

/// Start the gateway and move every remote tool behind it: real addresses
/// and headers into the vault, the CLIs' config onto loopback. Tools already
/// vaulted by an earlier start are pointed at this start's port.
export async function openToolGateway(deps: ToolGatewayDeps, config: ToolConfigFile): Promise<ToolGateway> {
  const gateway = new ToolGateway(deps);
  await gateway.start();
  for (const [name, c] of Object.entries(config.read())) {
    if (typeof c.url !== 'string') continue;
    if (GATEWAY_URL.test(c.url)) {
      if (gateway.real(name)) config.write(name, gateway.entry(name));
      continue;
    }
    const headers = c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers) ? Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k, String(v)])) : {};
    config.write(name, gateway.wrap(name, c.url, headers));
  }
  return gateway;
}

/// The gateway is off: put vaulted tools back in the CLIs' config as they
/// really are, so they keep working without it.
export function closeToolGateway(dir: string, config: ToolConfigFile): void {
  if (!fs.existsSync(vaultFile(dir))) return;
  const tools = readVault(dir, keys(dir).seal).tools;
  for (const [name, c] of Object.entries(config.read())) {
    const t = tools[name];
    if (t && typeof c.url === 'string' && GATEWAY_URL.test(c.url)) {
      config.write(name, { type: 'http', url: t.url, ...(Object.keys(t.headers).length ? { headers: t.headers } : {}) });
    }
  }
}

export class ToolGateway {
  private server: http.Server | null = null;
  private port = 0;
  private readonly seal: Buffer;
  private readonly mac: Buffer;
  private doc: Doc;
  /// Workers seen behind run keys, kept after the runtime lets the run go.
  private readonly known = new Map<string, GatewayCaller>();

  constructor(private readonly deps: ToolGatewayDeps) {
    const k = keys(deps.dir());
    this.seal = k.seal;
    this.mac = k.mac;
    this.doc = readVault(deps.dir(), this.seal);
  }

  /// Listen on loopback. Only processes on this machine can reach it, and
  /// only with a key from a config the server wrote.
  async start(): Promise<void> {
    const server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    active = this;
  }

  stop(): void {
    if (active === this) active = null;
    this.server?.close();
    this.server = null;
  }

  base(): string {
    return `http://127.0.0.1:${this.port}/t/`;
  }

  owns(url: string): boolean {
    return this.port > 0 && url.startsWith(this.base());
  }

  /// A conversation's key, or the box key for configs no run owns.
  keyFor(conversationId?: string): string {
    const subject = conversationId ? `c.${conversationId}` : 'b';
    return `${subject}.${createHmac('sha256', this.mac).update(subject).digest('base64url')}`;
  }

  /// Seal a tool's real address and headers, and give back the config the
  /// CLIs get instead.
  wrap(name: string, url: string, headers: Record<string, string>): McpServerConfig {
    this.doc = { tools: { ...this.doc.tools, [name]: { url, headers } } };
    writeVault(this.deps.dir(), this.seal, this.doc);
    return this.entry(name);
  }

  forget(name: string): void {
    if (!(name in this.doc.tools)) return;
    const { [name]: _gone, ...rest } = this.doc.tools;
    this.doc = { tools: rest };
    writeVault(this.deps.dir(), this.seal, this.doc);
  }

  /// Where a tool really points, and the names (never values) of its headers.
  real(name: string): { url: string; headerNames: string[] } | undefined {
    const t = this.doc.tools[name];
    return t ? { url: t.url, headerNames: Object.keys(t.headers) } : undefined;
  }

  names(): string[] {
    return Object.keys(this.doc.tools);
  }

  /// The config the CLIs see for a vaulted tool.
  entry(name: string): McpServerConfig {
    return { type: 'http', url: `${this.base()}${encodeURIComponent(name)}`, headers: { Authorization: `Bearer ${this.keyFor()}` } };
  }

  /// Who a key belongs to: `box` for the shared config, a conversation id for
  /// a run, null for anything this gateway did not issue.
  private verify(header: string | undefined): { conversationId?: string } | null {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return null;
    const subject = token.slice(0, dot);
    const want = Buffer.from(createHmac('sha256', this.mac).update(subject).digest('base64url'));
    const got = Buffer.from(token.slice(dot + 1));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    if (subject === 'b') return {};
    return subject.startsWith('c.') ? { conversationId: subject.slice(2) } : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const match = /^\/t\/([^/?]+)/.exec(req.url ?? '');
      const name = match ? decodeURIComponent(match[1]) : '';
      const tool = this.doc.tools[name];
      if (!tool) return reply(404, { error: 'No such tool.' });
      const who = this.verify(req.headers.authorization);
      if (!who) return reply(401, { error: 'Not a key this server issued.' });
      const caller = who.conversationId ? this.callerOf(who.conversationId) : undefined;
      const label = caller?.workerName ?? (who.conversationId ? `run ${who.conversationId.slice(0, 8)}` : 'unattributed');

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) return reply(413, { error: 'Too large.' });
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);

      const refused = this.checkCalls(name, body, caller, label, !who.conversationId);
      if (refused) return reply(200, refused);

      const headers: Record<string, string> = {};
      for (const h of FORWARD_UP) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      Object.assign(headers, tool.headers);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const upstream = await (this.deps.fetchImpl ?? fetch)(tool.url, {
        method: req.method,
        headers,
        ...(body.length && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
        redirect: 'manual',
        signal: abort.signal,
      });
      const down: Record<string, string> = {};
      for (const h of FORWARD_DOWN) {
        const v = upstream.headers.get(h);
        if (v) down[h] = v;
      }
      res.writeHead(upstream.status, down);
      if (!upstream.body) return void res.end();
      Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream).on('error', () => res.end()).pipe(res);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      this.deps.log?.(`tool gateway: ${req.method} ${req.url} failed: ${err instanceof Error ? err.message : String(err)}`);
      reply(502, { error: 'The tool could not be reached.' });
    }
  }

  /// The worker behind a run's key. Kept once seen, so a key held past its
  /// run (finished, evicted) still carries that worker's scope.
  private callerOf(conversationId: string): GatewayCaller | undefined {
    const now = this.deps.callerFor?.(conversationId);
    if (now) this.known.set(conversationId, now);
    return now ?? this.known.get(conversationId);
  }

  /// Every `tools/call` in the body, judged against the caller's scope. The
  /// box key names no run, so it may list tools but never call one: any
  /// process that can read the config holds it. A refusal is answered as a
  /// tool error, so the model reads why.
  private checkCalls(name: string, body: Buffer, caller: GatewayCaller | undefined, label: string, box: boolean): unknown | null {
    if (!body.length) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      // Not JSON, so not a call this gateway can judge: never forwarded.
      return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } };
    }
    const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Array<{ id?: unknown; method?: unknown; params?: { name?: unknown } }>;
    let why = '';
    for (const m of messages) {
      if (m?.method !== 'tools/call' || typeof m.params?.name !== 'string') continue;
      const call = m.params.name;
      const full = `mcp__${mcpServerKey(name)}__${call}`;
      const allowed = !box && inToolScope(caller?.scopes, full);
      this.deps.onCall?.({ tool: name, call, who: label, allowed });
      if (!allowed && !why) why = box ? BOX_REFUSAL : scopeRefusal(caller?.scopes, full, caller?.workerName ?? 'This worker');
    }
    if (!why) return null;
    if (!Array.isArray(parsed)) {
      return { jsonrpc: '2.0', id: messages[0]?.id ?? null, result: { content: [{ type: 'text', text: why }], isError: true } };
    }
    // A batch with a refused call is refused whole: half a batch forwarded
    // would leave its other requests unanswered.
    return messages.filter((m) => m?.id !== undefined).map((m) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: why } }));
  }
}
