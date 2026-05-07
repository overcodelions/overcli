// Read and write MCP server configurations across CLIs.
//
// The `capabilities` scanner only learns the server *names* per CLI;
// this module is what's used when the UI offers to copy a server's full
// config from one CLI to another. Each CLI uses a different file format,
// so we read/write through a small structured intermediate
// (`McpServerConfig`) that covers the fields MCP servers actually use.
//
// Files touched:
//   ~/.claude/settings.json   →  mcpServers     (JSON)
//   ~/.gemini/settings.json   →  mcpServers     (JSON, same shape)
//   ~/.codex/config.toml      →  [mcp_servers.<name>]  (TOML)
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
import type { Backend } from '../shared/types';

export type McpScalar = string | number | boolean;
export type McpValue = McpScalar | McpScalar[] | Record<string, McpScalar>;
export type McpServerConfig = Record<string, McpValue>;

export type McpCli = Extract<Backend, 'claude' | 'codex' | 'gemini'>;

export function isMcpCli(cli: Backend): cli is McpCli {
  return cli === 'claude' || cli === 'codex' || cli === 'gemini';
}

interface Paths {
  claude: string;
  codex: string;
  gemini: string;
}

function defaultPaths(home: string = os.homedir()): Paths {
  return {
    claude: path.join(home, '.claude', 'settings.json'),
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
  return readJsonServer(paths[cli], name);
}

export function writeMcpServer(
  cli: McpCli,
  name: string,
  config: McpServerConfig,
  paths: Paths = defaultPaths(),
): void {
  if (cli === 'codex') return writeCodexServer(paths.codex, name, config);
  return writeJsonServer(paths[cli], name, config);
}

// ---------- JSON-based CLIs (Claude, Gemini) ----------

function readJsonServer(file: string, name: string): McpServerConfig | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as
    | { mcpServers?: Record<string, McpServerConfig> }
    | null;
  return parsed?.mcpServers?.[name] ?? null;
}

function writeJsonServer(file: string, name: string, config: McpServerConfig): void {
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
