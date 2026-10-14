import { useState } from 'react';
import type { StreamEvent, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { parseMcpToolName } from '@shared/flows/mcpTools';
import { ToolUseCard } from './ToolUseCard';
import { rendersWhenToolActivityHidden } from './toolCardPolicy';

/// The Summary level's one line per turn: what the agent read, ran and
/// changed, folded shut. Quiet hides those calls and says nothing; Detailed
/// gives each its own card. This is the part of the turn you didn't see,
/// counted, with the cards a click away.

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
/// Bookkeeping, not work: counting it would only pad the line.
const UNCOUNTED = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'BashOutput']);

/// Each turn's primary-agent tool calls, keyed by the id of the `result`
/// event that closes the turn. A turn still running has no result yet and
/// no entry — the running strip covers it.
export function turnActivityByResult(events: StreamEvent[]): Map<string, ToolUseBlock[]> {
  const out = new Map<string, ToolUseBlock[]>();
  let uses: ToolUseBlock[] = [];
  for (const ev of events) {
    if (ev.reviewer) continue;
    const k = ev.kind;
    if (k.type === 'localUser') {
      uses = [];
    } else if (k.type === 'assistant') {
      uses.push(...k.info.toolUses);
    } else if (k.type === 'result') {
      if (uses.length) out.set(ev.id, uses);
      uses = [];
    }
  }
  return out;
}

function inputOf(use: ToolUseBlock): Record<string, unknown> {
  try {
    const v = JSON.parse(use.inputJSON);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/// "read 6 files · ran 2 commands · changed 3 files". Files are counted
/// once however many times they were touched; a command that changed files
/// counts toward both.
export function summarizeActivity(uses: ToolUseBlock[], results: Map<string, ToolResultBlock>): string {
  const read = new Set<string>();
  const changed = new Set<string>();
  let searches = 0;
  let commands = 0;
  let web = 0;
  let agents = 0;
  let other = 0;
  const servers = new Map<string, number>();
  for (const use of uses) {
    const input = inputOf(use);
    const path = String(input.file_path ?? input.notebook_path ?? use.id);
    if (READ_TOOLS.has(use.name)) read.add(path);
    else if (SEARCH_TOOLS.has(use.name)) searches++;
    else if (EDIT_TOOLS.has(use.name)) changed.add(path);
    else if (use.name === 'Bash') commands++;
    else if (WEB_TOOLS.has(use.name)) web++;
    else if (AGENT_TOOLS.has(use.name)) agents++;
    else if (UNCOUNTED.has(use.name)) continue;
    else {
      const mcp = parseMcpToolName(use.name);
      if (mcp) servers.set(mcp.server, (servers.get(mcp.server) ?? 0) + 1);
      else other++;
    }
    for (const c of results.get(use.id)?.fileChanges ?? []) changed.add(c.path);
  }
  const parts: string[] = [];
  if (read.size) parts.push(`read ${plural(read.size, 'file')}`);
  if (searches) parts.push(`searched ${plural(searches, 'time')}`);
  if (commands) parts.push(`ran ${plural(commands, 'command')}`);
  if (changed.size) parts.push(`changed ${plural(changed.size, 'file')}`);
  if (web) parts.push(`looked up ${plural(web, 'page')}`);
  if (agents) parts.push(`started ${plural(agents, 'subagent')}`);
  for (const [server, n] of servers) parts.push(`used ${server.replace(/^claude_ai_/, '')} ${plural(n, 'time')}`);
  if (other) parts.push(`used ${plural(other, 'other tool')}`);
  if (!parts.length) return '';
  const line = parts.join(' · ');
  return line[0].toUpperCase() + line.slice(1);
}

export function TurnActivity({
  uses,
  toolResultIndex,
  conversationId,
}: {
  uses: ToolUseBlock[];
  toolResultIndex: Map<string, ToolResultBlock>;
  conversationId: UUID;
}) {
  const [open, setOpen] = useState(false);
  const line = summarizeActivity(uses, toolResultIndex);
  if (!line) return null;
  // Edits, subagents and questions already have their own cards in the
  // transcript; listing them again here would paint them twice.
  const hidden = uses.filter((u) => !rendersWhenToolActivityHidden(u, toolResultIndex.get(u.id)));
  return (
    <div className="mb-1 text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!hidden.length}
        className="flex items-center gap-1.5 text-ink-muted enabled:hover:text-ink"
        aria-expanded={open}
      >
        {hidden.length > 0 && <span className="text-[10px] text-ink-faint">{open ? '▾' : '▸'}</span>}
        <span>{line}</span>
      </button>
      {open && (
        <div className="mt-1.5 ml-3 flex flex-col gap-1.5">
          {hidden.map((use) => (
            <ToolUseCard
              key={use.id}
              use={use}
              result={toolResultIndex.get(use.id)}
              conversationId={conversationId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
