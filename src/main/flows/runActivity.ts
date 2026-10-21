// What a run is doing, step by step, as people can read it: each tool it
// used ("Read roadmap-items.md", "Searched the web: partner MCP"), what it
// said along the way, and anything refused or failed. Built from the same
// stream events everything else sees — so a team page or a worker's thread
// can show a member's run live without anyone opening a transcript.
//
// Kept in memory while the server runs and, when given a folder, on disk as
// one small file per run, so it is still there after a restart. Files older
// than the org keeps things (`retentionDays`, else a week) are removed.

import fs from 'node:fs';
import path from 'node:path';
import type { MainToRendererEvent } from '../../shared/types';

export interface RunActivityItem {
  at: number;
  kind: 'tool' | 'said' | 'error' | 'denied';
  text: string;
}

const MAX_PER_RUN = 150;
const MAX_RUNS = 200;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/// One tool call in a few words. Paths lose everything but their last parts;
/// nothing a tool was given is shown whole.
export function describeTool(name: string, inputJSON: string): string {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(inputJSON || '{}') as unknown;
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  } catch {
    // Partial or odd input: describe by name alone.
  }
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const short = (p: string) => p.split('/').filter(Boolean).slice(-2).join('/') || p;
  switch (name) {
    case 'Read':
      return `Read ${short(str('file_path'))}`;
    case 'Write':
      return `Wrote ${short(str('file_path'))}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${short(str('file_path'))}`;
    case 'Glob':
      return `Looked for ${clip(str('pattern'), 80)}`;
    case 'Grep':
      return `Searched files for “${clip(str('pattern'), 60)}”`;
    case 'Bash':
      return `Ran ${clip(str('command'), 100)}`;
    case 'WebSearch':
      return `Searched the web: ${clip(str('query'), 90)}`;
    case 'WebFetch':
      return `Opened ${clip(str('url'), 100)}`;
    case 'Task':
    case 'Agent':
      return `Handed a part to a helper: ${clip(str('description') || str('prompt'), 80)}`;
    case 'TodoWrite':
      return 'Updated its to-do list';
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const server = mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ');
    const tool = mcp[2].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    const hint = str('query') || str('jql') || str('search') || str('id') || str('key');
    return `${server}: ${tool}${hint ? ` (${clip(hint, 50)})` : ''}`;
  }
  return name;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export class RunActivity {
  private byRun = new Map<string, RunActivityItem[]>();
  private madeDir = false;
  private convRun = new Map<string, string>();

  constructor(
    private runFor: (conversationId: string) => string | undefined,
    /// Where each run's activity is kept, and for how many days. Absent: memory only.
    private disk?: { dir: string; keepDays: () => number },
  ) {}

  private file(runId: string): string | null {
    return this.disk && SAFE_ID.test(runId) ? path.join(this.disk.dir, `${runId}.jsonl`) : null;
  }

  /// Remove what is older than the org keeps. Returns how many runs' activity went.
  prune(now = Date.now()): number {
    if (!this.disk) return 0;
    const cutoff = now - Math.max(1, this.disk.keepDays()) * DAY_MS;
    let gone = 0;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.disk.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(this.disk.dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          this.byRun.delete(name.slice(0, -6));
          gone++;
        }
      } catch {
        // Raced with another prune; fine.
      }
    }
    return gone;
  }

  observe(event: MainToRendererEvent): void {
    if (event.type !== 'stream') return;
    let runId = this.convRun.get(event.conversationId);
    if (!runId) {
      runId = this.runFor(event.conversationId);
      if (!runId) return;
      this.convRun.set(event.conversationId, runId);
      if (this.convRun.size > 2000) this.convRun.delete(this.convRun.keys().next().value as string);
    }
    for (const ev of event.events) {
      const k = ev.kind;
      const at = ev.timestamp || Date.now();
      if (k.type === 'assistant' && !k.info.isPartial) {
        if (k.info.text.trim()) this.push(runId, { at, kind: 'said', text: clip(k.info.text, 400) });
        for (const t of k.info.toolUses) this.push(runId, { at, kind: 'tool', text: describeTool(t.name, t.inputJSON) });
      } else if (k.type === 'toolResult') {
        for (const r of k.results) if (r.isError) this.push(runId, { at, kind: 'error', text: clip(r.content, 200) });
      } else if (k.type === 'permissionRequest' && k.info.decided === 'deny') {
        this.push(runId, { at, kind: 'denied', text: `Not allowed: ${k.info.toolName}` });
      }
    }
  }

  /// A run's activity, oldest first; `after` returns only what came since.
  list(runId: string, after = 0): RunActivityItem[] {
    let items = this.byRun.get(runId);
    if (!items) {
      // After a restart: read it back from its file.
      const f = this.file(runId);
      items = [];
      if (f) {
        try {
          items = fs
            .readFileSync(f, 'utf8')
            .split('\n')
            .filter(Boolean)
            .flatMap((l) => {
              try {
                return [JSON.parse(l) as RunActivityItem];
              } catch {
                return [];
              }
            })
            .slice(-MAX_PER_RUN);
        } catch {
          items = [];
        }
      }
      if (items.length) this.byRun.set(runId, items);
    }
    return items.filter((x) => x.at > after);
  }

  private push(runId: string, item: RunActivityItem): void {
    let list = this.byRun.get(runId);
    if (!list) {
      list = [];
      this.byRun.set(runId, list);
      // Oldest runs go first when there are too many.
      if (this.byRun.size > MAX_RUNS) this.byRun.delete(this.byRun.keys().next().value as string);
    }
    list.push(item);
    if (list.length > MAX_PER_RUN) list.splice(0, list.length - MAX_PER_RUN);
    const f = this.file(runId);
    if (f) {
      try {
        if (!this.madeDir) { fs.mkdirSync(path.dirname(f), { recursive: true }); this.madeDir = true; }
        fs.appendFile(f, `${JSON.stringify(item)}\n`, () => {});
      } catch {
        // A full disk loses the log, not the run.
      }
    }
  }
}
