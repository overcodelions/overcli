// Read and write MCP server configurations across CLIs.
//
// The `capabilities` scanner only learns the server *names* per CLI;
// this module is what's used when the UI offers to copy a server's full
// config from one CLI to another. Each CLI uses a different file format,
// so we read/write through a small structured intermediate
// (`McpServerConfig`) that covers the fields MCP servers actually use.
//
// Files touched:
//   ~/.claude.json            →  mcpServers     (JSON, user scope)
//   ~/.gemini/settings.json   →  mcpServers     (JSON, same shape)
//   ~/.codex/config.toml      →  [mcp_servers.<name>]  (TOML)
//
// NOTE: Claude Code reads user-scope MCP server *definitions* from
// ~/.claude.json (the file `claude mcp add --scope user` writes), NOT
// from ~/.claude/settings.json — settings.json only carries MCP toggles
// (enabledMcpjsonServers, etc.), so servers written there are silently
// ignored by the CLI.
//
// We intentionally don't pull in a full TOML library — the section we
// write is small and well-shaped, and we only mutate one section at a
// time, leaving the surrounding text alone.
//
// On every write we drop a `.bak` of the previous file contents next to
// the original so a manual rollback is one move.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ToolLaunch } from './org/toolEnvVault';
import { activeWorkerUser } from './org/workerUser';
import type { Backend } from '../shared/types';

export type McpScalar = string | number | boolean;
export type McpValue = McpScalar | McpScalar[] | Record<string, McpScalar>;
export type McpServerConfig = Record<string, McpValue>;

export type McpCli = Extract<Backend, 'claude' | 'codex' | 'gemini'>;

const claudeMcpFileCache = new Map<string, { mtimeMs: number; servers: Record<string, McpServerConfig> }>();

/// Where command tools' env is kept when the server seals it out of
/// ~/.claude.json (org/toolEnvVault.ts). Null: in the file, as written.
export interface ClaudeEnvVault {
  seal(name: string, env: Record<string, string>): void;
  envFor(name: string): Record<string, string> | undefined;
  has(name: string): boolean;
  forget(name: string): void;
  names(): string[];
  pin(name: string, launch: ToolLaunch): void;
  launchFor(name: string): ToolLaunch | undefined;
  pinsTaken(): boolean;
  markPinsTaken(): void;
}

let envVault: ClaudeEnvVault | null = null;

/// Seal command tools' env out of the Claude config from now on. Only the
/// server's own reads see it again; a CLI reading the file does not.
export function useClaudeEnvVault(v: ClaudeEnvVault | null): void {
  envVault = v;
}

function isUserClaudeFile(file: string, paths: Paths): boolean {
  return path.resolve(file) === path.resolve(paths.claude);
}

function stringEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

/// Whether ~/.claude.json is the server's alone to write. When workers run
/// as a user of their own (workerUser.ts) they can write it too, so the
/// server goes by what it pinned, not by the file.
function claudeFileTrusted(): boolean {
  return !activeWorkerUser();
}

function launchOf(config: McpServerConfig): ToolLaunch {
  return {
    command: String(config.command),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    ...(typeof config.cwd === 'string' && config.cwd ? { cwd: config.cwd } : {}),
  };
}

function sameLaunch(a: ToolLaunch | undefined, b: ToolLaunch): boolean {
  return !!a && a.command === b.command && (a.cwd ?? '') === (b.cwd ?? '') && a.args.length === b.args.length && a.args.every((v, i) => v === b.args[i]);
}

/// A command tool's entry as it goes in the file: its launch pinned, its env
/// sealed and left out.
function sealedEntry(name: string, config: McpServerConfig): McpServerConfig {
  if (!envVault || typeof config.command !== 'string') return config;
  envVault.pin(name, launchOf(config));
  const env = stringEnv(config.env);
  envVault.seal(name, env);
  if (!Object.keys(env).length) return config;
  const { env: _sealed, ...rest } = config;
  return rest;
}

/// A command tool's entry as the server sees it: with its sealed env back.
/// While the file is the server's alone, an env written there by hand (a
/// token rotated in place) is newer than the vault's and wins; the next
/// start seals it. Once workers can write the file, the server takes the
/// tool's launch and env from the vault only (pinnedClaudeTool).
function unsealedEntry(name: string, config: McpServerConfig): McpServerConfig {
  if (!envVault || typeof config.command !== 'string') return config;
  if (!claudeFileTrusted()) {
    const pinned = pinnedClaudeTool(name);
    if (!pinned) return config;
    const { env: _file, cwd: _cwd, ...rest } = config;
    return { ...rest, ...pinned };
  }
  const env = envVault.envFor(name);
  return env ? { ...config, env: { ...env, ...stringEnv(config.env) } } : config;
}

/// A command tool as the server last wrote it: its pinned command, args and
/// cwd, and its sealed env. Undefined when the server never wrote it, or no
/// vault is in use. The only form of a tool the relay may start while
/// workers can write the config (runner.ts).
export function pinnedClaudeTool(name: string): McpServerConfig | undefined {
  const launch = envVault?.launchFor(name);
  if (!launch) return undefined;
  const env = envVault!.envFor(name);
  return { command: launch.command, args: launch.args, ...(launch.cwd ? { cwd: launch.cwd } : {}), ...(env ? { env } : {}) };
}

/// Move every command tool's env in the Claude config into the vault, pin
/// its launch, and take the env out of the config's own backups (`<file>.*`
/// beside it). Returns the tools sealed this time.
///
/// The config is trusted for that while only the server writes it, and on
/// the first start with pins. After that, with workers able to write it, a
/// command tool whose entry no longer matches its pin (or carries an env
/// again) is left as the worker's own: the relay keeps starting the pinned
/// one, and `onIgnored` hears its name. A new tool, or a token rotated by
/// hand, has to be saved through the server instead.
export function sealClaudeStdioEnv(paths: Paths = defaultPaths(), onIgnored?: (names: string[]) => void): string[] {
  if (!envVault) return [];
  const sealed: string[] = [];
  const ignored: string[] = [];
  let parsed: { mcpServers?: Record<string, McpServerConfig> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.claude, 'utf-8') || '{}');
  } catch {
    return [];
  }
  const trustFile = claudeFileTrusted() || !envVault.pinsTaken();
  for (const [name, config] of Object.entries(parsed.mcpServers ?? {})) {
    if (typeof config.command !== 'string') continue;
    const hasEnv = Object.keys(stringEnv(config.env)).length > 0;
    if (!trustFile) {
      const pinned = envVault.launchFor(name);
      if (pinned && (hasEnv || !sameLaunch(pinned, launchOf(config)))) ignored.push(name);
      continue;
    }
    if (!hasEnv) {
      envVault.pin(name, launchOf(config));
      continue;
    }
    writeJsonServer(paths.claude, name, config, paths);
    sealed.push(name);
  }
  envVault.markPinsTaken();
  scrubClaudeBackups(paths);
  if (ignored.length) onIgnored?.(ignored);
  return sealed;
}

/// Older copies of the config beside it (`.claude.json.bak`, the CLI's
/// `.claude.json.backup.<n>`, any a person made) still hold tools' env. Drop
/// the env of every command tool in them; leave anything that isn't JSON.
function scrubClaudeBackups(paths: Paths): void {
  const dir = path.dirname(paths.claude);
  const base = path.basename(paths.claude);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`));
  } catch {
    return;
  }
  for (const n of names) {
    const file = path.join(dir, n);
    try {
      if (!fs.statSync(file).isFile()) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { mcpServers?: Record<string, McpServerConfig> };
      let changed = false;
      for (const config of Object.values(parsed.mcpServers ?? {})) {
        if (typeof config.command === 'string' && config.env !== undefined) {
          delete config.env;
          changed = true;
        }
      }
      if (changed) fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    } catch {
      // Not a JSON copy of the config; not ours to change.
    }
  }
}

/// The vault is off: put every sealed env back in the Claude config, so the
/// tools keep working without the server in between.
export function restoreClaudeStdioEnv(vault: ClaudeEnvVault, paths: Paths = defaultPaths()): string[] {
  const restored: string[] = [];
  let parsed: { mcpServers?: Record<string, McpServerConfig> };
  try {
    parsed = JSON.parse(fs.readFileSync(paths.claude, 'utf-8') || '{}');
  } catch {
    return [];
  }
  for (const name of vault.names()) {
    const config = parsed.mcpServers?.[name];
    const env = vault.envFor(name);
    if (!config || typeof config.command !== 'string' || !env) continue;
    writeJsonServer(paths.claude, name, { ...config, env: { ...stringEnv(config.env), ...env } }, paths);
    vault.forget(name);
    restored.push(name);
  }
  return restored;
}

/// The command tools among `servers` whose env is sealed: each one a run must
/// get through the relay, since the config's own entry has no credentials.
///
/// While workers can write the config, each is the tool as the server pinned
/// it, whatever the config or the project's `.mcp.json` now says under that
/// name; one with no pin is left out (the worker's CLI starts it, as the worker).
export function sealedClaudeTools(servers: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  if (!envVault) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(servers)) {
    if (!envVault.has(name)) continue;
    if (claudeFileTrusted()) {
      if (typeof c.command === 'string') out[name] = c;
      continue;
    }
    const pinned = pinnedClaudeTool(name);
    if (pinned) out[name] = pinned;
  }
  return out;
}

export function isMcpCli(cli: Backend): cli is McpCli {
  return cli === 'claude' || cli === 'codex' || cli === 'gemini';
}

export interface Paths {
  claude: string;
  codex: string;
  gemini: string;
}

function defaultPaths(home: string = os.homedir()): Paths {
  return {
    claude: path.join(home, '.claude.json'),
    codex: path.join(home, '.codex', 'config.toml'),
    gemini: path.join(home, '.gemini', 'settings.json'),
  };
}

export function readMcpServer(
  cli: McpCli,
  name: string,
  paths: Paths = defaultPaths(),
): McpServerConfig | null {
  if (cli === 'codex') return readCodexServer(paths.codex, name);
  const config = readJsonServer(paths[cli], name);
  return config && cli === 'claude' ? unsealedEntry(name, config) : config;
}

export function writeMcpServer(
  cli: McpCli,
  name: string,
  config: McpServerConfig,
  paths: Paths = defaultPaths(),
): void {
  if (cli === 'codex') return writeCodexServer(paths.codex, name, config);
  return writeJsonServer(paths[cli], name, config, paths);
}

export type AddMcpResult =
  | { ok: true; written: McpCli[]; errors: string[] }
  | { ok: false; error: string };

/// Validates input and fan-writes one MCP server entry to every valid
/// target CLI. Partial success returns `ok: true` with `errors[]`
/// listing the CLIs that failed; total failure returns `ok: false`.
export function addMcpServerToTargets(
  args: { name: string; config: unknown; targets: unknown[] },
  paths: Paths = defaultPaths(),
): AddMcpResult {
  if (typeof args.name !== 'string' || !args.name.trim()) {
    return { ok: false, error: 'Server name is required.' };
  }
  if (!args.config || typeof args.config !== 'object') {
    return { ok: false, error: 'Config must be a JSON object.' };
  }
  const valid = (args.targets ?? []).filter((t): t is McpCli => isMcpCli(t as Backend));
  if (valid.length === 0) {
    return { ok: false, error: 'Pick at least one MCP-capable CLI.' };
  }
  const written: McpCli[] = [];
  const errors: string[] = [];
  for (const cli of valid) {
    try {
      writeMcpServer(cli, args.name.trim(), args.config as McpServerConfig, paths);
      written.push(cli);
    } catch (err: any) {
      errors.push(`${cli}: ${err?.message ?? String(err)}`);
    }
  }
  if (written.length === 0) {
    return { ok: false, error: errors.join('; ') || 'No writes succeeded.' };
  }
  return { ok: true, written, errors };
}

export function removeMcpServer(
  cli: McpCli,
  name: string,
  paths: Paths = defaultPaths(),
): void {
  if (cli === 'codex') return removeCodexServer(paths.codex, name);
  return removeJsonServer(paths[cli], name, paths);
}

export type RemoveMcpResult =
  | { ok: true; removed: McpCli[]; errors: string[] }
  | { ok: false; error: string };

/// Validates input and fan-deletes one MCP server entry from every valid
/// target CLI. Mirrors `addMcpServerToTargets`. A CLI that doesn't have
/// the server is a no-op (not an error); only real write failures land in
/// `errors`.
export function removeMcpServerFromTargets(
  args: { name: string; targets: unknown[] },
  paths: Paths = defaultPaths(),
): RemoveMcpResult {
  if (typeof args.name !== 'string' || !args.name.trim()) {
    return { ok: false, error: 'Server name is required.' };
  }
  const valid = (args.targets ?? []).filter((t): t is McpCli => isMcpCli(t as Backend));
  if (valid.length === 0) {
    return { ok: false, error: 'Pick at least one MCP-capable CLI.' };
  }
  const removed: McpCli[] = [];
  const errors: string[] = [];
  for (const cli of valid) {
    try {
      removeMcpServer(cli, args.name.trim(), paths);
      removed.push(cli);
    } catch (err: any) {
      errors.push(`${cli}: ${err?.message ?? String(err)}`);
    }
  }
  if (removed.length === 0 && errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }
  return { ok: true, removed, errors };
}

// ---------- JSON-based CLIs (Claude, Gemini) ----------

function readJsonServer(file: string, name: string): McpServerConfig | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as
    | { mcpServers?: Record<string, McpServerConfig> }
    | null;
  return parsed?.mcpServers?.[name] ?? null;
}

function writeJsonServer(file: string, name: string, config: McpServerConfig, paths: Paths = defaultPaths()): void {
  if (isUserClaudeFile(file, paths)) config = sealedEntry(name, config);
  ensureDir(path.dirname(file));
  let parsed: { mcpServers?: Record<string, McpServerConfig> } & Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    backup(file);
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}');
  }
  const servers = parsed.mcpServers ?? {};
  servers[name] = config;
  parsed.mcpServers = servers;
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

function removeJsonServer(file: string, name: string, paths: Paths = defaultPaths()): void {
  if (envVault && isUserClaudeFile(file, paths)) envVault.forget(name);
  if (!fs.existsSync(file)) return;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}') as {
    mcpServers?: Record<string, McpServerConfig>;
  } & Record<string, unknown>;
  if (!parsed.mcpServers || !(name in parsed.mcpServers)) return;
  backup(file);
  delete parsed.mcpServers[name];
  fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
}

// ---------- Codex (TOML) ----------

function readCodexServer(file: string, name: string): McpServerConfig | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf-8');
  const main = extractTomlSection(text, `mcp_servers.${name}`);
  if (!main) return null;

  const config: McpServerConfig = {};
  for (const [key, value] of parseTomlPairs(main)) {
    config[key] = value;
  }

  // Subtables like `[mcp_servers.<name>.env]` show up as separate
  // top-level sections in the file.
  const envSection = extractTomlSection(text, `mcp_servers.${name}.env`);
  if (envSection) {
    const env: Record<string, McpScalar> = {};
    for (const [key, value] of parseTomlPairs(envSection)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        env[key] = value;
      }
    }
    if (Object.keys(env).length > 0) config.env = env;
  }

  return config;
}

function writeCodexServer(file: string, name: string, config: McpServerConfig): void {
  ensureDir(path.dirname(file));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  if (existing) backup(file);

  const header = `[mcp_servers.${name}]`;
  const body = formatTomlPairs(config);
  const block = body ? `${header}\n${body}\n` : `${header}\n`;

  // Strip any prior section (and its env subtable) to avoid duplicates.
  let next = removeTomlSection(existing, `mcp_servers.${name}`);
  next = removeTomlSection(next, `mcp_servers.${name}.env`);

  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  if (next.length > 0 && !next.endsWith('\n\n')) next += '\n';
  next += block;

  fs.writeFileSync(file, next, 'utf-8');
}

function removeCodexServer(file: string, name: string): void {
  if (!fs.existsSync(file)) return;
  const existing = fs.readFileSync(file, 'utf-8');
  let next = removeTomlSection(existing, `mcp_servers.${name}`);
  next = removeTomlSection(next, `mcp_servers.${name}.env`);
  if (next === existing) return;
  backup(file);
  fs.writeFileSync(file, next, 'utf-8');
}

// ---------- TOML helpers (just enough for MCP server blocks) ----------

/// Return the body lines of `[<header>]` (everything until the next
/// top-level `[section]` line or EOF), or null if the section is absent.
export function extractTomlSection(text: string, header: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => isSectionHeader(l, header));
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

/// Remove `[<header>]` and its body from the file text. No-op if absent.
export function removeTomlSection(text: string, header: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => isSectionHeader(l, header));
  if (start === -1) return text;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  // Drop the trailing blank line that usually separates sections so we
  // don't accumulate empty lines on repeated rewrites.
  while (end < lines.length && lines[end].trim() === '') end++;
  lines.splice(start, end - start);
  return lines.join('\n');
}

function isSectionHeader(line: string, header: string): boolean {
  const m = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
  return !!m && m[1] === header;
}

/// Parse `key = value` lines into [key, parsedValue] pairs. Supports
/// quoted strings, integers, booleans, arrays of those, and inline
/// tables `{ K = "v", ... }`.
export function parseTomlPairs(body: string): Array<[string, McpValue]> {
  const out: Array<[string, McpValue]> = [];
  // Join continuations: arrays/tables can span multiple lines.
  const text = body.replace(/^\s*#.*$/gm, '').trim();
  if (!text) return out;

  let i = 0;
  while (i < text.length) {
    // Skip whitespace and blank lines.
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length) break;

    // Read key.
    const keyMatch = /^([A-Za-z0-9_\-"]+)\s*=\s*/.exec(text.slice(i));
    if (!keyMatch) {
      // Skip unrecognized line.
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    const key = keyMatch[1].replace(/^"|"$/g, '');
    i += keyMatch[0].length;

    const { value, next } = readTomlValue(text, i);
    out.push([key, value]);
    i = next;
  }
  return out;
}

function readTomlValue(text: string, start: number): { value: McpValue; next: number } {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  const ch = text[i];

  if (ch === '"') {
    const { value, next } = readQuotedString(text, i);
    return { value, next: skipToLineEnd(text, next) };
  }
  if (ch === '[') {
    const { value, next } = readArray(text, i);
    return { value, next: skipToLineEnd(text, next) };
  }
  if (ch === '{') {
    const { value, next } = readInlineTable(text, i);
    return { value, next: skipToLineEnd(text, next) };
  }

  // Bare token — number or boolean — read until end of line.
  const lineEnd = text.indexOf('\n', i);
  const raw = (lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd)).trim();
  return { value: parseScalar(raw), next: lineEnd === -1 ? text.length : lineEnd + 1 };
}

function readQuotedString(text: string, start: number): { value: string; next: number } {
  let i = start + 1;
  let out = '';
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\' && i + 1 < text.length) {
      const esc = text[i + 1];
      out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc;
      i += 2;
      continue;
    }
    out += text[i];
    i++;
  }
  return { value: out, next: i + 1 };
}

function readArray(text: string, start: number): { value: McpScalar[]; next: number } {
  let i = start + 1;
  const out: McpScalar[] = [];
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === ']') return { value: out, next: i + 1 };
    if (text[i] === '"') {
      const { value, next } = readQuotedString(text, i);
      out.push(value);
      i = next;
      continue;
    }
    // Bare scalar inside an array.
    const stop = nextDelim(text, i, ',]');
    out.push(parseScalar(text.slice(i, stop).trim()));
    i = stop;
  }
  return { value: out, next: i };
}

function readInlineTable(text: string, start: number): { value: Record<string, McpScalar>; next: number } {
  let i = start + 1;
  const out: Record<string, McpScalar> = {};
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === '}') return { value: out, next: i + 1 };
    const keyMatch = /^([A-Za-z0-9_\-"]+)\s*=\s*/.exec(text.slice(i));
    if (!keyMatch) break;
    const key = keyMatch[1].replace(/^"|"$/g, '');
    i += keyMatch[0].length;
    if (text[i] === '"') {
      const { value, next } = readQuotedString(text, i);
      out[key] = value;
      i = next;
    } else {
      const stop = nextDelim(text, i, ',}');
      out[key] = parseScalar(text.slice(i, stop).trim()) as McpScalar;
      i = stop;
    }
  }
  return { value: out, next: i };
}

function nextDelim(text: string, start: number, delims: string): number {
  let i = start;
  while (i < text.length && !delims.includes(text[i])) i++;
  return i;
}

function skipToLineEnd(text: string, i: number): number {
  while (i < text.length && text[i] !== '\n') i++;
  return Math.min(i + 1, text.length);
}

function parseScalar(raw: string): McpScalar {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/// Format a config object back to a TOML body (the lines that go *under*
/// `[mcp_servers.<name>]`). Inline tables for record-shaped values keep
/// the section self-contained.
export function formatTomlPairs(config: McpServerConfig): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    lines.push(`${key} = ${formatTomlValue(value)}`);
  }
  return lines.join('\n');
}

function formatTomlValue(value: McpValue): string {
  if (typeof value === 'string') return tomlString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => (typeof v === 'string' ? tomlString(v) : String(v))).join(', ')}]`;
  }
  const entries = Object.entries(value).map(
    ([k, v]) => `${k} = ${typeof v === 'string' ? tomlString(v) : String(v)}`,
  );
  return `{ ${entries.join(', ')} }`;
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

// ---------- Filesystem helpers ----------

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function backup(file: string): void {
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch {
    // Best-effort. If the source is unreadable, the next write would have
    // failed anyway and the user will see the error from that.
  }
}

// ---------- Per-turn allowlists ----------

/// Every MCP server the Claude CLI would boot for a turn, by name.
///
/// Read from the same user-scope file `readMcpServer` writes, plus the
/// project-scoped `.mcp.json` a repo may carry — between them that is what
/// `claude -p` loads when nothing narrows it.
export function readClaudeMcpServers(
  projectPath?: string,
  paths: Paths = defaultPaths(),
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const file of [paths.claude, projectPath ? path.join(projectPath, '.mcp.json') : null]) {
    if (!file) continue;
    try {
      const absolute = path.resolve(file);
      const mtimeMs = fs.statSync(absolute).mtimeMs;
      let cached = claudeMcpFileCache.get(absolute);
      if (!cached || cached.mtimeMs !== mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(absolute, 'utf-8')) as {
          mcpServers?: Record<string, McpServerConfig>;
        };
        cached = { mtimeMs, servers: parsed?.mcpServers ?? {} };
        claudeMcpFileCache.set(absolute, cached);
      }
      if (isUserClaudeFile(file, paths)) {
        for (const [name, config] of Object.entries(cached.servers)) out[name] = unsealedEntry(name, config);
      } else {
        Object.assign(out, cached.servers);
      }
    } catch {
      if (file) claudeMcpFileCache.delete(path.resolve(file));
      // A hand-broken config is the CLI's problem to report, not ours to
      // crash on — an unreadable file simply contributes no servers.
    }
  }
  return out;
}

/// Narrow a server map to `names`, ignoring any that aren't configured.
///
/// Pure so the allowlist rule is testable without a filesystem. A name that
/// matches nothing is dropped silently rather than failing the turn: a worker
/// pinned to a server the user later removed should still work, just without
/// it, and the alternative is a whole class of shifts dying on stale config.
export function filterMcpServers(
  all: Record<string, McpServerConfig>,
  names: string[],
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const name of names) {
    const cfg = all[name.trim()];
    if (cfg) out[name.trim()] = cfg;
  }
  return out;
}

/// The value to hand `claude --mcp-config` so a turn loads only `names`.
///
/// Inline JSON rather than a temp file: there is no lifecycle to get wrong
/// (no unlink racing a respawn, the way the permission broker's config does),
/// and the payload is a handful of server definitions. Returns null when the
/// allowlist resolves to nothing — the caller pairs that with
/// `--strict-mcp-config` alone, which loads zero servers.
export function buildClaudeMcpConfigArg(
  names: string[],
  projectPath?: string,
  paths: Paths = defaultPaths(),
): string | null {
  const picked = filterMcpServers(readClaudeMcpServers(projectPath, paths), names);
  if (Object.keys(picked).length === 0) return null;
  return JSON.stringify({ mcpServers: picked });
}

/// Every server NOT on the list, as `mcp__<name>` tool prefixes for `--disallowedTools`.
/// Used when a list names an account connector and strict mode can't be used.
///
/// Config files alone miss most of what a session can load, so the list is
/// built from everywhere a server can come from: the user config, the
/// project's `.mcp.json`, the project's local-scope entry in `~/.claude.json`,
/// and `seen` — every server Claude has reported, which is the only place
/// plugin servers and the other account connectors show up.
export function blockedMcpServerTools(
  names: string[],
  projectPath?: string,
  paths: Paths = defaultPaths(),
  seen: readonly string[] = [],
): string[] {
  const keep = new Set(names.map((n) => n.trim()));
  const all = new Set([
    ...Object.keys(readClaudeMcpServers(projectPath, paths)),
    ...localScopeMcpServerNames(projectPath, paths),
    ...seen,
  ]);
  const out = new Set<string>();
  for (const n of all) if (!keep.has(n)) out.add(`mcp__${n.replace(/[^A-Za-z0-9_-]/g, '_')}`);
  return [...out].sort();
}

/// Servers added with `claude mcp add --scope local`: kept in `~/.claude.json`
/// under the project's path, not at the top level or in `.mcp.json`.
function localScopeMcpServerNames(projectPath: string | undefined, paths: Paths): string[] {
  if (!projectPath) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.claude, 'utf-8')) as {
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    return Object.keys(parsed?.projects?.[path.resolve(projectPath)]?.mcpServers ?? {});
  } catch {
    return [];
  }
}
