// Call an MCP tool directly — no model in the loop.
//
// A Watch trigger asks a tool the same question every few minutes ("open
// bugs in Support Backlog") and only wakes a worker when the answer has
// something new in it. Going through a model for that would cost a planning
// turn every poll; this is one tool call over MCP, the way the worker's CLI
// would make it, against the same server config (~/.claude.json).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../mcpConfig';

const CALL_TIMEOUT_MS = 60_000;

export type ToolCall = { ok: true; text: string; json: unknown } | { ok: false; error: string };

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function record(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string') as Array<[string, string]>);
}

async function connect(config: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'overcli-watch', version: '1' });
  const url = str(config.url);
  if (url) {
    const headers = record(config.headers);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
    return client;
  }
  const command = str(config.command);
  if (!command) throw new Error('This tool has neither a command nor a URL.');
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  const env = { ...(process.env as Record<string, string>), ...record(config.env) };
  await client.connect(new StdioClientTransport({ command, args, env, stderr: 'ignore' }));
  return client;
}

async function withClient<T>(config: McpServerConfig, fn: (c: Client) => Promise<T>): Promise<T> {
  let client: Client | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      (async () => {
        client = await connect(config);
        return fn(client);
      })(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The tool did not answer within a minute.')), CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await (client as Client | null)?.close();
    } catch {
      // already gone
    }
  }
}

/// The tools a server offers, for the trigger builder's picker — with each
/// one's input schema when asked, to fill its arguments in.
export async function listServerTools(
  config: McpServerConfig,
  opts: { schemas?: boolean } = {},
): Promise<{ ok: true; tools: Array<{ name: string; description?: string; inputSchema?: unknown }> } | { ok: false; error: string }> {
  try {
    const res = await withClient(config, (c) => c.listTools());
    return {
      ok: true,
      tools: res.tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description.slice(0, 300) } : {}),
        ...(opts.schemas && t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      })),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// A tool's structured answer, with the wrapper some servers put round a
/// string taken off: FastMCP returns a tool's JSON text as `{ "result":
/// "<that JSON>" }`, and a ticket search read through it found no tickets.
export function unwrapResult(structured: unknown): unknown {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return structured;
  const values = Object.values(structured);
  if (values.length !== 1 || typeof values[0] !== 'string') return structured;
  try {
    const inner: unknown = JSON.parse(values[0]);
    return inner && typeof inner === 'object' ? inner : structured;
  } catch {
    return structured;
  }
}

export async function callTool(config: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<ToolCall> {
  try {
    const res = await withClient(config, (c) => c.callTool({ name: tool, arguments: args }));
    const parts = Array.isArray(res.content) ? (res.content as Array<{ type?: string; text?: string }>) : [];
    const text = parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
    if (res.isError) return { ok: false, error: text.slice(0, 500) || 'The tool reported an error.' };
    const structured = unwrapResult((res as { structuredContent?: unknown }).structuredContent);
    let json: unknown = structured ?? null;
    if (json === null && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: true, text, json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/// The new items in a tool's answer. A list is found at `itemsPath`, or as
/// the first array in the answer; each item's identity is `idPath` (or
/// id/key/number/url). An answer with no list counts as one item, named by
/// its own text, so a Watch on "the build status" fires when it changes.
export interface WatchItem {
  id: string;
  title: string;
  url?: string;
  data: unknown;
}

/// A value inside an item by a dotted path: `fields.status.name`.
export function at(obj: unknown, dotted: string): unknown {
  return dotted.split('.').filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function firstArray(v: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object' || depth > 3) return null;
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = firstArray(x, depth + 1);
    if (found) return found;
  }
  return null;
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// CloudWatch alarms name themselves by alarm name (snake or Pascal case, by client).
const TITLE_KEYS = ['title', 'summary', 'name', 'subject', 'fields.summary', 'text', 'alarm_name', 'AlarmName'];
const ID_KEYS = ['id', 'key', 'number', 'url', 'html_url'];
const URL_KEYS = ['url', 'html_url', 'permalink', 'self', 'web_url'];

export function itemsFrom(call: { text: string; json: unknown }, opts: { itemsPath?: string; idPath?: string } = {}): WatchItem[] {
  const list = call.json !== null && call.json !== undefined ? (opts.itemsPath ? at(call.json, opts.itemsPath) : firstArray(call.json)) : null;
  if (!Array.isArray(list)) {
    return call.text.trim() ? [{ id: hash(call.text), title: call.text.trim().split('\n')[0].slice(0, 140), data: call.json ?? call.text }] : [];
  }
  return list.slice(0, 500).map((item) => {
    const pick = (keys: string[]) => keys.map((k) => at(item, k)).find((v) => typeof v === 'string' || typeof v === 'number');
    const id = opts.idPath ? at(item, opts.idPath) : pick(ID_KEYS);
    const key = typeof item === 'object' && item ? at(item, 'key') : undefined;
    const title = pick(TITLE_KEYS);
    const url = URL_KEYS.map((k) => at(item, k)).find((v) => typeof v === 'string' && /^https?:\/\//.test(v)) as string | undefined;
    return {
      id: id !== undefined ? String(id) : hash(JSON.stringify(item)),
      title: [key && typeof key === 'string' && title !== key ? key + ':' : '', title !== undefined ? String(title) : typeof item === 'string' ? item : 'Item']
        .filter(Boolean)
        .join(' ')
        .slice(0, 160),
      ...(url ? { url } : {}),
      data: item,
    };
  });
}
