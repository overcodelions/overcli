// What MCP servers and tools the user's Claude actually has, as last seen.
//
// Config files only tell part of the story: account-level connectors (a
// Gmail, Calendar or Slack connector on the user's Claude account) live on
// the account, not on disk, so the capability scan cannot see them. Claude
// can — every session starts with an init event listing each server it
// loaded and every tool on it. This keeps a running record of those, so the
// hire drafter can name a connector as real rather than unconfirmed, and the
// flow designer can grant a step the exact tool it has to call.
//
// Merged, never replaced: a turn run with a narrowed server list reports
// fewer servers, and that is not the user disconnecting the rest. Entries
// age out instead, once nothing has reported them for a while.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import type { MainToRendererEvent } from '../../shared/types';

const FILE = 'mcp-seen.json';
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

interface Seen {
  servers: Record<string, number>;
  tools: Record<string, number>;
}

let cache: Seen | null = null;
let fileOverride: string | null = null;

/// Tests point the cache at a scratch file and reset it between cases.
export function setMcpSeenFileForTests(file: string | null): void {
  fileOverride = file;
  cache = null;
}

function filePath(): string {
  return fileOverride ?? path.join(host().dataDir(), FILE);
}

function load(): Seen {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf-8')) as Partial<Seen>;
    cache = { servers: parsed.servers ?? {}, tools: parsed.tools ?? {} };
  } catch {
    cache = { servers: {}, tools: {} };
  }
  return cache;
}

/// Record the servers and MCP tools one Claude session reported. Writes only
/// when something is new, so the steady state — every turn reporting the same
/// set — costs a comparison, not a disk write.
export function recordMcpSeen(
  servers: Array<{ name: string; status: string }>,
  tools: string[],
  now = Date.now(),
): void {
  const seen = load();
  let changed = false;
  const touch = (bucket: Record<string, number>, key: string) => {
    // Refreshing a stale timestamp once a day is enough to keep it alive.
    if (!bucket[key] || now - bucket[key] > 24 * 60 * 60 * 1000) changed = true;
    bucket[key] = now;
  };
  for (const s of servers) if (s.name && s.status === 'connected') touch(seen.servers, s.name);
  for (const t of tools) if (t.startsWith('mcp__')) touch(seen.tools, t);
  if (!changed) return;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(seen));
  } catch (err) {
    log('warn', 'mcp.seen', 'could not persist the MCP servers Claude reported', err);
  }
}

/// Tap for the main event stream: records whatever a Claude session's init
/// event reports. Every other event is ignored.
///
/// This sits on the path of EVERY event on its way to the renderer, so it
/// must never throw: a malformed init from some backend is skipped, not
/// allowed to take the chat down with it.
export function recordMcpSeenFromEvent(event: MainToRendererEvent): void {
  if (event.type !== 'stream') return;
  try {
    for (const ev of event.events) {
      if (ev.kind.type !== 'systemInit') continue;
      const tools = Array.isArray(ev.kind.info.tools) ? ev.kind.info.tools : [];
      const servers = Array.isArray(ev.kind.info.mcpServers) ? ev.kind.info.mcpServers : [];
      if (tools.length > 0) recordMcpSeen(servers, tools);
    }
  } catch (err) {
    log('warn', 'mcp.seen', 'skipped an init event it could not read', err);
  }
}

function fresh(bucket: Record<string, number>, now: number): string[] {
  return Object.entries(bucket)
    .filter(([, at]) => now - at < STALE_MS)
    .map(([k]) => k)
    .sort((a, b) => a.localeCompare(b));
}

/// Servers Claude has reported connected recently, by name — including the
/// account connectors ("claude.ai Gmail") no config file mentions.
export function seenMcpServers(now = Date.now()): string[] {
  return fresh(load().servers, now);
}

/// Every `mcp__<server>__<tool>` Claude has reported recently.
export function seenMcpTools(now = Date.now()): string[] {
  return fresh(load().tools, now);
}
