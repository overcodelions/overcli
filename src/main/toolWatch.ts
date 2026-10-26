// Every MCP tool result, from any conversation (flow steps, hidden turns),
// matched to the call that asked for it, for whoever wants to know how a
// tool is doing. One watcher; the org server sets it (toolHealth.ts).

import type { MainToRendererEvent } from '../shared/types';

export interface ToolOutcome {
  conversationId: string;
  /// The MCP server, `atlassian` from `mcp__atlassian__jira_search`.
  server: string;
  call: string;
  ok: boolean;
  text: string;
}

let watcher: ((o: ToolOutcome) => void) | null = null;
/// Calls waiting for their result, by tool_use id.
const pending = new Map<string, string>();
const MAX_PENDING = 5000;

export function setToolWatcher(w: ((o: ToolOutcome) => void) | null): void {
  watcher = w;
}

export function watchToolEvents(event: MainToRendererEvent): void {
  if (!watcher || event.type !== 'stream') return;
  for (const ev of event.events) {
    if (ev.kind.type === 'assistant') {
      for (const u of ev.kind.info.toolUses ?? []) {
        if (!u.name.startsWith('mcp__')) continue;
        pending.set(u.id, u.name);
        if (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
      }
    } else if (ev.kind.type === 'toolResult') {
      for (const r of ev.kind.results) {
        const name = pending.get(r.id);
        if (!name) continue;
        pending.delete(r.id);
        const m = /^mcp__(.+?)__(.+)$/.exec(name);
        if (!m) continue;
        try {
          watcher({ conversationId: event.conversationId, server: m[1], call: m[2], ok: !r.isError, text: r.content ?? '' });
        } catch {
          // A watcher's trouble is never the run's.
        }
      }
    }
  }
}
