import { useEffect, useState } from 'react';
import { diffLines } from 'diff';
import type { StreamEvent, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { parseMcpToolName } from '@shared/flows/mcpTools';
import { useOpenFile } from '../openFile';
import { ToolUseCard } from './ToolUseCard';
import { rendersWhenToolActivityHidden } from './toolCardPolicy';

/// The Summary level's line: what the agent did for one message — read,
/// ran, changed — on a single unboxed line under the reply. While the
/// message is being worked on it sits under the transcript, the call in
/// flight first, the tally after it and the elapsed time at the end; when
/// the work is done it settles under the message's last step. Quiet hides
/// those calls and says nothing; Detailed gives each its own card. This is
/// the part you didn't see, counted, with changed files named (and sized)
/// and the steps a click away.
///
/// One line per MESSAGE, not per turn-closing event: a long message can
/// close several turns (each step gets its own ✓ caption), and a line after
/// every one of them read "Ran 1 command" three times instead of saying
/// what the message did.

const READ_TOOLS = new Set(['Read', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const AGENT_TOOLS = new Set(['Task', 'Agent']);
/// Bookkeeping, not work: counting it would only pad the line.
const UNCOUNTED = new Set(['TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'BashOutput']);
/// Changed files named on the chip before the rest fold into "+N more".
const MAX_NAMED_FILES = 4;

/// One message's calls. `messageId` is the user message's event id ('' for
/// work before any), so the line's open/closed state can follow the message
/// from the live footer onto its row when the work finishes.
export interface MessageActivity {
  uses: ToolUseBlock[];
  messageId: string;
}

/// Each message's primary-agent tool calls, keyed by the id of the LAST
/// `result` event before the next message — the row the line sits on.
/// `running` leaves out the message still being worked on: its line is the
/// live one (`openTurnActivity`), and showing it on an earlier step's row
/// as well would paint it twice.
export function turnActivityByResult(events: StreamEvent[], running = false): Map<string, MessageActivity> {
  const out = new Map<string, MessageActivity>();
  let uses: ToolUseBlock[] = [];
  let messageId = '';
  let lastResult: string | null = null;
  const close = () => {
    if (lastResult && uses.length) out.set(lastResult, { uses, messageId });
  };
  for (const ev of events) {
    if (ev.reviewer) continue;
    const k = ev.kind;
    if (k.type === 'localUser') {
      close();
      uses = [];
      messageId = ev.id;
      lastResult = null;
    } else if (k.type === 'assistant') {
      uses = [...uses, ...k.info.toolUses];
    } else if (k.type === 'result') {
      lastResult = ev.id;
    }
  }
  if (!running) close();
  return out;
}

/// The message being worked on: its calls so far and when it was sent.
/// Everything since the last user message, whatever steps closed between.
export function openTurnActivity(events: StreamEvent[]): MessageActivity & { startedAt: number | null } {
  const uses: ToolUseBlock[] = [];
  let startedAt: number | null = null;
  let messageId = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.reviewer) continue;
    const k = ev.kind;
    if (k.type === 'localUser') {
      startedAt = ev.timestamp;
      messageId = ev.id;
      break;
    }
    if (k.type === 'assistant') uses.unshift(...k.info.toolUses);
  }
  return { uses, startedAt, messageId };
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

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface ActivityDigest {
  /// "read 6 files", "ran 2 commands"… — everything but the changed files.
  parts: string[];
  /// Files changed, first change first, with their line counts summed
  /// over every edit to them.
  changed: ChangedFile[];
}

/// Lines added and removed going from `before` to `after` — the same
/// counting the diff cards use.
function lineCounts(before: string, after: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    const n = part.count ?? part.value.split('\n').length - (part.value.endsWith('\n') ? 1 : 0);
    if (part.added) additions += n;
    else if (part.removed) deletions += n;
  }
  return { additions, deletions };
}

/// What an Edit, MultiEdit or Write did to its file, in lines. A Write
/// counts every line as added: the file it replaced isn't in the call.
function editCounts(use: ToolUseBlock, input: Record<string, unknown>): { additions: number; deletions: number } {
  if (use.name === 'Write') return lineCounts('', String(input.content ?? ''));
  if (use.name === 'MultiEdit' && Array.isArray(input.edits)) {
    let additions = 0;
    let deletions = 0;
    for (const e of input.edits as Array<Record<string, unknown>>) {
      const c = lineCounts(String(e.old_string ?? ''), String(e.new_string ?? ''));
      additions += c.additions;
      deletions += c.deletions;
    }
    return { additions, deletions };
  }
  return lineCounts(String(input.old_string ?? use.oldString ?? ''), String(input.new_string ?? use.newString ?? ''));
}

/// Count what a turn did. Files are counted once however many times they
/// were touched; a command that changed files counts toward both.
export function digestActivity(uses: ToolUseBlock[], results: Map<string, ToolResultBlock>): ActivityDigest {
  const read = new Set<string>();
  const changed = new Map<string, ChangedFile>();
  const bump = (path: string, c: { additions: number; deletions: number }) => {
    const f = changed.get(path) ?? { path, additions: 0, deletions: 0 };
    f.additions += c.additions;
    f.deletions += c.deletions;
    changed.set(path, f);
  };
  let searches = 0;
  let commands = 0;
  let web = 0;
  let agents = 0;
  let other = 0;
  const servers = new Map<string, number>();
  for (const use of uses) {
    const input = inputOf(use);
    const path = String(input.file_path ?? input.notebook_path ?? use.filePath ?? use.id);
    if (READ_TOOLS.has(use.name)) read.add(path);
    else if (SEARCH_TOOLS.has(use.name)) searches++;
    else if (EDIT_TOOLS.has(use.name)) bump(path, editCounts(use, input));
    else if (use.name === 'Bash') commands++;
    else if (WEB_TOOLS.has(use.name)) web++;
    else if (AGENT_TOOLS.has(use.name)) agents++;
    else if (UNCOUNTED.has(use.name)) continue;
    else {
      const mcp = parseMcpToolName(use.name);
      if (mcp) servers.set(mcp.server, (servers.get(mcp.server) ?? 0) + 1);
      else other++;
    }
    for (const c of results.get(use.id)?.fileChanges ?? []) bump(c.path, c);
  }
  const parts: string[] = [];
  if (read.size) parts.push(`read ${plural(read.size, 'file')}`);
  if (searches) parts.push(`searched ${plural(searches, 'time')}`);
  if (commands) parts.push(`ran ${plural(commands, 'command')}`);
  if (web) parts.push(`looked up ${plural(web, 'page')}`);
  if (agents) parts.push(`started ${plural(agents, 'subagent')}`);
  for (const [server, n] of servers) parts.push(`used ${server.replace(/^claude_ai_/, '')} ${plural(n, 'time')}`);
  if (other) parts.push(`used ${plural(other, 'other tool')}`);
  return { parts, changed: [...changed.values()] };
}

/// The digest as one plain line: "Read 6 files · ran 2 commands · changed
/// 3 files". Empty when the turn did nothing worth counting.
export function summarizeActivity(uses: ToolUseBlock[], results: Map<string, ToolResultBlock>): string {
  const { parts, changed } = digestActivity(uses, results);
  const all = changed.length ? [...parts, `changed ${plural(changed.length, 'file')}`] : parts;
  return capitalize(all.join(' · '));
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/// "42s", "3m 05s".
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${m}m ${sec}s`;
}

/// Re-render once a second while `on`, for the elapsed clock.
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function TurnActivity({
  uses,
  toolResultIndex,
  conversationId,
  live,
  startedAt,
  open: openProp,
  onToggle,
}: {
  uses: ToolUseBlock[];
  toolResultIndex: Map<string, ToolResultBlock>;
  conversationId: UUID;
  /// Set while the message is being worked on: the call in flight
  /// ("Running npm test…"), which leads the line.
  live?: string | null;
  /// When the message was sent, for the elapsed clock on the live line.
  startedAt?: number | null;
  /// Controlled open state. The transcript owns it, per message, so the
  /// steps stay open as new events stream in and when the line moves from
  /// the live footer to the message's row. Uncontrolled without it.
  open?: boolean;
  onToggle?: () => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen((o) => !o));
  const openFile = useOpenFile();
  const isLive = live !== undefined;
  const now = useNow(isLive && !!startedAt);
  const { parts, changed } = digestActivity(uses, toolResultIndex);
  if (!parts.length && !changed.length && !live) return null;
  // Edits, subagents and questions already have their own cards in the
  // transcript; listing them again here would paint them twice.
  const hidden = uses.filter((u) => !rendersWhenToolActivityHidden(u, toolResultIndex.get(u.id)));
  const named = changed.slice(0, MAX_NAMED_FILES);
  const more = changed.length - named.length;
  const tally = parts.join(' · ');
  return (
    <div className="mb-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 py-0.5 text-[12.5px] text-ink-muted">
        {live && (
          <>
            <span className="h-[7px] w-[7px] flex-shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
            <span className="font-medium text-ink">{live}</span>
            {(tally || named.length > 0) && <span className="text-ink-faint">·</span>}
          </>
        )}
        {tally && <span>{live ? tally : capitalize(tally)}</span>}
        {named.length > 0 && (
          <>
            {tally && <span className="text-ink-faint">·</span>}
            <span>{tally || live ? 'changed' : 'Changed'}</span>
            {named.map((f) => (
              <span key={f.path} className="inline-flex items-baseline gap-1">
                <button
                  type="button"
                  onClick={() => openFile(f.path, undefined, 'diff')}
                  title={`Open the diff for ${f.path}`}
                  className="font-mono text-[12px] text-accent hover:underline"
                >
                  {basename(f.path)}
                </button>
                {(f.additions > 0 || f.deletions > 0) && (
                  <span className="text-[11px]">
                    {f.additions > 0 && <span className="text-green-500 dark:text-green-400">+{f.additions}</span>}
                    {f.additions > 0 && f.deletions > 0 && ' '}
                    {f.deletions > 0 && <span className="text-red-500 dark:text-red-400">−{f.deletions}</span>}
                  </span>
                )}
              </span>
            ))}
            {more > 0 && <span>+{more} more</span>}
          </>
        )}
        <span className="ml-auto flex items-center gap-3">
          {hidden.length > 0 && (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="text-[12px] text-accent hover:underline"
            >
              {open ? 'Hide steps' : `Show ${hidden.length} ${hidden.length === 1 ? 'step' : 'steps'}`}
            </button>
          )}
          {isLive && startedAt && <span className="text-[12px] tabular-nums">{formatElapsed(now - startedAt)}</span>}
        </span>
      </div>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1.5">
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
