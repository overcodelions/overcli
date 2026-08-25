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
  relativeTimelineWidth,
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
      <div className="px-4 py-3 border-b border-card bg-card/20 flex items-center gap-1 text-xs">
        <button
          onClick={() => setTab('timing')}
          className={
            'px-2.5 py-1.5 rounded-md font-medium transition-colors ' +
            (tab === 'timing' ? 'bg-card-strong text-ink shadow-sm' : 'text-ink-muted hover:bg-card/60 hover:text-ink')
          }
        >
          Timing
        </button>
        <button
          onClick={() => setTab('stream')}
          className={
            'px-2.5 py-1.5 rounded-md font-medium transition-colors ' +
            (tab === 'stream' ? 'bg-card-strong text-ink shadow-sm' : 'text-ink-muted hover:bg-card/60 hover:text-ink')
          }
        >
          Stream
        </button>
        <button
          onClick={() => setTab('diagnostics')}
          className={
            'px-2.5 py-1.5 rounded-md font-medium transition-colors ' +
            (tab === 'diagnostics' ? 'bg-card-strong text-ink shadow-sm' : 'text-ink-muted hover:bg-card/60 hover:text-ink')
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
                      : 'text-ink-muted hover:bg-card/60 hover:text-ink')
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
      <div className="px-4 pt-4 pb-3 border-b border-card">
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
      <div className="overflow-y-auto px-4 py-2 flex-1 font-mono text-[11px]">
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
  const [activeTurnNow, setActiveTurnNow] = useState(() => Date.now());
  useEffect(() => {
    if (!inRun) return;
    setActiveTurnNow(Date.now());
    const timer = window.setInterval(() => setActiveTurnNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [inRun]);
  const turns = useMemo(
    () => summarizeTurns(events, inRun ? activeTurnNow : undefined),
    [events, inRun, activeTurnNow],
  );
  const total = useMemo(() => totalTiming(turns), [turns]);
  // Ranked once across the whole conversation so a tool holds one color in
  // every turn, rather than being recoloured by each turn's local ordering.
  const colors = useMemo(() => toolColorRamp((total?.tools ?? []).map((t) => t.name)), [total]);
  const longestWallMs = useMemo(
    () => turns.reduce((longest, turn) => Math.max(longest, turn.wallMs), 0),
    [turns],
  );
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const header =
      'turn\twall\ttransport_ready\tfirst_response\tfirst_visible\tstreaming\tmodel\ttools\ttop_tool\tout_tok\treasoning_est\tdecode_tok_s\tcache_write';
    const body = turns.map((t, i) =>
      [
        i + 1,
        formatSeconds(t.wallMs),
        t.transportReadyMs === null ? '' : formatSeconds(t.transportReadyMs),
        t.firstResponseMs === null ? '' : formatSeconds(t.firstResponseMs),
        t.firstVisibleMs === null ? '' : formatSeconds(t.firstVisibleMs),
        t.streamingMs === null ? '' : formatSeconds(t.streamingMs),
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
      <div className="px-4 pt-4 pb-3 border-b border-card bg-surface-elevated">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold tracking-tight text-ink">Turn timing</h2>
              {turns.length > 0 && (
                <span className="rounded-full bg-card px-2 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint">
                  {turns.length} turn{turns.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="mt-0.5 max-w-4xl text-xs leading-relaxed text-ink-faint">
              Where this conversation spent its time. Model time is everything that isn&apos;t
              waiting on a tool; reasoning is estimated as output tokens minus visible prose and
              tool arguments.
            </div>
          </div>
          <button
            onClick={copy}
            disabled={turns.length === 0}
            className="shrink-0 rounded-md border border-card bg-card px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition-colors hover:bg-card-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {copied ? 'copied' : 'copy tsv'}
          </button>
        </div>
        {total && (
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center lg:grid-cols-5 xl:grid-cols-9">
            <Stat label="model" value={`${shareOfWork(total.modelMs, total).toFixed(0)}%`} sub={formatSeconds(total.modelMs)} tone="model" />
            <Stat label="tools" value={`${shareOfWork(total.toolMs, total).toFixed(0)}%`} sub={formatSeconds(total.toolMs)} tone="tools" />
            <Stat
              label="transport"
              value={total.transportReadyMs === null ? '—' : formatSeconds(total.transportReadyMs)}
              sub="ready avg"
            />
            <Stat
              label="first response"
              value={total.firstResponseMs === null ? '—' : formatSeconds(total.firstResponseMs)}
              sub="average"
            />
            <Stat
              label="visible text"
              value={total.firstVisibleMs === null ? '—' : formatSeconds(total.firstVisibleMs)}
              sub="average"
            />
            <Stat
              label="streaming"
              value={total.streamingMs === null ? '—' : formatSeconds(total.streamingMs)}
              sub="average"
            />
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
        {total && (
          <div className="mt-2 rounded-md border border-card bg-card/30 px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-ink-faint">
              <span className="inline-flex items-center gap-1.5" title="Waiting for or streaming a model response">
                <span className="inline-block h-2 w-3 rounded-sm bg-accent" />
                <span><span className="font-medium text-ink-muted">Model</span> activity</span>
              </span>
              <span className="inline-flex items-center gap-1.5" title="Tool colors rank total tool time within this conversation">
                <span className="inline-block h-2 w-6 rounded-sm bg-gradient-to-r from-red-500 via-amber-400 to-green-500" />
                <span><span className="font-medium text-ink-muted">Tool cost</span> slowest → fastest</span>
              </span>
              <span className="ml-auto">Bar length is relative to the longest turn · {formatSeconds(longestWallMs)}</span>
            </div>
            {total.tools.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 border-t border-card pt-2 text-[10px] font-mono text-ink-faint">
              {total.tools.map((t) => (
                <ToolLegendItem key={t.name} tool={t} colors={colors} />
              ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="overflow-y-auto px-4 py-2 flex-1 text-[11px]">
        {turns.length === 0 ? (
          <div className="text-ink-faint py-3">
            {inRun
              ? 'No turns yet. This participant gets a transcript once the run reaches one of its steps.'
              : 'No turns yet. Send a message and the breakdown appears here.'}
          </div>
        ) : (
          turns.map((t, i) => (
            <TurnRow
              key={t.id}
              turn={t}
              index={i + 1}
              colors={colors}
              longestWallMs={longestWallMs}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub: string;
  tone?: 'neutral' | 'model' | 'tools';
}) {
  return (
    <div className={'rounded-md border px-2 py-2 ' + (tone === 'model' ? 'border-accent/20 bg-accent/10' : tone === 'tools' ? 'border-amber-500/20 bg-amber-500/5' : 'border-card bg-card/60')}>
      <div className="text-[9px] font-medium uppercase tracking-[0.08em] text-ink-faint">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold leading-none text-ink tabular-nums">{value}</div>
      <div className="mt-1 text-[9px] leading-none text-ink-faint tabular-nums">{sub}</div>
    </div>
  );
}

function TurnRow({
  turn,
  index,
  colors,
  longestWallMs,
}: {
  turn: TurnTiming;
  index: number;
  colors: Map<string, string>;
  longestWallMs: number;
}) {
  const modelPct = shareOfWork(turn.modelMs, turn);
  const toolPct = shareOfWork(turn.toolMs, turn);
  const reprefilled = turn.resumedColdCache;
  const relativeWall = longestWallMs > 0 ? turn.wallMs / longestWallMs : 0;
  const isLongest = longestWallMs > 0 && turn.wallMs === longestWallMs;
  const isSlow = !isLongest && relativeWall >= 0.75;

  return (
    <div className="group rounded-md border-b border-card px-2 py-2.5 transition-colors last:border-b-0 hover:bg-card/30">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-4 shrink-0 text-left text-[10px] font-medium text-ink-faint tabular-nums">{index}</span>
          <span className="truncate text-xs font-medium text-ink-muted" title={turn.prompt || '(empty prompt)'}>{turn.prompt || '(empty prompt)'}</span>
        </div>
        <span
          className={'flex items-center gap-1.5 font-semibold tabular-nums ' + (isLongest || isSlow ? 'text-amber-400' : 'text-ink')}
          title={`${formatSeconds(turn.wallMs)} wall time`}
        >
          {isLongest && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide">longest</span>}
          {isSlow && <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide">slow</span>}
          {formatSeconds(turn.modelMs + turn.toolMs)}
        </span>
        <div className="col-span-2 mt-1.5 flex items-center gap-2">
          <RoundTripBar turn={turn} colors={colors} longestWallMs={longestWallMs} />
          <span className="w-28 shrink-0 text-right font-mono text-[10px] text-ink-faint tabular-nums">
            <span className="text-ink-muted">{modelPct.toFixed(0)}%</span> model · <span className="text-ink-muted">{toolPct.toFixed(0)}%</span> tools
          </span>
        </div>
        <div className="col-span-2 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-ink-faint">
          <span>{turn.requests} req</span>
          <span>{turn.toolCalls} tools</span>
          <span>{formatTokens(turn.outputTokens)} out</span>
          <span>reasoning ~{turn.outputTokens > 0 ? `${((turn.reasoningTokensEst / turn.outputTokens) * 100).toFixed(0)}%` : '—'}</span>
          {turn.decodeTokensPerSec !== null && <span>{turn.decodeTokensPerSec.toFixed(0)} tok/s</span>}
          {turn.firstResponseMs !== null && <span>model activity {formatSeconds(turn.firstResponseMs)}</span>}
          {turn.transportReadyMs !== null && <span>ready {formatSeconds(turn.transportReadyMs)}</span>}
          {turn.firstVisibleMs !== null && <span>visible {formatSeconds(turn.firstVisibleMs)}</span>}
          {turn.streamingMs !== null && <span>stream {formatSeconds(turn.streamingMs)}</span>}
          {turn.models.length > 0 && <span className="text-ink-muted">{turn.models.join(', ')}</span>}
        </div>
        {(turn.consolidationOpportunity || reprefilled) && (
          <div className="col-span-2 mt-2 flex flex-wrap gap-1.5">
            {turn.consolidationOpportunity && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-400" title="Repeated independent tool calls may be faster when combined into fewer, larger calls.">
                <span aria-hidden="true">↗</span>
                Batch opportunity · {shortToolName(turn.consolidationOpportunity.toolName)} ×{turn.consolidationOpportunity.calls} / {turn.consolidationOpportunity.rounds} rounds
              </span>
            )}
            {reprefilled && (
              <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-400" title="This turn opened on a cold cache — the backend respawned and resumed, re-prefilling the whole prefix.">
                <span aria-hidden="true">↻</span>
                Cold resume · {formatTokens(turn.cacheCreationTokens)} cache write
              </span>
            )}
          </div>
        )}
        {turn.tools.length > 0 && (
          <div className="col-span-2 mt-2 flex flex-wrap gap-1.5 font-mono text-[10px] text-ink-faint">
          {turn.tools.map((t) => (
            <ToolLegendItem key={t.name} tool={t} colors={colors} />
          ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RoundTripBar({
  turn,
  colors,
  longestWallMs,
}: {
  turn: TurnTiming;
  colors: Map<string, string>;
  longestWallMs: number;
}) {
  return (
    <div className="h-2.5 flex-1 overflow-hidden rounded-full border border-card bg-card-strong shadow-inner" aria-label={`Request round trip: ${formatSeconds(turn.wallMs)}`}>
      <div
        className="flex h-full overflow-hidden rounded-full transition-[filter] group-hover:brightness-110"
        style={{ width: `${relativeTimelineWidth(turn.wallMs, longestWallMs)}%` }}
        title={`${formatSeconds(turn.wallMs)} total; scaled against ${formatSeconds(longestWallMs)}`}
      >
        {turn.timeline.map((segment, index) => {
          const duration = segment.endMs - segment.startMs;
          const names = segment.toolNames.map(shortToolName);
          return (
            <div
              key={`${segment.startMs}-${segment.endMs}-${index}`}
              className={'cursor-help border-r border-surface/60 transition-[filter] last:border-r-0 hover:brightness-125 ' + (segment.kind === 'model' ? 'bg-accent' : '')}
              style={{
                width: `${turn.wallMs > 0 ? (duration / turn.wallMs) * 100 : 0}%`,
                backgroundColor:
                  segment.kind === 'tool'
                    ? colors.get(segment.toolNames[0]) ?? UNRANKED_TOOL_COLOR
                    : undefined,
              }}
              title={
                segment.kind === 'model'
                  ? `model · ${formatSeconds(duration)} · ${formatSeconds(segment.startMs)}–${formatSeconds(segment.endMs)}`
                  : `${names.join(' + ')} · ${formatSeconds(duration)} · ${formatSeconds(segment.startMs)}–${formatSeconds(segment.endMs)}`
              }
            />
          );
        })}
      </div>
    </div>
  );
}

/// Color swatch + name + time. `busyMs` is shown rather than the rescaled
/// `ms` because "how long was this tool actually running" is the question
/// being asked; the rescaled value only exists to make bar widths add up.
function ToolLegendItem({ tool, colors }: { tool: ToolTiming; colors: Map<string, string> }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-card bg-card/60 px-1.5 py-0.5 transition-colors hover:bg-card-strong"
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
      <div className="px-4 pt-4 pb-3 border-b border-card flex items-baseline justify-between">
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
      <div className="overflow-y-auto px-4 py-2 flex-1 font-mono text-[11px]">
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
