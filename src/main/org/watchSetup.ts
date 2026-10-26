// "Let me know when ACME-412 changes" with no change watch to put it on: a
// worker that can reach the tracker looks the ticket up once and says the
// exact call it used. That call, with the ticket swapped for `{{ids}}`, is
// the watch; where the list, the id and the status sit is read off a real
// answer here rather than trusted to the worker's guess.

import { parseMcpToolName } from '../../shared/flows/mcpTools';
import { mcpServerKey } from '../../shared/flows/toolScope';
import { at } from './mcpDirect';

/// What the worker is asked: look it up, then say the call as JSON.
export function setupPrompt(ticket: string, servers: string[] = []): string {
  return [
    `Look up ${ticket} with your issue tracker tool, the one that searches issues by a query (in Jira, a JQL search).`,
    servers.length ? `Use a tool from ${servers.map((s) => `mcp__${mcpServerKey(s)}__…`).join(' or ')}: the watch can only call those.` : '',
    `Search for it by key, e.g. JQL \`key in (${ticket})\`, and include its status in what you ask for.`,
    'Then reply with ONLY this JSON, no prose and no code fence, describing the one call that found it:',
    '{"tool": "<the full tool name you called, e.g. mcp__tracker__search>", "args": { <the exact arguments you passed> }}',
    'Start no other work and propose nothing. If no tool of yours can look it up, reply {"tool": null}.',
  ].filter(Boolean).join('\n');
}

/// The call the worker said it made, matched to a tool installed here.
/// `installed`: tool names as configured; a name the worker saw is their key.
export function readToolCall(reply: string, installed: string[]): { server: string; tool: string; args: Record<string, unknown> } | null {
  const parsed = toolJson(reply);
  if (!parsed || typeof parsed.tool !== 'string' || !parsed.tool) return null;
  const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? (parsed.args as Record<string, unknown>) : {};
  const full = parseMcpToolName(parsed.tool);
  const key = full?.server ?? (typeof parsed.server === 'string' ? mcpServerKey(parsed.server) : null);
  const tool = full?.tool ?? parsed.tool;
  if (!key) return null;
  const server = installed.find((n) => mcpServerKey(n) === key) ?? key;
  return { server, tool, args };
}

/// The first `{"tool": …}` object in text that may have prose and other
/// JSON around it: from each `{"tool"`, the balanced object that starts there.
function toolJson(text: string): { tool?: unknown; server?: unknown; args?: unknown } | null {
  for (const m of text.matchAll(/\{\s*"tool"\s*:/g)) {
    let depth = 0;
    let str = false;
    for (let i = m.index!; i < text.length; i++) {
      const c = text[i];
      if (str) {
        if (c === '\\') i++;
        else if (c === '"') str = false;
      } else if (c === '"') str = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try {
          return JSON.parse(text.slice(m.index!, i + 1)) as { tool?: unknown };
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

/// The arguments with the ticket swapped for `{{ids}}`, so the same call
/// asks about every tracked one: `key = ACME-1` becomes `key in ({{ids}})`.
export function generalize(args: Record<string, unknown>, ticket: string): { args: Record<string, unknown>; found: boolean } {
  const esc = ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let found = false;
  const swap = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (!new RegExp(esc, 'i').test(v)) return v;
      found = true;
      return v
        .replace(new RegExp(`\\b(issue)?key\\s*=\\s*"?${esc}"?`, 'gi'), (_m, issue: string | undefined) => `${issue ?? ''}key in ({{ids}})`)
        .replace(new RegExp(`\\(\\s*"?${esc}"?\\s*\\)`, 'gi'), '({{ids}})')
        .replace(new RegExp(esc, 'gi'), '{{ids}}');
    }
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  return { args: swap(args) as Record<string, unknown>, found };
}

/// Where in a real answer the list is, what in each item is the ticket's
/// key, and which field is its status. Null when the ticket isn't in it.
export function readShape(json: unknown, ticket: string): { itemsPath: string; idPath: string; statusPath: string; status: string } | null {
  const want = ticket.toUpperCase();
  const lists: Array<{ path: string; list: unknown[] }> = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      lists.push({ path, list: v });
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(json, '', 0);
  for (const { path, list } of lists) {
    for (const item of list) {
      const idPath = pathTo(item, (x) => typeof x === 'string' && x.toUpperCase() === want, 2);
      if (idPath === null) continue;
      const statusPath = ['fields.status.name', 'status.name', 'fields.status', 'status', 'state.name', 'state'].find((p) => typeof at(item, p) === 'string')
        ?? pathTo(item, (x, k) => typeof x === 'string' && /status|state/i.test(k), 3);
      if (!statusPath) return null;
      return { itemsPath: path, idPath, statusPath, status: String(at(item, statusPath)) };
    }
  }
  return null;
}

/// The first path, `depth` deep at most, to a value `hit` accepts.
function pathTo(v: unknown, hit: (x: unknown, key: string) => boolean, depth: number, path = ''): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || depth < 0) return null;
  for (const [k, x] of Object.entries(v)) if (hit(x, k)) return path ? `${path}.${k}` : k;
  for (const [k, x] of Object.entries(v)) {
    const deeper = pathTo(x, hit, depth - 1, path ? `${path}.${k}` : k);
    if (deeper) return deeper;
  }
  return null;
}
