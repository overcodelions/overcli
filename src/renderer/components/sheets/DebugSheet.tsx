import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useRunner } from '../../runnersStore';
import { useFlowsStore } from '../../flowsStore';
import { flowConversationSources, focusedParticipantId } from '../../flowFocus';
import type { SilentLogEntry, StreamEvent } from '../../../shared/types';
import { UNRANKED_TOOL_COLOR, shortToolName, toolColorRamp } from './toolColors';
import {
  ToolTiming,
  TurnTiming,
  formatSeconds,
  formatTokens,
  shareOfWork,
  summarizeTurns,
  totalTiming,
} from './turnTiming';

type Tab = 'timing' | 'stream' | 'diagnostics';

export function DebugSheet() {
  const selectedId = useStore((s) => s.selectedConversationId);
  // Flows and Workers never set `selectedConversationId` — a run is picked
  // through `useFlowsStore.setActiveRun`, and the conversation stays
  // whatever chat was open last. Without this the sheet would answer a
  // question about a flow run with some unrelated chat's numbers, which is
  // worse than answering nothing. A run has no single transcript either:
  // each participant keeps its own conversation across every step it runs,
  // so the sheet offers them and defaults to the one the run is at.
  const detailMode = useStore((s) => s.detailMode);
  const activeRun = useFlowsStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const inRun = (detailMode === 'flows' || detailMode === 'workers') && !!activeRun;
  const sources = useMemo(
    () => (inRun && activeRun ? flowConversationSources(activeRun) : []),
    [inRun, activeRun],
  );
  // Keyed by run id so switching runs falls back to the new run's focused
  // participant instead of holding a selection that belongs to another run.
  const [picked, setPicked] = useState<{ runId: string; participantId: string } | null>(null);
  const activeParticipantId =
    (picked && activeRun && picked.runId === activeRun.id
      ? sources.find((s) => s.participantId === picked.participantId)?.participantId
      : undefined) ??
    (activeRun ? focusedParticipantId(activeRun) : null) ??
    sources[0]?.participantId ??
    null;
  const runConvId =
    sources.find((s) => s.participantId === activeParticipantId)?.conversationId ?? null;

  const runner = useRunner(inRun ? runConvId : selectedId);
  const events = runner?.events ?? [];

  const [tab, setTab] = useState<Tab>('timing');
  const [query, setQuery] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allExpanded, setAllExpanded] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.kind.type, (m.get(e.kind.type) ?? 0) + 1);
    return m;
  }, [events]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => {
      if (activeTypes.size > 0 && !activeTypes.has(e.kind.type)) return false;
      if (q && !e.raw.toLowerCase().includes(q) && !e.kind.type.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [events, query, activeTypes]);

  const toggleType = (t: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isExpanded = (id: string) => allExpanded || expanded.has(id);

  const expandAll = () => {
    setAllExpanded(true);
    setExpanded(new Set());
  };
  const collapseAll = () => {
    setAllExpanded(false);
    setExpanded(new Set());
  };
  const copyAll = () => {
    const text = filtered
      .map((e) => {
        const time = new Date(e.timestamp).toISOString().slice(11, 23);
        return `[${time}] ${e.kind.type}\n${e.raw}`;
      })
      .join('\n\n');
    navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1200);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-5 pt-4 pb-2 border-b border-card flex items-center gap-3 text-xs">
        <button
          onClick={() => setTab('timing')}
          className={
            'px-2 py-1 rounded font-medium transition-colors ' +
            (tab === 'timing' ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
          }
        >
          Timing
        </button>
        <button
          onClick={() => setTab('stream')}
          className={
            'px-2 py-1 rounded font-medium transition-colors ' +
            (tab === 'stream' ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
          }
        >
          Stream
        </button>
        <button
          onClick={() => setTab('diagnostics')}
          className={
            'px-2 py-1 rounded font-medium transition-colors ' +
            (tab === 'diagnostics' ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
          }
        >
          Diagnostics
        </button>
        {inRun && tab !== 'diagnostics' && (
          <div className="ml-auto flex items-center gap-1 min-w-0">
            <span className="text-ink-faint shrink-0">participant</span>
            {sources.length === 0 ? (
              <span className="text-ink-faint">none yet</span>
            ) : (
              sources.map((s) => (
                <button
                  key={s.participantId}
                  onClick={() =>
                    activeRun &&
                    setPicked({ runId: activeRun.id, participantId: s.participantId })
                  }
                  className={
                    'px-2 py-1 rounded transition-colors truncate ' +
                    (s.participantId === activeParticipantId
                      ? 'bg-card-strong text-ink'
                      : 'text-ink-muted hover:text-ink')
                  }
                >
                  {s.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {tab === 'diagnostics' ? <DiagnosticsTab /> : tab === 'timing' ? (
        <TimingTab events={events} inRun={inRun} />
      ) : (
      <>
      <div className="px-5 pt-4 pb-3 border-b border-card">
        <div className="flex items-baseline justify-between mb-2">
          <div>
            <div className="text-lg font-semibold">Debug stream</div>
            <div className="text-xs text-ink-faint">
              {filtered.length === events.length
                ? `${events.length} event${events.length === 1 ? '' : 's'}`
                : `${filtered.length} of ${events.length} events`}
            </div>
          </div>
          <div className="flex gap-2 text-[11px]">
            <button
              onClick={expandAll}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
            >
              expand all
            </button>
            <button
              onClick={collapseAll}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
            >
              collapse all
            </button>
            <button
              onClick={copyAll}
              disabled={filtered.length === 0}
              className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {copiedAll ? 'copied' : 'copy all'}
            </button>
          </div>
        </div>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search event content or type…"
          className="w-full bg-card px-3 py-2 text-sm rounded outline-none focus:bg-card-strong mb-2"
        />
        <div className="flex flex-wrap gap-1">
          {Array.from(typeCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([type, count]) => {
              const active = activeTypes.has(type);
              return (
                <button
                  key={type}
                  onClick={() => toggleType(type)}
                  className={
                    'px-2 py-0.5 rounded text-[10px] font-mono transition-colors ' +
                    (active
                      ? 'bg-accent/30 text-ink'
                      : 'bg-card text-ink-muted hover:bg-card-strong hover:text-ink')
                  }
                >
                  {type} <span className="text-ink-faint">{count}</span>
                </button>
              );
            })}
          {activeTypes.size > 0 && (
            <button
              onClick={() => setActiveTypes(new Set())}
              className="px-2 py-0.5 rounded text-[10px] text-ink-faint hover:text-ink"
            >
              clear
            </button>
          )}
        </div>
      </div>
      <div className="overflow-y-auto px-5 py-2 flex-1 font-mono text-[11px]">
        {filtered.length === 0 ? (
          <div className="text-ink-faint py-3">
            {events.length === 0 ? 'No events yet.' : 'No events match your filter.'}
          </div>
        ) : (
          filtered.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              expanded={isExpanded(e.id)}
              onToggle={() => toggleExpanded(e.id)}
              query={query.trim()}
            />
          ))
        )}
      </div>
      </>
      )}
    </div>
  );
}

/// Where a conversation's wall clock actually went, per turn.
///
/// Everything here is derived from `events` in the renderer — see
/// `turnTiming.ts`. Nothing is persisted and nothing new crosses IPC, so
/// this tab costs nothing until someone opens it.
function TimingTab({ events, inRun }: { events: StreamEvent[]; inRun: boolean }) {
  const turns = useMemo(() => summarizeTurns(events), [events]);
  const total = useMemo(() => totalTiming(turns), [turns]);
  // Ranked once across the whole conversation so a tool holds one color in
  // every turn, rather than being recoloured by each turn's local ordering.
  const colors = useMemo(() => toolColorRamp((total?.tools ?? []).map((t) => t.name)), [total]);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const header =
      'turn\twall\tmodel\ttools\ttop_tool\tout_tok\treasoning_est\tdecode_tok_s\tcache_write';
    const body = turns.map((t, i) =>
      [
        i + 1,
        formatSeconds(t.wallMs),
        formatSeconds(t.modelMs),
        formatSeconds(t.toolMs),
        t.tools[0] ? `${t.tools[0].name} ${formatSeconds(t.tools[0].busyMs)}` : '',
        t.outputTokens,
        t.reasoningTokensEst,
        t.decodeTokensPerSec?.toFixed(0) ?? '',
        t.cacheCreationTokens,
      ].join('\t'),
    );
    navigator.clipboard.writeText([header, ...body].join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-card">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-lg font-semibold">Turn timing</div>
            <div className="text-xs text-ink-faint">
              Where this conversation spent its time. Model time is everything that isn&apos;t
              waiting on a tool; reasoning is estimated as output tokens minus visible prose and
              tool arguments.
            </div>
          </div>
          <button
            onClick={copy}
            disabled={turns.length === 0}
            className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink text-[11px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {copied ? 'copied' : 'copy tsv'}
          </button>
        </div>
        {total && (
          <div className="mt-3 grid grid-cols-5 gap-2 text-center">
            <Stat label="model" value={`${shareOfWork(total.modelMs, total).toFixed(0)}%`} sub={formatSeconds(total.modelMs)} />
            <Stat label="tools" value={`${shareOfWork(total.toolMs, total).toFixed(0)}%`} sub={formatSeconds(total.toolMs)} />
            <Stat
              label="reasoning"
              value={
                total.outputTokens > 0
                  ? `${((total.reasoningTokensEst / total.outputTokens) * 100).toFixed(0)}%`
                  : '—'
              }
              sub={`${formatTokens(total.reasoningTokensEst)} tok`}
            />
            <Stat
              label="decode"
              value={total.decodeTokensPerSec ? `${total.decodeTokensPerSec.toFixed(0)}` : '—'}
              sub="tok/s"
            />
            <Stat
              label="cache write"
              value={formatTokens(total.cacheCreationTokens)}
              sub={`${formatTokens(total.cacheReadTokens)} read`}
            />
          </div>
        )}
        {total && total.tools.length > 0 && (
          <div className="mt-2">
            <ToolBar tools={total.tools} toolMs={total.toolMs} colors={colors} />
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5 text-[10px] font-mono text-ink-faint">
              {total.tools.map((t) => (
                <ToolLegendItem key={t.name} tool={t} colors={colors} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="overflow-y-auto px-5 py-2 flex-1 text-[11px]">
        {turns.length === 0 ? (
          <div className="text-ink-faint py-3">
            {inRun
              ? 'No turns yet. This participant gets a transcript once the run reaches one of its steps.'
              : 'No turns yet. Send a message and the breakdown appears here.'}
          </div>
        ) : (
          turns.map((t, i) => <TurnRow key={t.id} turn={t} index={i + 1} colors={colors} />)
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-card rounded py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="text-sm font-semibold text-ink tabular-nums">{value}</div>
      <div className="text-[10px] text-ink-faint tabular-nums">{sub}</div>
    </div>
  );
}

function TurnRow({
  turn,
  index,
  colors,
}: {
  turn: TurnTiming;
  index: number;
  colors: Map<string, string>;
}) {
  const modelPct = shareOfWork(turn.modelMs, turn);
  const toolPct = shareOfWork(turn.toolMs, turn);
  const reprefilled = turn.resumedColdCache;

  return (
    <div className="border-b border-card last:border-b-0 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-ink-faint shrink-0 tabular-nums w-5 text-right">{index}</span>
        <span className="text-ink-muted truncate flex-1">{turn.prompt || '(empty prompt)'}</span>
        <span className="text-ink font-medium tabular-nums shrink-0">
          {formatSeconds(turn.modelMs + turn.toolMs)}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-7 pt-1">
        <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-card">
          <div className="bg-accent" style={{ width: `${modelPct}%` }} title={`model ${formatSeconds(turn.modelMs)}`} />
          {/* The tool share is split by tool name rather than drawn as one
              block, so the widest slice names the tool to go fix. */}
          {turn.tools.map((t) => (
            <div
              key={t.name}
              style={{
                width: `${shareOfWork(t.ms, turn)}%`,
                backgroundColor: colors.get(t.name) ?? UNRANKED_TOOL_COLOR,
              }}
              title={`${shortToolName(t.name)} — ${formatSeconds(t.busyMs)} over ${t.calls} call${t.calls === 1 ? '' : 's'}, slowest ${formatSeconds(t.slowestMs)}`}
            />
          ))}
          {turn.tools.length === 0 && (
            <div
              className="bg-ink-faint"
              style={{ width: `${toolPct}%` }}
              title={`tools ${formatSeconds(turn.toolMs)}`}
            />
          )}
        </div>
        <span className="text-ink-faint tabular-nums shrink-0 font-mono">
          model {modelPct.toFixed(0)}% · tools {toolPct.toFixed(0)}%
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 pl-7 pt-1 text-ink-faint font-mono">
        <span>{turn.requests} req</span>
        <span>{turn.toolCalls} tools</span>
        <span>{formatTokens(turn.outputTokens)} out</span>
        <span>
          reasoning ~
          {turn.outputTokens > 0
            ? `${((turn.reasoningTokensEst / turn.outputTokens) * 100).toFixed(0)}%`
            : '—'}
        </span>
        {turn.decodeTokensPerSec !== null && (
          <span>{turn.decodeTokensPerSec.toFixed(0)} tok/s</span>
        )}
        {reprefilled && (
          <span className="text-amber-400" title="This turn opened on a cold cache — the backend respawned and resumed, re-prefilling the whole prefix.">
            cold resume {formatTokens(turn.cacheCreationTokens)}
          </span>
        )}
        {turn.models.length > 0 && <span>{turn.models.join(', ')}</span>}
      </div>
      {turn.tools.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-7 pt-1 text-ink-faint font-mono">
          {turn.tools.map((t) => (
            <ToolLegendItem key={t.name} tool={t} colors={colors} />
          ))}
        </div>
      )}
    </div>
  );
}

/// One tool's slice of the whole conversation's tool time.
function ToolBar({
  tools,
  toolMs,
  colors,
}: {
  tools: ToolTiming[];
  toolMs: number;
  colors: Map<string, string>;
}) {
  if (toolMs <= 0) return null;
  return (
    <div className="flex h-1.5 overflow-hidden rounded-full bg-card">
      {tools.map((t) => (
        <div
          key={t.name}
          style={{
            width: `${(t.ms / toolMs) * 100}%`,
            backgroundColor: colors.get(t.name) ?? UNRANKED_TOOL_COLOR,
          }}
          title={`${shortToolName(t.name)} — ${formatSeconds(t.busyMs)}`}
        />
      ))}
    </div>
  );
}

/// Color swatch + name + time. `busyMs` is shown rather than the rescaled
/// `ms` because "how long was this tool actually running" is the question
/// being asked; the rescaled value only exists to make bar widths add up.
function ToolLegendItem({ tool, colors }: { tool: ToolTiming; colors: Map<string, string> }) {
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`${tool.name} — ${tool.calls} call${tool.calls === 1 ? '' : 's'}, slowest ${formatSeconds(tool.slowestMs)}${tool.errors > 0 ? `, ${tool.errors} error${tool.errors === 1 ? '' : 's'}` : ''}`}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
        style={{ backgroundColor: colors.get(tool.name) ?? UNRANKED_TOOL_COLOR }}
      />
      <span className="text-ink-muted">{shortToolName(tool.name)}</span>
      <span className="tabular-nums">{formatSeconds(tool.busyMs)}</span>
      <span>×{tool.calls}</span>
      {tool.errors > 0 && <span className="text-amber-400">!{tool.errors}</span>}
    </span>
  );
}

function DiagnosticsTab() {
  const [entries, setEntries] = useState<SilentLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const next = await window.overcli.invoke('diagnostics:list');
    setEntries(next);
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const clear = async () => {
    await window.overcli.invoke('diagnostics:clear');
    await refresh();
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-5 pt-4 pb-3 border-b border-card flex items-baseline justify-between">
        <div>
          <div className="text-lg font-semibold">Diagnostics log</div>
          <div className="text-xs text-ink-faint">
            Log entries recorded during this session. Persistent log at <code>~/.overcli/session.log</code>.
            {' '}
            {entries.length > 0 && `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}.`}
          </div>
        </div>
        <div className="flex gap-2 text-[11px]">
          <button
            onClick={refresh}
            className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
          >
            refresh
          </button>
          <button
            onClick={clear}
            disabled={entries.length === 0}
            className="px-2 py-1 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink disabled:opacity-50 disabled:cursor-not-allowed"
          >
            clear
          </button>
        </div>
      </div>
      <div className="overflow-y-auto px-5 py-2 flex-1 font-mono text-[11px]">
        {loading ? (
          <div className="text-ink-faint py-3">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-ink-faint py-3">No silent failures recorded this session.</div>
        ) : (
          entries
            .slice()
            .reverse()
            .map((e, i) => (
              <div key={i} className="border-b border-card last:border-b-0 py-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-ink-faint shrink-0">
                    {new Date(e.timestamp).toISOString().slice(11, 23)}
                  </span>
                  <span className="text-ink-faint uppercase shrink-0">{e.level}</span>
                  <span className="text-accent font-medium">{e.scope}</span>
                  <span className="text-ink-muted truncate">{e.message}</span>
                </div>
                {e.stack && (
                  <pre className="text-ink-faint whitespace-pre-wrap break-all pl-5 pt-0.5">
                    {e.stack}
                  </pre>
                )}
              </div>
            ))
        )}
      </div>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
  query,
}: {
  event: StreamEvent;
  expanded: boolean;
  onToggle: () => void;
  query: string;
}) {
  const [copied, setCopied] = useState(false);
  const time = new Date(event.timestamp).toISOString().slice(11, 23);
  const preview = getPreview(event);

  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(event.raw);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="border-b border-card last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-start gap-2 py-1 text-left hover:bg-card/50 -mx-2 px-2 rounded"
      >
        <span className="text-ink-faint shrink-0 select-none">{expanded ? '▾' : '▸'}</span>
        <span className="text-ink-faint shrink-0">{time}</span>
        <span className="shrink-0 text-accent font-medium">{event.kind.type}</span>
        {!expanded && (
          <span className="text-ink-muted truncate flex-1">{highlight(preview, query)}</span>
        )}
      </button>
      {expanded && (
        <div className="relative pb-2 pl-5">
          <button
            onClick={copy}
            className="absolute top-0 right-0 text-[10px] px-2 py-0.5 rounded bg-card hover:bg-card-strong text-ink-muted hover:text-ink"
          >
            {copied ? 'copied' : 'copy'}
          </button>
          <pre className="text-ink-muted whitespace-pre-wrap break-all select-text pr-14">
            {highlight(event.raw, query)}
          </pre>
        </div>
      )}
    </div>
  );
}

function getPreview(e: StreamEvent): string {
  const k = e.kind;
  if (k.type === 'localUser') return k.text.slice(0, 200);
  if (k.type === 'assistant') return (k.info.text ?? '').slice(0, 200);
  if (k.type === 'systemNotice') return k.text.slice(0, 200);
  if (k.type === 'metaReminder') return k.text.slice(0, 200);
  if (k.type === 'taskNotification') return k.summary.slice(0, 200);
  if (k.type === 'stderr') return k.line.slice(0, 200);
  if (k.type === 'parseError') return k.message.slice(0, 200);
  if (k.type === 'other') return k.label;
  const oneLine = e.raw.replace(/\s+/g, ' ').trim();
  return oneLine.slice(0, 200);
}

function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={idx} className="bg-accent/40 text-ink rounded px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>,
    );
    i = idx + query.length;
  }
  return <>{parts}</>;
}
