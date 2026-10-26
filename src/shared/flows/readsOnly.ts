// Whether a worker's work can change anything: what decides that someone
// who isn't its manager may have it run without the manager's OK. A worker
// that only reads (searches a tracker, reads a page) can answer anyone it's
// allowed to; one that could write, push, post or act outside waits for its
// manager, whoever asked.

import { isReadOnlyMcpTool, parseMcpToolName } from './mcpTools';

export interface StepTools {
  role?: string;
  effect?: 'local' | 'external';
  tools?: string[];
}

/// What its flow could change, in words; empty when it only reads. Its own
/// files folder doesn't count: writing a report there changes nothing anyone
/// else has.
export function whatItChanges(steps: StepTools[], actsOutside: boolean): string[] {
  const out: string[] = [];
  if (actsOutside) out.push('it may act outside the server');
  for (const s of steps) {
    if (s.role === 'shipper') out.push('a step ships its work (a push, a message or a publish)');
    if (s.effect === 'external') out.push('a step is marked as acting outside the server');
    for (const t of s.tools ?? []) {
      const bash = /^bash(?:\((.+?)(?::\*)?\))?$/i.exec(t);
      if (bash) {
        if (!/^(git (diff|log|show|status|ls-files|rev-parse)|cd|pwd|ls|echo|cat|grep|rg|find|head|tail|wc|jq)\b/.test(bash[1] ?? '')) out.push(bash[1] ? `it runs ${bash[1]}` : 'it runs shell commands');
        continue;
      }
      if (t.startsWith('mcp__') && parseMcpToolName(t) && !isReadOnlyMcpTool(t)) out.push(`it can use ${t.replace(/^mcp__/, '').replace('__', ' → ')}`);
    }
  }
  return [...new Set(out)];
}

/// The account connectors (a Claude.ai Jira, Gmail…) a flow reads through,
/// by the name Claude lists them under, and the tools of theirs it could
/// also write with: so a quick turn can read through the same connector a
/// run would, and nothing more.
export function readConnectors(steps: StepTools[]): { servers: string[]; denied: string[] } {
  const servers = new Set<string>();
  const denied = new Set<string>();
  for (const s of steps) {
    for (const t of s.tools ?? []) {
      const p = parseMcpToolName(t);
      if (!p || !/^claude_ai_/.test(p.server)) continue;
      if (isReadOnlyMcpTool(t)) servers.add(`claude.ai ${p.server.replace(/^claude_ai_/, '').replace(/_/g, ' ')}`);
      else denied.add(t);
    }
  }
  return { servers: [...servers], denied: [...denied] };
}
