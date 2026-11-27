// What a worker run changed outside the server, in words a person reads.
// Each call of a tool that doesn't only read, once it came back without an
// error, is said as a kind (a comment, a status move, fields set…), what it
// was on (ACME-7311, acme-web#88, a channel) and a short detail. Judged by
// the tool's name and its arguments alone, so it works for any tracker, code
// host or chat tool, the generic "execute" and "post" tools included: their
// operation is in the arguments, not the name.

import { parseMcpToolName } from './mcpTools';

export type RunChangeKind = 'comment' | 'status' | 'fields' | 'created' | 'removed' | 'message' | 'pullRequest' | 'other';

export interface RunChange {
  kind: RunChangeKind;
  /// The tool's server: atlassian, bitbucket, slack.
  server: string;
  /// What it was on: a ticket key, repo#n, a channel. Absent when the call names none.
  target?: string;
  /// A few words more: the status it moved to, the fields it set, how a comment starts.
  detail?: string;
  at: number;
}

const GENERIC = /^(execute(read|write|destructive)?|call|invoke|request|bb_(post|put|patch|delete)|post|put|patch|delete)$/i;
const NOT_KEYS = /^(UTF|ISO|SHA|RFC|HTTP|HTTPS|TLS|SSL|UTC|GMT|MD|AES|RSA|CVE|PEP|COVID)$/;

function words(s: string): Set<string> {
  return new Set(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}
function short(s: string, max = 100): string {
  const one = s.replace(/[*_`>]+/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trim()}…` : one;
}
function keyIn(s: string): string {
  const re = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
  for (let m = re.exec(s); m; m = re.exec(s)) if (!NOT_KEYS.test(m[1])) return m[0];
  return '';
}

export function describeChange(tool: string, inputJSON: string, at: number): RunChange {
  const parsed = parseMcpToolName(tool);
  const server = parsed?.server ?? tool;
  const name = parsed?.tool ?? tool;
  let input: Record<string, unknown> = {};
  try {
    input = obj(JSON.parse(inputJSON)) ?? {};
  } catch {
    // Cut off at its cap: the tool's name still says what kind of change.
  }
  const generic = GENERIC.test(name);
  const op = generic ? str(input.name) || str(input.operation) || str(input.method) : '';
  const inner = (generic && (obj(input.inputs) ?? obj(input.arguments) ?? obj(input.params) ?? obj(input.body))) || input;
  const path = str(input.path) || str(input.url) || str(inner.path) || str(inner.url);
  const w = words(`${name} ${op} ${path}`);
  const has = (...xs: string[]) => xs.some((x) => w.has(x));

  const prNum = /pull-?requests?\/(\d+)/i.exec(path)?.[1] || str(inner.pullRequestId) || str(inner.pull_request_id) || str(inner.prNumber) || str(inner.pr_number) || str(inner.pull_number);
  const repo = (/repositories\/[^/]+\/([^/?#]+)/.exec(path)?.[1] ?? /repos\/[^/]+\/([^/?#]+)/.exec(path)?.[1]) || str(inner.repo_slug) || str(inner.repoSlug) || str(inner.repo) || str(inner.repository);
  const isPr = (has('pull') && has('request', 'requests')) || has('pullrequest', 'pullrequests') || /pull-?requests?/i.test(path);
  const key = keyIn(str(inner.issueIdOrKey) || str(inner.issueKey) || str(inner.issue_key) || str(inner.key)) || keyIn(inputJSON);
  const channel = str(inner.channel) || str(inner.channel_id) || str(inner.channelId);
  const target = isPr && prNum ? `${repo ? repo.split('/').pop() : 'PR'}#${prNum}` : key || (channel ? channel : '');

  const text = str(inner.body) || str(inner.comment) || str(inner.commentBody) || str(inner.text) || str(inner.content) || str(inner.message);
  let kind: RunChangeKind;
  let detail = '';
  if (has('comment', 'comments')) {
    kind = 'comment';
    detail = text ? short(text) : '';
  } else if (isPr) {
    kind = 'pullRequest';
    detail = has('approve') ? 'approved' : has('merge') ? 'merged' : has('decline', 'close') ? 'declined' : has('create', 'open') || (generic && /post/i.test(name) && !prNum) ? 'opened' : '';
  } else if (has('transition', 'transitions', 'status', 'move', 'state')) {
    kind = 'status';
    const tr = obj(inner.transition);
    detail = str(tr?.name) || str(inner.status) || str(inner.state) || str(inner.to) || (str(tr?.id) || str(inner.transitionId) ? `transition ${str(tr?.id) || str(inner.transitionId)}` : '');
  } else if (has('message', 'send', 'chat', 'reply', 'reaction') || (/slack/i.test(server) && has('post'))) {
    kind = 'message';
    detail = text ? short(text) : '';
  } else if (has('delete', 'remove', 'archive', 'destroy')) {
    kind = 'removed';
  } else if (has('create', 'add', 'new', 'insert')) {
    kind = 'created';
    detail = short(str(inner.summary) || str(inner.title) || str(inner.name), 80);
  } else if (has('edit', 'update', 'set', 'patch', 'put', 'modify', 'assign', 'upsert')) {
    kind = 'fields';
    const fields = Object.keys(obj(inner.fields) ?? obj(inner.update) ?? {});
    const named = fields.filter((f) => !/^customfield_/i.test(f));
    detail = fields.length ? `${fields.length} field${fields.length === 1 ? '' : 's'}${named.length ? `: ${named.slice(0, 3).join(', ')}` : ''}` : '';
  } else {
    kind = 'other';
    detail = [...words(op || name)].join(' ');
  }
  return { kind, server, ...(target ? { target } : {}), ...(detail ? { detail } : {}), at };
}

/// What a run changed, read back from a session transcript (Claude's JSONL):
/// each call of an MCP tool that doesn't only read, made between from and to,
/// whose result came back without an error. For runs from before changes were
/// kept as they happened. Lines that aren't JSON, or aren't tool calls, are skipped.
export function changesFromTranscript(lines: string[], from: number, to: number, readsOnly: (tool: string) => boolean): RunChange[] {
  const calls = new Map<string, { tool: string; input: string; at: number }>();
  const out: RunChange[] = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let entry: { timestamp?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry.timestamp ?? '');
    const content = Array.isArray(entry.message?.content) ? (entry.message!.content as Array<Record<string, unknown>>) : [];
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
        if (!block.name.startsWith('mcp__') || readsOnly(block.name) || !(at >= from && at <= to)) continue;
        calls.set(block.id, { tool: block.name, input: JSON.stringify(block.input ?? {}), at });
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        calls.delete(block.tool_use_id);
        if (block.is_error === true) continue;
        out.push(describeChange(call.tool, call.input, call.at));
      }
    }
  }
  return out;
}
