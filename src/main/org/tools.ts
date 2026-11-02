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

import { warmNpxTools } from './npxWarm';
import { log } from '../diagnostics';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readClaudeMcpServers, removeMcpServer, writeMcpServer, type McpServerConfig } from '../mcpConfig';
import { holdsAddressCredential, isSecretFlagValue, isSecretName } from '../../shared/machineValues';

export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface ToolSummary {
  name: string;
  kind: 'command' | 'http';
  /// The command and its arguments, or the URL. Never a secret.
  target: string;
  /// A command tool's command and arguments apart, for editing them.
  command?: string;
  args?: string[];
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

/// Where remote tools' real addresses and headers live when the server keeps
/// them out of the CLIs' config (toolGateway.ts). Absent: in the config.
export interface RemoteToolVault {
  wrap(name: string, url: string, headers: Record<string, string>): McpServerConfig;
  forget(name: string): void;
  real(name: string): { url: string; headerNames: string[] } | undefined;
}

let vault: RemoteToolVault | null = null;

export function useRemoteToolVault(v: RemoteToolVault | null): void {
  vault = v;
}

/// The address a tool is installed with, the real one when it is vaulted.
export function installedToolUrl(name: string): string | undefined {
  const real = vault?.real(name);
  if (real) return real.url;
  const c = readClaudeMcpServers()[name];
  return typeof c?.url === 'string' ? c.url : undefined;
}

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
      const real = vault?.real(name);
      const env = c.env && typeof c.env === 'object' && !Array.isArray(c.env) ? Object.keys(c.env) : [];
      const headers = real ? real.headerNames : c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers) ? Object.keys(c.headers) : [];
      return {
        name,
        kind: http ? 'http' : 'command',
        target: real ? real.url : http ? String(c.url) : [String(c.command ?? ''), ...(Array.isArray(c.args) ? c.args.map(String) : [])].join(' ').trim(),
        ...(http ? {} : { command: String(c.command ?? ''), args: Array.isArray(c.args) ? c.args.map(String) : [] }),
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

/// A setting that holds an address (`JIRA_URL`, `API_ENDPOINT`): one given
/// without its scheme (`acme.example.net`) makes every request fail before it
/// leaves, so it gets `https://`. Returns the settings, and which were fixed.
export function fixAddresses(env: Record<string, string>): { env: Record<string, string>; fixed: string[] } {
  const fixed: string[] = [];
  const out = Object.fromEntries(
    Object.entries(env).map(([k, v]) => {
      const value = v.trim();
      if (!/(^|_)(URL|URI|ENDPOINT|BASE_URL|HOST_URL)$/i.test(k) || !value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /\s/.test(value) || !value.includes('.')) return [k, v];
      fixed.push(k);
      return [k, `https://${value}`];
    }),
  );
  return { env: out, fixed };
}

export function installTool(input: ToolInput): { ok: true; fixed?: string[] } | { ok: false; error: string } {
  const name = input.name?.trim() ?? '';
  if (!TOOL_NAME.test(name)) return { ok: false, error: 'A name is letters, numbers, dashes or underscores, and must match what workers list (e.g. jira).' };
  const clean = (o?: Record<string, string>) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k.trim()) && typeof v === 'string').map(([k, v]) => [k.trim(), v]));
  let config: McpServerConfig;
  let fixed: string[] = [];
  if (input.kind === 'http') {
    let url: URL;
    try {
      url = new URL(input.url ?? '');
    } catch {
      return { ok: false, error: 'That is not a web address.' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Use an https:// address.' };
    const headers = clean(input.headers);
    try {
      config = vault ? vault.wrap(name, url.toString(), headers) : { type: 'http', url: url.toString(), ...(Object.keys(headers).length ? { headers } : {}) };
    } catch (err) {
      return { ok: false, error: `Could not keep the tool's sign-in safe: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    const command = input.command?.trim() ?? '';
    if (!command) return { ok: false, error: 'Say what command starts it, e.g. npx.' };
    const { env, fixed: addressed } = fixAddresses(clean(input.env));
    fixed = addressed;
    config = { command, args: (input.args ?? []).map(String).filter((a) => a.length), ...(Object.keys(env).length ? { env } : {}) };
  }
  try {
    writeMcpServer('claude', name, config);
    // Codex takes command servers the same way; its remote ones are set up
    // differently, so those stay Claude's.
    if (codexInstalled() && input.kind !== 'http') writeMcpServer('codex', name, config);
    // Installed now, with time to spare, rather than inside its first check.
    if (typeof config.command === 'string') {
      void warmNpxTools({ [name]: { command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [] } }, (level, msg) => log(level, 'org.tools', msg));
    }
  } catch (err) {
    return { ok: false, error: `Could not write the config: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, ...(fixed.length ? { fixed } : {}) };
}

/// Change some of an installed tool's settings, keeping the rest and who has
/// it: a fixed address, a new token. A blank value leaves that one as it was.
/// Only a command tool's settings: a remote one signs in again instead.
export function updateToolSettings(name: string, values: Record<string, string>): { ok: true; changed: string[]; fixed?: string[] } | { ok: false; error: string } {
  const current = readClaudeMcpServers()[name];
  if (!TOOL_NAME.test(name) || !current) return { ok: false, error: 'No tool by that name.' };
  if (typeof current.url === 'string') return { ok: false, error: 'A remote tool’s keys change by signing in again, or removing it and adding it back.' };
  const env = current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? { ...(current.env as Record<string, string>) } : {};
  const given = Object.fromEntries(Object.entries(values).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k) && typeof v === 'string' && v.trim()));
  const unknown = Object.keys(given).filter((k) => !(k in env));
  if (unknown.length) return { ok: false, error: `${name} has no setting called ${unknown.join(', ')}.` };
  if (!Object.keys(given).length) return { ok: false, error: 'Type a new value for at least one setting.' };
  const { env: next, fixed } = fixAddresses({ ...env, ...given });
  const config: McpServerConfig = { ...current, env: next };
  try {
    writeMcpServer('claude', name, config);
    if (codexInstalled()) writeMcpServer('codex', name, config);
  } catch (err) {
    return { ok: false, error: `Could not write the config: ${err instanceof Error ? err.message : String(err)}` };
  }
  const touched = fixed.filter((k) => k in given);
  return { ok: true, changed: Object.keys(given), ...(touched.length ? { fixed: touched } : {}) };
}

/// A command tool changed as a whole: its command, arguments and settings,
/// keeping who has it. `env` lists every setting it keeps; a blank value
/// keeps that one's current value (secrets never go to the browser), and a
/// setting left out is dropped. Saved the way an install is, so the server's
/// pin and seal follow it (toolEnvVault.ts).
export function editTool(name: string, input: { command: string; args: string[]; env: Record<string, string> }): { ok: true; changed: string[]; fixed?: string[] } | { ok: false; error: string } {
  const current = readClaudeMcpServers()[name];
  if (!TOOL_NAME.test(name) || !current) return { ok: false, error: 'No tool by that name.' };
  if (typeof current.command !== 'string') return { ok: false, error: 'Only a command tool is edited here. A remote one signs in again, or is removed and added back.' };
  const command = input.command.trim();
  if (!command) return { ok: false, error: 'Say what command starts it, e.g. npx.' };
  const before = current.env && typeof current.env === 'object' && !Array.isArray(current.env) ? (current.env as Record<string, string>) : {};
  const bad = Object.keys(input.env).filter((k) => !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k.trim()));
  if (bad.length) return { ok: false, error: `${bad.join(', ')} isn't a setting name: letters, numbers and underscores.` };
  const empty = Object.entries(input.env).filter(([k, v]) => !v.trim() && !(k.trim() in before)).map(([k]) => k.trim());
  if (empty.length) return { ok: false, error: `Give ${empty.join(', ')} a value: it's new.` };
  const merged = Object.fromEntries(Object.entries(input.env).map(([k, v]) => [k.trim(), v.trim() ? v : before[k.trim()]]));
  const { env, fixed } = fixAddresses(merged);
  const args = input.args.map(String).filter((a) => a.length);
  const config: McpServerConfig = { ...current, command, args, ...(Object.keys(env).length ? { env } : {}) };
  if (!Object.keys(env).length) delete config.env;
  const oldArgs = Array.isArray(current.args) ? current.args.map(String) : [];
  const changed = [
    ...(command !== current.command || args.join('\u0000') !== oldArgs.join('\u0000') ? ['command'] : []),
    ...Object.keys(env).filter((k) => env[k] !== before[k]),
    ...Object.keys(before).filter((k) => !(k in env)),
  ];
  if (!changed.length) return { ok: false, error: 'Nothing changed.' };
  try {
    writeMcpServer('claude', name, config);
    if (codexInstalled()) writeMcpServer('codex', name, config);
    void warmNpxTools({ [name]: { command, args } }, (level, msg) => log(level, 'org.tools', msg));
  } catch (err) {
    return { ok: false, error: `Could not write the config: ${err instanceof Error ? err.message : String(err)}` };
  }
  const touched = fixed.filter((k) => input.env[k]?.trim());
  return { ok: true, changed, ...(touched.length ? { fixed: touched } : {}) };
}

export function uninstallTool(name: string): { ok: true } | { ok: false; error: string } {
  if (!TOOL_NAME.test(name)) return { ok: false, error: 'No tool by that name.' };
  try {
    removeMcpServer('claude', name);
    if (codexInstalled()) removeMcpServer('codex', name);
    vault?.forget(name);
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

/// A run of letters, digits, `-` and `_` that reads as a token: long, with a
/// digit in it (or very long). "mcp", "v1" and "sse" are not; "a8f3…" and a
/// signed key are.
const TOKEN_RUN = /^(?=.*\d)[A-Za-z0-9_-]{16,}$|^[A-Za-z0-9_.-]{32,}$/;
/// Base64, standard or url-safe, long enough to be a key.
const BASE64 = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
/// One part of a name: a word, a version or a short number, with at most one
/// run of digits (`acme`, `v2`, `server2`, `2024`, `oauth2`). A token's
/// letters and digits alternate (`a8f3`), so it never reads as one.
const WORD = /^(?=.{1,20}$)[A-Za-z]*\d{0,4}[A-Za-z]*$/;

/// Whether every `-`, `_` or `.`-separated part of a value is a word.
function wordy(value: string): boolean {
  return value.split(/[-_.]+/).every((part) => part === '' || WORD.test(part));
}

/// A package name, scoped or not, with an optional version: `acme-crm-mcp`,
/// `acme-crm-mcp-server-v2`, `@acme/jira-mcp@1.2.0`. Made of words, so long
/// is not a reason to drop it.
function packageNamed(value: string): boolean {
  const m = /^(?:@([\w.-]+)\/)?([\w.-]+?)(?:@[\w.^~<>=*-]+)?$/.exec(value);
  return !!m && (m[1] === undefined || wordy(m[1])) && wordy(m[2]);
}

/// Whether a value reads as a token: a long run with digits in it, base64,
/// or a path one of whose segments, or a run of adjacent ones, is. A package
/// name or an ordinary path of words is not.
function tokenShaped(value: string): boolean {
  if (packageNamed(value)) return false;
  if (TOKEN_RUN.test(value)) return true;
  // Base64: `+`, `/` and `=` are what give it away, but a path has `/` too,
  // so mixed case and digits only count where it is not one.
  if (BASE64.test(value) && (/[+]|=$/.test(value) || (/\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && !/^[./~]/.test(value)))) return true;
  return value.includes('/') && pathHoldsToken(value);
}

/// A token split over a path (`/s/a8f3k2m9x1/q7w4e6r5t0/sse`): each segment
/// is too short to tell, the run of non-words together is not.
function pathHoldsToken(path: string): boolean {
  let run = '';
  for (const segment of path.split('/')) {
    if (segment === '' || wordy(segment)) {
      run = '';
      continue;
    }
    if (tokenShaped(segment)) return true;
    run += segment;
    if (run.length >= 12 && /[\d+=]/.test(run)) return true;
  }
  return false;
}
/// An address: `scheme://…`.
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;
/// A flag whose value is the next argument: `--token`, `-p`.
const FLAG = /^-{1,2}[A-Za-z_][\w.-]*$/;
/// `--db.password=hunter2`, `-Dapi.key=…`, `TOKEN=…`: a name and its value.
const KEY_VALUE_ARG = /^(-{0,2}[A-Za-z_][\w.-]*)=([\s\S]*)$/;
/// A header given as one argument (`--header "Authorization: Bearer …"`).
const HEADER_ARG = /^([A-Za-z][A-Za-z0-9-]*)\s*:\s*([\s\S]*)$/;
/// A word that says a value is a credential, wherever it sits in it.
const SECRET_WORD = /authorization|bearer|token|api[-_]?key|secret|passw(?:or)?d|credential/i;
/// Longest argument exported as it is, unless it is an address: a token or
/// a signed key is longer, a package name or a flag is not.
const ARG_MAX = 80;

/// Whether an address can be exported as it is: no user:password, no
/// query string, no token-shaped path segment (`/s/<secret>/sse`). A
/// malformed address is not exportable either.
function addressExportable(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return false;
    return !pathHoldsToken(u.pathname);
  } catch {
    return false;
  }
}

/// A command's arguments with every possible credential taken out, for a
/// template: package names, flags and plain paths stay. Dropped: an address
/// with a user:password, a query string, a fragment or a token-shaped path
/// (`postgresql://app:pw@db/prod`), and a `user:pw@host` without a scheme;
/// a `name=value` whose name is secret-shaped or whose value is
/// token-shaped; a token-shaped or base64 argument; the argument after a
/// secret-named flag or a `-p` that is not a port (`--token <value>`, the
/// flag itself stays so the install form shows where the value goes); a header
/// whose name or value is credential-shaped (`Authorization: Bearer …`);
/// any value with a credential word in it; and anything over 80 characters
/// that isn't an address.
export function exportableArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  const out: string[] = [];
  let flag = '';
  for (const raw of args.map(String)) {
    const before = flag;
    flag = '';
    if (before && !FLAG.test(raw) && isSecretFlagValue(before, raw)) continue;
    if (tokenShaped(raw)) continue;
    if (ADDRESS.test(raw)) {
      if (raw.length > 500 || !addressExportable(raw)) continue;
    } else {
      if (raw.length > ARG_MAX || holdsAddressCredential(raw)) continue;
      const kv = KEY_VALUE_ARG.exec(raw);
      const header = kv ? null : HEADER_ARG.exec(raw);
      if (kv) {
        if (isSecretName(kv[1]) || SECRET_WORD.test(kv[2]) || tokenShaped(kv[2]) || (ADDRESS.test(kv[2]) && !addressExportable(kv[2]))) continue;
      } else if (header) {
        if (isSecretName(header[1]) || SECRET_WORD.test(header[1]) || SECRET_WORD.test(header[2]) || header[2].split(/\s+/).some((part) => tokenShaped(part))) continue;
      } else if (FLAG.test(raw)) {
        flag = raw;
      } else if (SECRET_WORD.test(raw)) {
        continue;
      }
    }
    out.push(raw);
  }
  return out;
}

/// Strip a desktop MCP config down to a template. Values go; names stay.
export function templateFrom(name: string, config: McpServerConfig): ToolTemplate | null {
  if (!TOOL_NAME.test(name)) return null;
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as object).slice(0, 30) : []);
  if (typeof config.url === 'string') {
    // A URL can carry a key in its query string, its user:password or a
    // path segment (`/s/<secret>/sse`): keep where it points, and only
    // the path when nothing in it reads as a token.
    let url: string;
    try {
      const u = new URL(config.url);
      url = u.username || u.password || pathHoldsToken(u.pathname) ? u.origin : `${u.origin}${u.pathname}`;
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
    // Arguments are where a careless config hides a token: a connection
    // string with its password, `--token <value>`, `key=value`.
    args: exportableArgs(config.args),
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
