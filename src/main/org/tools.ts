// The MCP servers this org server's workers can use: what is installed, who
// relies on each, and what a worker names that is not here.
//
// On a server, workers run Claude Code (and Codex, when installed) inside the
// container, and those read MCP servers from their user config on the state
// volume — ~/.claude.json and ~/.codex/config.toml under HOME=/data/home. So
// installing one is writing that file, which is all this does. A worker's
// `mcpServers` is an allow-list of names, so a worker brought over from a
// desktop only gets a tool when the name matches.
//
// Secrets are written where the CLIs read them and never handed back: the
// listing says a value is set, not what it is.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeMcpServers, removeMcpServer, writeMcpServer, type McpServerConfig } from '../mcpConfig';

export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ToolSummary {
  name: string;
  kind: 'command' | 'http';
  /// The command and its arguments, or the URL. Never a secret.
  target: string;
  /// Names of the environment variables or headers it sets, values hidden.
  secrets: string[];
  usedBy: string[];
  /// From the last check, when there was one.
  status?: string;
}

export interface ToolInput {
  name: string;
  kind: 'command' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

const codexInstalled = (): boolean => fs.existsSync(path.join(os.homedir(), '.codex'));

export function listTools(
  roster: ReadonlyArray<{ name: string; mcpServers?: string[] }>,
  statuses: Record<string, string> = {},
  templates: Record<string, ToolTemplate> = {},
): {
  tools: ToolSummary[];
  missing: Array<{ name: string; workers: string[]; template?: ToolTemplate }>;
} {
  const installed = readClaudeMcpServers();
  const users = (name: string) => roster.filter((w) => w.mcpServers?.includes(name)).map((w) => w.name);
  const tools = Object.entries(installed)
    .map(([name, c]): ToolSummary => {
      const http = typeof c.url === 'string';
      const env = c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? Object.keys(c.env) : [];
      const headers = c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers) ? Object.keys(c.headers) : [];
      return {
        name,
        kind: http ? 'http' : 'command',
        target: http ? String(c.url) : [String(c.command ?? ''), ...(Array.isArray(c.args) ? c.args.map(String) : [])].join(' ').trim(),
        secrets: [...env, ...headers],
        usedBy: users(name),
        ...(statuses[name] ? { status: statuses[name] } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const wanted = new Set(roster.flatMap((w) => w.mcpServers ?? []));
  const missing = [...wanted]
    .filter((n) => !(n in installed))
    .sort()
    .map((name) => ({ name, workers: users(name), ...(templates[name] ? { template: templates[name] } : {}) }));
  return { tools, missing };
}

export function installTool(input: ToolInput): { ok: true } | { ok: false; error: string } {
  const name = input.name?.trim() ?? '';
  if (!TOOL_NAME.test(name)) return { ok: false, error: 'A name is letters, numbers, dashes or underscores, and must match what workers list (e.g. jira).' };
  const clean = (o?: Record<string, string>) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k.trim()) && typeof v === 'string').map(([k, v]) => [k.trim(), v]));
  let config: McpServerConfig;
  if (input.kind === 'http') {
    let url: URL;
    try {
      url = new URL(input.url ?? '');
    } catch {
      return { ok: false, error: 'That is not a web address.' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Use an https:// address.' };
    const headers = clean(input.headers);
    config = { type: 'http', url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const command = input.command?.trim() ?? '';
    if (!command) return { ok: false, error: 'Say what command starts it, e.g. npx.' };
    const env = clean(input.env);
    config = { command, args: (input.args ?? []).map(String).filter((a) => a.length), ...(Object.keys(env).length ? { env } : {}) };
  }
  try {
    writeMcpServer('claude', name, config);
    // Codex takes command servers the same way; its remote ones are set up
    // differently, so those stay Claude's.
    if (codexInstalled() && input.kind !== 'http') writeMcpServer('codex', name, config);
  } catch (err) {
    return { ok: false, error: `Could not write the config: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}

export function uninstallTool(name: string): { ok: true } | { ok: false; error: string } {
  if (!TOOL_NAME.test(name)) return { ok: false, error: 'No tool by that name.' };
  try {
    removeMcpServer('claude', name);
    if (codexInstalled()) removeMcpServer('codex', name);
  } catch (err) {
    return { ok: false, error: `Could not write the config: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}

// ---- WHAT A PUBLISHED WORKER BROUGHT ---------------------------------------

/// How a tool was set up on the desktop a worker was published from, minus
/// every secret: the command or URL, and the names of its settings. Enough to
/// fill in the install form, never enough to use the tool.
export interface ToolTemplate {
  name: string;
  kind: 'command' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
}

/// Strip a desktop MCP config down to a template. Values go; names stay.
export function templateFrom(name: string, config: McpServerConfig): ToolTemplate | null {
  if (!TOOL_NAME.test(name)) return null;
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object).slice(0, 30) : []);
  if (typeof config.url === 'string') {
    // A URL can carry a key in its query string: keep only where it points.
    let url: string;
    try {
      const u = new URL(config.url);
      url = `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
    return { name, kind: 'http', url, envKeys: [], headerKeys: keys(config.headers) };
  }
  if (typeof config.command !== 'string') return null;
  return {
    name,
    kind: 'command',
    command: config.command,
    // Arguments are where a careless config hides a token: keep the ones that
    // look like package names or flags, drop anything long and opaque.
    args: (Array.isArray(config.args) ? config.args.map(String) : []).filter((a) => a.length <= 80 && !/^[A-Za-z0-9_\-]{32,}$/.test(a)),
    envKeys: keys(config.env),
    headerKeys: [],
  };
}

/// Templates are only ever suggestions; anything malformed is dropped.
export function parseTemplates(raw: unknown): ToolTemplate[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(0, 30) : []);
  return raw
    .slice(0, 30)
    .map((t): ToolTemplate | null => {
      const o = (t ?? {}) as Record<string, unknown>;
      const name = str(o.name, 64);
      if (!name || !TOOL_NAME.test(name)) return null;
      const kind = o.kind === 'http' ? 'http' : 'command';
      return {
        name,
        kind,
        ...(str(o.command, 200) ? { command: str(o.command, 200) } : {}),
        args: list(o.args),
        ...(str(o.url, 500) ? { url: str(o.url, 500) } : {}),
        envKeys: list(o.envKeys),
        headerKeys: list(o.headerKeys),
      };
    })
    .filter((t): t is ToolTemplate => !!t);
}

export function toolTemplatesFile(dataDir: string): string {
  return path.join(dataDir, 'org', 'tool-templates.json');
}

export function loadToolTemplates(file: string): Record<string, ToolTemplate> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return Object.fromEntries(parseTemplates(Object.values((raw ?? {}) as object)).map((t) => [t.name, t]));
  } catch {
    return {};
  }
}

export function rememberToolTemplates(file: string, templates: ToolTemplate[], onlyNew = false): void {
  const existing = loadToolTemplates(file);
  if (onlyNew) templates = templates.filter((t) => !(t.name in existing));
  if (!templates.length) return;
  const all = { ...existing, ...Object.fromEntries(templates.map((t) => [t.name, t])) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
