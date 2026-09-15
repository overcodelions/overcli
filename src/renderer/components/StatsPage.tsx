import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Backend,
  BackendQuota,
  DailyBucket,
  FlowImpactRow,
  ModelTier,
  ProjectGroupStats,
  QuotaWindow,
  RecentSession,
  RecentUsage,
  StatsReport,
  TierStats,
} from '@shared/types';
import { RANGE_DAYS, RANGE_KEYS, RangeKey, movingAverage, sliceRange } from './statsRange';
import { backendColor, backendFromModel, backendName } from '../theme';
import { useStore } from '../store';

export function StatsPage() {
  const [report, setReport] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<RangeKey>('30d');
  const [refreshingLimits, setRefreshingLimits] = useState(false);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    setLoading(true);
    try {
      const r = await window.overcli.invoke('app:reloadStats');
      setReport(r);
    } finally {
      setLoading(false);
    }
    void refreshLimits();
  }

  /// Claude publishes its quota nowhere on disk, so the only way to get it is
  /// to run `claude -p "/usage"` — ~6s. Do it after the page has already
  /// painted from the cached snapshot, then re-pull the report.
  async function refreshLimits() {
    setRefreshingLimits(true);
    try {
      if (await window.overcli.invoke('app:refreshClaudeUsage')) {
        setReport(await window.overcli.invoke('app:reloadStats'));
      }
    } catch {
      // Keep whatever the cached snapshot gave us.
    } finally {
      setRefreshingLimits(false);
    }
  }

  if (loading && !report) {
    return <div className="p-8 text-ink-muted text-sm">Loading usage stats…</div>;
  }
  if (!report) return null;

  const activeToday = report.byBackend.reduce((s, b) => s + b.sessionsToday, 0);
  const tokensLast7d = report.byBackend.reduce((s, b) => s + b.tokensLast7d, 0);
  const totalTokens = report.totalInputTokens + report.totalOutputTokens;
  const backends: Backend[] = report.byBackend.map((b) => b.backend);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="w-full px-6 2xl:px-10 py-7">
        {/* Header */}
        <div className="flex items-end gap-3 mb-7">
          <div>
            <div className="text-2xl font-semibold leading-none">Usage</div>
            <div className="text-xs text-ink-faint mt-1.5">
              All-time across every CLI · updated {formatClock(report.generatedAt)}
            </div>
          </div>
          <button
            onClick={reload}
            disabled={loading || refreshingLimits}
            className="ml-auto text-xs text-ink-muted hover:text-ink bg-card hover:bg-card-strong border border-card px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50"
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>

        {/* Hero metrics */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
          <StatTile label="Active today" value={String(activeToday)} hint="sessions touched" />
          <StatTile label="Sessions" value={fmtCompact(report.totalSessions)} hint="all time" />
          <StatTile label="Turns" value={fmtCompact(report.totalTurns)} hint="all time" />
          <StatTile label="Tokens" value={fmtCompact(totalTokens)} hint={`${fmtCompact(tokensLast7d)} in last 7d`} />
          <StatTile
            label="Lines changed"
            value={`+${fmtCompact(report.totalLinesAdded)}`}
            hint={`−${fmtCompact(report.totalLinesDeleted)} removed`}
            valueClass="text-emerald-500 dark:text-emerald-400"
          />
        </div>

        <QuotaBand quotas={report.quotas} refreshing={refreshingLimits} />

        {report.recent && <RecentUsagePanel recent={report.recent} />}

        {/* Model mix — the fast vs premium question */}
        <ModelMixPanel rows={report.byTier} />

        {/* Flow impact — the "are flows helping" question */}
        <FlowImpactPanel impact={report.flowImpact} />

        {/* Activity over time */}
        <Panel
          title="Activity over time"
          aside={
            <div className="flex items-center gap-4">
              <BackendLegend backends={backends} />
              <div className="flex items-center gap-px rounded-md overflow-hidden border border-card">
                {RANGE_KEYS.map((k) => (
                  <button
                    key={k}
                    onClick={() => setRange(k)}
                    className={`px-2 py-0.5 text-[11px] transition-colors ${
                      range === k ? 'bg-card-strong text-ink' : 'bg-card text-ink-faint hover:text-ink-muted'
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          }
        >
          <ActivityChart daily={sliceRange(report.daily, RANGE_DAYS[range])} backends={backends} metric="tokens" />
          <div className="h-3" />
          <ActivityChart daily={sliceRange(report.daily, RANGE_DAYS[range])} backends={backends} metric="turns" />
        </Panel>

        {/* Detail tables */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-6">
        <Panel title="By backend">
          <DataTable
            head={['Backend', 'Sessions', 'Turns', 'Input', 'Output', 'Cache', 'Lines', '5h', '24h', '7d']}
            align="lrrrrrrrrr"
          >
            {report.byBackend.map((b) => (
              <tr key={b.backend} className="border-t border-card hover:bg-card-strong/60 transition-colors">
                <Td>
                  <Dot color={backendColor(b.backend)} />
                  {backendName(b.backend)}
                </Td>
                <Td right>{b.sessions.toLocaleString()}</Td>
                <Td right>{b.turns.toLocaleString()}</Td>
                <Td right>{fmtCompact(b.inputTokens)}</Td>
                <Td right>{fmtCompact(b.outputTokens)}</Td>
                <Td right>{b.cacheRead ? fmtCompact(b.cacheRead) : '—'}</Td>
                <Td right>
                  <LinesCell added={b.linesAdded} deleted={b.linesDeleted} />
                </Td>
                <Td right faint>{fmtCompact(b.tokensLast5h)}</Td>
                <Td right faint>{fmtCompact(b.tokensLast24h)}</Td>
                <Td right faint>{fmtCompact(b.tokensLast7d)}</Td>
              </tr>
            ))}
          </DataTable>
        </Panel>

        <Panel title="By model">
          <DataTable
            head={['Model', 'Turns', 'Input', 'Output', 'Cache read', 'Cache write']}
            align="lrrrrr"
          >
            {report.byModel.map((m) => (
              <tr key={m.model} className="border-t border-card hover:bg-card-strong/60 transition-colors">
                <Td mono>
                  <Dot color={backendColor(backendFromModel(m.model))} />
                  {m.model}
                </Td>
                <Td right>{m.turns.toLocaleString()}</Td>
                <Td right>{fmtCompact(m.inputTokens)}</Td>
                <Td right>{fmtCompact(m.outputTokens)}</Td>
                <Td right>{fmtCompact(m.cacheRead)}</Td>
                <Td right>{fmtCompact(m.cacheCreation)}</Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
        </div>

        <ProjectPanel groups={report.projectGroups ?? []} />
      </div>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  repo: 'repo',
  worktree: 'worktrees',
  workspace: 'workspace',
  flow: 'flow',
  other: 'other',
};

function ProjectPanel({ groups }: { groups: ProjectGroupStats[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const top = groups.slice(0, 25);
  const max = Math.max(1, ...top.map((g) => g.outputTokens));
  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <Panel
      title="By project"
      aside={<span className="text-ink-faint">worktrees and flow runs rolled into their project · top 25 by output</span>}
    >
      <DataTable head={['Project', 'Share', 'Sessions', 'Turns', 'Input', 'Output', 'Lines']} align="llrrrrr">
        {top.map((g) => {
          const expandable = g.children.length > 1;
          const isOpen = open.has(g.id);
          return (
            <Fragment key={g.id}>
              <tr
                className={`border-t border-card hover:bg-card-strong/60 transition-colors ${expandable ? 'cursor-pointer' : ''}`}
                onClick={expandable ? () => toggle(g.id) : undefined}
              >
                <Td>
                  <span className="inline-block w-3 text-ink-faint">{expandable ? (isOpen ? '▾' : '▸') : ''}</span>
                  <span className="truncate max-w-[300px] inline-block align-middle">{g.name}</span>
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-faint">
                    {KIND_LABEL[g.kind] ?? g.kind}
                    {expandable ? ` · ${g.children.length}` : ''}
                  </span>
                </Td>
                <Td>
                  <div className="h-1.5 w-24 rounded bg-card-strong overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.round((g.outputTokens / max) * 100)}%` }}
                    />
                  </div>
                </Td>
                <Td right>{g.sessions.toLocaleString()}</Td>
                <Td right>{g.turns.toLocaleString()}</Td>
                <Td right>{fmtCompact(g.inputTokens)}</Td>
                <Td right>{fmtCompact(g.outputTokens)}</Td>
                <Td right>
                  <LinesCell added={g.linesAdded} deleted={g.linesDeleted} />
                </Td>
              </tr>
              {expandable && isOpen
                ? g.children.map((c) => (
                    <tr key={c.id} className="border-t border-card/50 bg-card-strong/20">
                      <Td faint>
                        <span className="inline-block w-6" />
                        <span className="truncate max-w-[280px] inline-block align-middle">
                          {c.leafName || c.name}
                        </span>
                      </Td>
                      <Td>{''}</Td>
                      <Td right faint>{c.sessions.toLocaleString()}</Td>
                      <Td right faint>{c.turns.toLocaleString()}</Td>
                      <Td right faint>{fmtCompact(c.inputTokens)}</Td>
                      <Td right faint>{fmtCompact(c.outputTokens)}</Td>
                      <Td right faint>
                        <LinesCell added={c.linesAdded} deleted={c.linesDeleted} />
                      </Td>
                    </tr>
                  ))
                : null}
            </Fragment>
          );
        })}
      </DataTable>
    </Panel>
  );
}

function QuotaBand({ quotas, refreshing }: { quotas: BackendQuota[]; refreshing?: boolean }) {
  if (quotas.length === 0) return null;
  return (
    <Panel
      title="Limits right now"
      aside={
        <span className="text-ink-faint">
          {refreshing ? 'checking limits…' : 'reported where the CLI tells us, otherwise counted from transcripts'}
        </span>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {quotas.map((q) => (
          <div key={q.backend} className="rounded-lg bg-card border border-card p-4">
            <div className="flex items-center gap-2">
              <Dot color={backendColor(q.backend)} />
              <span className="text-sm font-medium">{backendName(q.backend)}</span>
              <span
                className={`ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  q.source === 'reported' ? 'bg-card-strong text-ink-muted' : 'text-ink-faint'
                }`}
              >
                {q.source === 'reported' ? (q.planType ?? 'reported') : 'estimated'}
                {q.source === 'reported' && q.stale ? ' · stale' : ''}
              </span>
            </div>
            <div className="mt-3 space-y-3">
              {q.windows.map((w) => (
                <div key={w.label}>
                  <div className="flex items-baseline justify-between text-[11px] text-ink-faint">
                    <span>{w.label}</span>
                    <span className="tabular-nums text-ink-muted">
                      {w.usedPercent !== null ? `${Math.round(w.usedPercent)}%` : fmtCompact(w.tokens)}
                    </span>
                  </div>
                  {w.usedPercent !== null && (
                    <div className="mt-1 h-1.5 w-full rounded-full bg-card-strong overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(100, Math.max(0, w.usedPercent))}%`,
                          background: w.usedPercent >= 85 ? '#f43f5e' : w.usedPercent >= 60 ? '#f59e0b' : backendColor(q.backend),
                        }}
                      />
                    </div>
                  )}
                  <div className="text-[10px] text-ink-faint mt-1 tabular-nums">
                    {w.usedPercent !== null ? `${fmtCompact(w.tokens)} tokens` : ''}
                    {w.usedPercent !== null && resetText(w) ? ' · ' : ''}
                    {resetText(w)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/// Codex reports an epoch we can count down to; claude prints a preformatted
/// string with no year. An elapsed countdown means the snapshot outlived its
/// own window, which is worth saying out loud rather than rendering "in —".
function resetText(w: QuotaWindow): string {
  if (w.resetsAt) {
    return w.resetsAt > Date.now()
      ? `resets in ${formatDurationMs(w.resetsAt - Date.now())}`
      : 'window has since reset';
  }
  if (w.resetsLabel) return `resets ${w.resetsLabel}`;
  return '';
}

/// Trailing 7-day mean, drawn over the bars so the long-term trend reads
/// through daily spikes.
function TrendLine({ values, max }: { values: number[]; max: number }) {
  if (values.length < 2 || max <= 0) return null;
  const avg = movingAverage(values, 7);
  const points = avg
    .map((v, i) => `${(i / (avg.length - 1)) * 100},${100 - Math.min(100, (v / max) * 100)}`)
    .join(' ');
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="0.6" vectorEffect="non-scaling-stroke" className="text-ink-faint" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Last 8 hours — where a limit went                                  */
/* ------------------------------------------------------------------ */

/// Fixed slot order; the heaviest session takes slot 1. Everything past the
/// last slot folds into "Other" rather than inventing a sixth hue.
const SESSION_SLOTS = 5;
const OTHER_COLOR = 'var(--c-ink-faint)';

function RecentUsagePanel({ recent }: { recent: RecentUsage }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const selectConversation = useStore((s) => s.selectConversation);

  /// Claude session id → the overcli conversation that owns it, for the
  /// row name and click-through.
  const convBySession = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const p of projects) {
      for (const c of p.conversations) if (c.sessionId) m.set(c.sessionId, { id: c.id, name: c.name });
    }
    for (const w of workspaces) {
      for (const c of w.conversations ?? []) if (c.sessionId) m.set(c.sessionId, { id: c.id, name: c.name });
    }
    return m;
  }, [projects, workspaces]);

  const totalCost = recent.buckets.reduce((s, b) => s + b.costUSD, 0);
  if (totalCost === 0) {
    return (
      <Panel title="Last 8 hours">
        <EmptyState>No Claude activity in the last 8 hours.</EmptyState>
      </Panel>
    );
  }

  const top = recent.sessions.slice(0, SESSION_SLOTS);
  const colorFor = (id: string) => {
    const i = top.findIndex((s) => s.id === id);
    return i >= 0 ? `var(--c-viz-${i + 1})` : OTHER_COLOR;
  };
  const nameFor = (s: RecentSession | undefined, id: string) =>
    convBySession.get(id)?.name ?? s?.title ?? (s ? leafName(s.projectPath) : id.slice(0, 8));
  const sessionById = new Map(recent.sessions.map((s) => [s.id, s]));
  const totalTokens = recent.buckets.reduce((s, b) => s + b.tokens, 0);
  const totalTurns = recent.sessions.reduce((s, x) => s + x.turns, 0);
  const totalSubagents = recent.sessions.reduce((s, x) => s + x.subagents, 0);
  const cacheReadTokenPct = totalTokens > 0 ? (recent.byType.cacheRead.tokens / totalTokens) * 100 : 0;

  return (
    <Panel
      title="Last 8 hours"
      aside={
        <span className="text-ink-faint tabular-nums">
          Claude · {formatClock(recent.start)} – {formatClock(recent.end)} · weighted by estimated API cost
        </span>
      }
    >
      {recent.limitWindow && (
        <LimitBanner recent={recent} nameFor={(id) => nameFor(sessionById.get(id), id)} />
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        <StatTile
          label="Estimated cost"
          value={fmtUSD(totalCost)}
          hint={`${fmtCompact(totalTokens)} tokens · ${Math.round(cacheReadTokenPct)}% cache reads`}
        />
        <StatTile
          label="Turns"
          value={totalTurns.toLocaleString()}
          hint={`${recent.sessions.length} sessions · ${totalSubagents} subagents`}
        />
      </div>

      <RecentChart recent={recent} top={top} colorFor={colorFor} nameFor={nameFor} sessionById={sessionById} />

      <div className="h-6" />

      <Panel title="Where it went" aside={<span className="text-ink-faint">sessions ranked by estimated cost · click to open</span>}>
        <DataTable
          head={['Session', 'Model', 'Share', 'Turns', 'Subagents', 'Context / turn', 'Output', 'Cache read', 'Est. cost']}
          align="lllrrrrrr"
        >
          {recent.sessions.slice(0, 10).map((s) => {
            const conv = convBySession.get(s.id);
            return (
              <tr
                key={s.id}
                className={`border-t border-card hover:bg-card-strong/60 transition-colors ${conv ? 'cursor-pointer' : ''}`}
                onClick={conv ? () => selectConversation(conv.id) : undefined}
                title={conv ? 'Open conversation' : undefined}
              >
                <Td>
                  <div className="flex items-center min-w-0">
                    <Dot color={colorFor(s.id)} />
                    <div className="min-w-0">
                      <div className="truncate max-w-[340px]">{nameFor(s, s.id)}</div>
                      <div className="text-[11px] text-ink-faint tabular-nums">
                        {leafName(s.projectPath)} · {formatClock(s.firstTs)}–{formatClock(s.lastTs)}
                      </div>
                    </div>
                  </div>
                </Td>
                <Td mono faint>{s.models.map(shortModel).join(', ')}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 rounded bg-card-strong overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${(s.costUSD / top[0].costUSD) * 100}%` }} />
                    </div>
                    <span className="text-[11px] text-ink-muted tabular-nums">
                      {Math.round((s.costUSD / totalCost) * 100)}%
                    </span>
                  </div>
                </Td>
                <Td right>{s.turns.toLocaleString()}</Td>
                <Td right>{s.subagents ? s.subagents : '—'}</Td>
                <Td right>
                  <span className={s.avgContextTokens >= 150_000 ? 'text-amber-500 dark:text-amber-400' : ''}>
                    {s.turns ? fmtCompact(s.avgContextTokens) : '—'}
                  </span>
                </Td>
                <Td right>{fmtCompact(s.outputTokens)}</Td>
                <Td right>{fmtCompact(s.cacheReadTokens)}</Td>
                <Td right>
                  <span className="font-medium">{fmtUSD(s.costUSD)}</span>
                </Td>
              </tr>
            );
          })}
        </DataTable>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-6">
        <TokenTypePanel recent={recent} totalCost={totalCost} totalTokens={totalTokens} />
        <Panel title="Heaviest turns" aside={<span className="text-ink-faint">single replies, costliest first</span>}>
          <DataTable head={['Time', 'Session', 'Tools', 'Tokens', 'Est. cost']} align="lllrr">
            {recent.heaviestTurns.map((t, i) => (
              <tr key={`${t.sessionId}-${t.ts}-${i}`} className="border-t border-card hover:bg-card-strong/60 transition-colors">
                <Td faint>{formatClock(t.ts)}</Td>
                <Td>
                  <div className="flex items-center min-w-0">
                    <Dot color={colorFor(t.sessionId)} />
                    <span className="truncate max-w-[200px]">{nameFor(sessionById.get(t.sessionId), t.sessionId)}</span>
                    {t.isSubagent && <span className="ml-2 text-[10px] uppercase tracking-wider text-ink-faint">subagent</span>}
                  </div>
                </Td>
                <Td faint>
                  <span className="truncate max-w-[220px] inline-block align-middle">{t.tools.join(', ') || '—'}</span>
                </Td>
                <Td right>{fmtCompact(t.tokens)}</Td>
                <Td right>
                  <span className="font-medium">{fmtUSD(t.costUSD)}</span>
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>
    </Panel>
  );
}

function LimitBanner({ recent, nameFor }: { recent: RecentUsage; nameFor: (id: string) => string }) {
  const lw = recent.limitWindow!;
  // Cost that landed inside the window, and which session carried most of it.
  const inWindow = recent.buckets.filter((b) => b.start + recent.bucketMs > lw.start && b.start < lw.resetsAt);
  const windowCost = inWindow.reduce((s, b) => s + b.costUSD, 0);
  const perSession = new Map<string, number>();
  for (const b of inWindow) {
    for (const [id, c] of Object.entries(b.bySession)) perSession.set(id, (perSession.get(id) ?? 0) + c);
  }
  const [topId, topCost] = Array.from(perSession.entries()).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const hit = lw.usedPercent >= 100;
  const hot = lw.usedPercent >= 85;
  const past = lw.resetsAt <= Date.now();

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3.5 py-2.5 mb-3 text-xs ${
        hot ? 'border-rose-500/35 bg-rose-500/[0.07]' : 'border-card bg-card'
      }`}
    >
      <span className="tabular-nums">
        {hit
          ? `Claude's 5-hour limit was reached — window ${formatClock(lw.start)}–${formatClock(lw.resetsAt)}`
          : `Claude's 5-hour window is ${Math.round(lw.usedPercent)}% used — ${past ? 'reset at' : 'resets'} ${formatClock(lw.resetsAt)}`}
      </span>
      {windowCost > 0 && topId && (
        <span className="ml-auto text-ink-muted">
          <span className="text-ink font-medium tabular-nums">{Math.round((topCost / windowCost) * 100)}%</span> of it went to{' '}
          <span className="text-ink">{nameFor(topId)}</span>
        </span>
      )}
    </div>
  );
}

function RecentChart({
  recent,
  top,
  colorFor,
  nameFor,
  sessionById,
}: {
  recent: RecentUsage;
  top: RecentSession[];
  colorFor: (id: string) => string;
  nameFor: (s: RecentSession | undefined, id: string) => string;
  sessionById: Map<string, RecentSession>;
}) {
  const range = recent.end - recent.start;
  const pct = (ts: number) => `${Math.min(100, Math.max(0, ((ts - recent.start) / range) * 100))}%`;
  const axisMax = niceCeil(Math.max(...recent.buckets.map((b) => b.costUSD)));
  const topIds = new Set(top.map((s) => s.id));
  const lw = recent.limitWindow;

  const ticks: number[] = [];
  const firstHour = new Date(recent.start);
  firstHour.setMinutes(0, 0, 0);
  for (let t = firstHour.getTime() + 3600_000; t < recent.end; t += 3600_000) ticks.push(t);

  return (
    <div className="rounded-lg bg-card border border-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Estimated cost per 15 minutes · by session</span>
        <div className="flex flex-wrap items-center gap-3 text-[11px] text-ink-muted">
          {top.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colorFor(s.id) }} />
              <span className="truncate max-w-[160px]">{nameFor(s, s.id)}</span>
            </div>
          ))}
          {recent.sessions.length > top.length && (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm" style={{ background: OTHER_COLOR }} />
              <span>Other</span>
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-2.5">
        <div className="w-10 flex flex-col justify-between text-right text-[9px] text-ink-faint tabular-nums pt-4">
          <span>{fmtUSD(axisMax)}</span>
          <span>{fmtUSD(axisMax / 2)}</span>
          <span>$0</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="relative h-4 text-[9px] tabular-nums">
            {lw && lw.start > recent.start && (
              <span className="absolute text-accent whitespace-nowrap pl-1" style={{ left: pct(lw.start) }}>
                5h window
              </span>
            )}
            {lw && lw.resetsAt < recent.end && (
              <span
                className={`absolute -translate-x-full whitespace-nowrap pr-1 ${lw.usedPercent >= 100 ? 'text-rose-500' : 'text-accent'}`}
                style={{ left: pct(lw.resetsAt) }}
              >
                resets {formatClock(lw.resetsAt)}
              </span>
            )}
          </div>
          <div className="relative h-40 border-b border-card-strong">
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-card" />
            <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-card" />
            {lw && (
              <div
                className="absolute inset-y-0 bg-accent/[0.06] border-l border-accent/35"
                style={{ left: pct(lw.start), width: `calc(${pct(lw.resetsAt)} - ${pct(lw.start)})` }}
              />
            )}
            {lw && lw.resetsAt < recent.end && (
              <div
                className={`absolute inset-y-0 border-l-[1.5px] ${lw.usedPercent >= 100 ? 'border-rose-500' : 'border-accent'}`}
                style={{ left: pct(lw.resetsAt) }}
              />
            )}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {recent.buckets.map((b) => {
                const entries = Object.entries(b.bySession);
                const topSegs = top
                  .map((s) => ({ id: s.id, cost: b.bySession[s.id] ?? 0 }))
                  .filter((x) => x.cost > 0);
                const other = entries.filter(([id]) => !topIds.has(id)).reduce((s, [, c]) => s + c, 0);
                const tip =
                  `${formatClock(b.start)} · ${fmtUSD(b.costUSD)} · ${fmtCompact(b.tokens)} tokens` +
                  entries
                    .sort((x, y) => y[1] - x[1])
                    .map(([id, c]) => `\n${nameFor(sessionById.get(id), id)}: ${fmtUSD(c)}`)
                    .join('');
                return (
                  <div key={b.start} className="flex-1 h-full relative group" title={b.costUSD > 0 ? tip : formatClock(b.start)}>
                    <div
                      className="absolute bottom-0 w-full rounded-t-[4px] overflow-hidden flex flex-col-reverse gap-px opacity-90 group-hover:opacity-100 transition-opacity"
                      style={{ height: `${(b.costUSD / axisMax) * 100}%`, minHeight: b.costUSD > 0 ? 2 : 0 }}
                    >
                      {topSegs.map((x) => (
                        <div key={x.id} className="shrink-0" style={{ height: `${(x.cost / b.costUSD) * 100}%`, background: colorFor(x.id) }} />
                      ))}
                      {other > 0 && (
                        <div className="shrink-0" style={{ height: `${(other / b.costUSD) * 100}%`, background: OTHER_COLOR }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="relative h-4 mt-1.5 text-[9px] text-ink-faint tabular-nums">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pct(t) }}>
                {formatClock(t)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const TOKEN_TYPES: Array<{ key: keyof RecentUsage['byType']; label: string; fill: string }> = [
  { key: 'cacheRead', label: 'Cache read', fill: 'bg-accent' },
  { key: 'cacheWrite', label: 'Cache write', fill: 'bg-accent/70' },
  { key: 'output', label: 'Output', fill: 'bg-accent/45' },
  { key: 'input', label: 'Input', fill: 'bg-accent/25' },
];

function TokenTypePanel({
  recent,
  totalCost,
  totalTokens,
}: {
  recent: RecentUsage;
  totalCost: number;
  totalTokens: number;
}) {
  const cr = recent.byType.cacheRead;
  const crTokenPct = totalTokens > 0 ? Math.round((cr.tokens / totalTokens) * 100) : 0;
  const crCostPct = totalCost > 0 ? Math.round((cr.costUSD / totalCost) * 100) : 0;
  return (
    <Panel title="Cost by token type" aside={<span className="text-ink-faint">tokens don't all weigh the same</span>}>
      <div className="rounded-lg bg-card border border-card p-4">
        <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-card-strong">
          {TOKEN_TYPES.map((t) => {
            const share = (recent.byType[t.key].costUSD / totalCost) * 100;
            return share > 0 ? (
              <div key={t.key} className={t.fill} style={{ width: `${share}%` }} title={`${t.label}: ${share.toFixed(1)}%`} />
            ) : null;
          })}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          {TOKEN_TYPES.map((t) => {
            const v = recent.byType[t.key];
            return (
              <div key={t.key}>
                <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <span className={`w-2 h-2 rounded-sm ${t.fill}`} />
                  {t.label}
                </div>
                <div className="text-lg leading-none mt-1.5 tabular-nums">{fmtUSD(v.costUSD)}</div>
                <div className="text-[11px] text-ink-faint mt-1 tabular-nums">
                  {Math.round((v.costUSD / totalCost) * 100)}% · {fmtCompact(v.tokens)} tokens
                </div>
              </div>
            );
          })}
        </div>
        {crTokenPct >= 50 && (
          <div className="mt-4 pt-3 border-t border-card text-[11px] leading-relaxed text-ink-muted">
            {crTokenPct}% of tokens were cache reads but only {crCostPct}% of the cost — that's the context each reply
            re-sends. It adds up in long sessions; compacting or starting fresh keeps it down.
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Model mix — fast vs premium                                        */
/* ------------------------------------------------------------------ */

const TIER_LABEL: Record<ModelTier, string> = {
  frontier: 'Frontier',
  thinking: 'Thinking',
  standard: 'Standard',
  fast: 'Fast',
  local: 'Local',
};

const TIER_SUBLABEL: Record<ModelTier, string> = {
  frontier: 'most advanced',
  thinking: 'premium reasoning',
  standard: 'balanced',
  fast: 'low-latency',
  local: 'on-device',
};

const TIER_COLOR: Record<ModelTier, string> = {
  frontier: '#c084fc',
  thinking: '#f59e0b',
  standard: '#38bdf8',
  fast: '#34d399',
  local: '#94a3b8',
};

const TIER_ORDER: ModelTier[] = ['frontier', 'thinking', 'standard', 'fast', 'local'];

function ModelMixPanel({ rows }: { rows: TierStats[] }) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)),
    [rows],
  );
  const totalTokens = sorted.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const premium = sorted
    .filter((r) => r.tier === 'thinking')
    .reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  const premiumPct = totalTokens > 0 ? Math.round((premium / totalTokens) * 100) : 0;

  return (
    <Panel
      title="Model mix"
      aside={
        totalTokens > 0 ? (
          <span className="text-ink-faint">
            <span className="text-ink-muted font-medium">{premiumPct}%</span> premium tokens
          </span>
        ) : null
      }
    >
      {totalTokens === 0 ? (
        <EmptyState>No model usage recorded yet.</EmptyState>
      ) : (
        <div className="rounded-lg bg-card border border-card p-4">
          {/* Share bar */}
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-card-strong">
            {sorted.map((r) => {
              const tokens = r.inputTokens + r.outputTokens;
              const pct = (tokens / totalTokens) * 100;
              if (pct <= 0) return null;
              return (
                <div
                  key={r.tier}
                  style={{ width: `${pct}%`, background: TIER_COLOR[r.tier] }}
                  title={`${TIER_LABEL[r.tier]}: ${pct.toFixed(1)}%`}
                />
              );
            })}
          </div>

          {/* Per-tier cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            {sorted.map((r) => {
              const tokens = r.inputTokens + r.outputTokens;
              const pct = totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;
              return (
                <div key={r.tier} className="rounded-md bg-card-strong/50 border border-card p-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: TIER_COLOR[r.tier] }}
                    />
                    <span className="text-sm font-medium">{TIER_LABEL[r.tier]}</span>
                    <span className="ml-auto text-sm tabular-nums text-ink-muted">
                      {pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint mt-0.5">
                    {TIER_SUBLABEL[r.tier]}
                  </div>
                  <div className="mt-2 text-lg leading-none tabular-nums">{fmtCompact(tokens)}</div>
                  <div className="text-[11px] text-ink-faint mt-1">
                    {fmtCompact(r.turns)} turns · {fmtCompact(r.cacheRead)} cache
                  </div>
                  <div className="text-[10px] text-ink-faint mt-1.5 truncate" title={r.models.join(', ')}>
                    {r.models.join(', ')}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Flow impact                                                        */
/* ------------------------------------------------------------------ */

function FlowImpactPanel({ impact }: { impact: StatsReport['flowImpact'] }) {
  const tokens = impact.totalInputTokens + impact.totalOutputTokens;
  const avgRunMs =
    impact.completedRuns > 0 ? Math.round(impact.totalWallClockMs / impact.completedRuns) : 0;
  const hasRuns = impact.totalRuns > 0;

  return (
    <Panel
      title="Flow impact"
      aside={
        hasRuns ? (
          <span className="text-ink-faint">
            <span className="text-ink-muted font-medium">{impact.completedRuns}</span> of{' '}
            {impact.totalRuns} runs complete
          </span>
        ) : null
      }
    >
      {!hasRuns ? (
        <EmptyState>No flow runs yet — launch a flow to see its impact here.</EmptyState>
      ) : (
        <div className="rounded-lg bg-card border border-card overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-px bg-card-strong">
            <MiniStat label="Runs" value={fmtCompact(impact.totalRuns)} />
            <MiniStat label="Turns" value={fmtCompact(impact.totalTurns)} />
            <MiniStat label="Tokens" value={fmtCompact(tokens)} />
            <MiniStat label="Cost" value={`$${impact.totalCostUSD.toFixed(2)}`} />
            <MiniStat label="Avg / run" value={formatDurationMs(avgRunMs)} accent />
          </div>
          {impact.byFlow.length > 0 && (
            <DataTable
              head={['Flow', 'Runs', 'Turns', 'Input', 'Output', 'Cost', 'Wall-clock', 'Avg / run']}
              align="lrrrrrrr"
              flush
            >
              {impact.byFlow.slice(0, 40).map((r) => (
                <tr key={r.flowId} className="border-t border-card hover:bg-card-strong/60 transition-colors">
                  <Td>
                    <span className="truncate max-w-[240px] inline-block align-middle">{r.flowName}</span>
                  </Td>
                  <Td right>
                    {r.completedRuns}/{r.runs}
                  </Td>
                  <Td right>{r.turns.toLocaleString()}</Td>
                  <Td right>{fmtCompact(r.inputTokens)}</Td>
                  <Td right>{fmtCompact(r.outputTokens)}</Td>
                  <Td right>${r.costUSD.toFixed(2)}</Td>
                  <Td right>{formatDurationMs(r.wallClockMs)}</Td>
                  <Td right faint>{formatDurationMs(r.runs > 0 ? Math.round(r.wallClockMs / r.runs) : 0)}</Td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* Activity chart                                                     */
/* ------------------------------------------------------------------ */

/// Stacked bar chart — one column per day, one segment per backend.
/// Linear y-axis: a bar's height is its true share of the busiest day, so
/// weekly rhythm and outliers read honestly (the previous sqrt scale
/// compressed peaks and made quiet days look louder than they were).
function ActivityChart({
  daily,
  backends,
  metric,
}: {
  daily: DailyBucket[];
  backends: Backend[];
  metric: 'tokens' | 'turns';
}) {
  const rows = useMemo(
    () => daily.map((d) => computeRow(d, backends, metric)),
    [daily, backends, metric],
  );
  const max = Math.max(1, ...rows.map((r) => r.total));
  const totals = rows.reduce((sum, r) => sum + r.total, 0);
  const nonZeroDays = rows.filter((r) => r.total > 0).length;
  const avg = nonZeroDays > 0 ? Math.round(totals / nonZeroDays) : 0;
  const metricLabel = metric === 'tokens' ? 'Tokens' : 'Turns';
  const unitLabel = metric === 'tokens' ? 'tokens' : 'turns';

  if (totals === 0) {
    return <EmptyState>No {unitLabel} in the last {daily.length} days.</EmptyState>;
  }

  const scale = (v: number) => (v <= 0 ? 0 : (v / max) * 100);
  // A year of bars won't fit at 3px + 2px gap, and flex won't shrink past a
  // min-width, so it would overflow the panel instead. Go hairline past ~4
  // months.
  const dense = rows.length > 120;

  return (
    <div className="rounded-lg bg-card border border-card p-4">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint mb-3">
        <span>{metricLabel} per day</span>
        <span className="normal-case tracking-normal tabular-nums">
          {rows.length} days · peak {fmtCompact(max)} · avg {fmtCompact(avg)} / active day
        </span>
      </div>
      <div className={`relative flex items-end h-32 ${dense ? 'gap-px' : 'gap-[2px]'}`}>
        <TrendLine values={rows.map((r) => r.total)} max={max} />
        {rows.map((row) => {
          const h = scale(row.total);
          const breakdownSummary = row.breakdown
            .filter((b) => b.value > 0)
            .map((b) => `${backendName(b.backend)}: ${b.value.toLocaleString()}`)
            .join('\n');
          const title =
            `${row.day} · ${row.total.toLocaleString()} ${unitLabel}` +
            (breakdownSummary ? `\n${breakdownSummary}` : '');
          return (
            <div
              key={row.day}
              className="flex-1 relative h-full group"
              style={{ minWidth: dense ? 1 : 3 }}
              title={title}
            >
              <div
                className="absolute bottom-0 w-full rounded-sm overflow-hidden flex flex-col-reverse opacity-90 group-hover:opacity-100 transition-opacity"
                style={{ height: `${h}%`, minHeight: row.total > 0 ? 2 : 0 }}
              >
                {row.breakdown.map((b) => {
                  const pct = row.total > 0 ? (b.value / row.total) * 100 : 0;
                  if (pct <= 0) return null;
                  return (
                    <div
                      key={b.backend}
                      style={{ height: `${pct}%`, background: backendColor(b.backend) }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-ink-faint mt-2 tabular-nums">
        <span>{daily[0]?.day ?? ''}</span>
        <span>
          total {fmtCompact(totals)} {unitLabel}
        </span>
        <span>{daily[daily.length - 1]?.day ?? ''} (today)</span>
      </div>
    </div>
  );
}

function computeRow(
  d: DailyBucket,
  backends: Backend[],
  metric: 'tokens' | 'turns',
): { day: string; total: number; breakdown: Array<{ backend: Backend; value: number }> } {
  const bb = d.byBackend ?? {};
  const breakdown = backends.map((b) => {
    const slot = bb[b];
    const value = !slot
      ? 0
      : metric === 'tokens'
        ? slot.inputTokens + slot.outputTokens
        : slot.turns;
    return { backend: b, value };
  });
  const total = breakdown.reduce((s, x) => s + x.value, 0);
  return { day: d.day, total, breakdown };
}

/* ------------------------------------------------------------------ */
/* Primitives                                                         */
/* ------------------------------------------------------------------ */

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-2.5">
        <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-medium">{title}</h2>
        <div className="text-[11px] normal-case tracking-normal">{aside}</div>
      </div>
      {children}
    </section>
  );
}

function StatTile({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg bg-card border border-card p-3.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={`text-2xl mt-1.5 leading-none tabular-nums ${valueClass ?? ''}`}>{value}</div>
      {hint && <div className="text-[11px] text-ink-faint mt-1.5">{hint}</div>}
    </div>
  );
}

function MiniStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={`text-xl mt-1 leading-none tabular-nums ${accent ? 'text-accent' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function DataTable({
  head,
  align,
  children,
  flush,
}: {
  head: string[];
  /// One char per column: 'l' left, 'r' right.
  align: string;
  children: React.ReactNode;
  /// Drop the outer card frame (used when nested inside another card).
  flush?: boolean;
}) {
  return (
    <div className={flush ? 'overflow-hidden' : 'rounded-lg bg-card border border-card overflow-hidden'}>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-ink-faint bg-card-strong/40">
            {head.map((h, i) => (
              <th
                key={h}
                className={`font-normal px-3 py-2 ${align[i] === 'r' ? 'text-right' : 'text-left'}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Td({
  children,
  right,
  faint,
  mono,
}: {
  children: React.ReactNode;
  right?: boolean;
  faint?: boolean;
  mono?: boolean;
}) {
  return (
    <td
      className={
        'px-3 py-1.5 ' +
        (right ? 'text-right tabular-nums ' : '') +
        (faint ? 'text-ink-faint ' : '') +
        (mono ? 'font-mono ' : '')
      }
    >
      {children}
    </td>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-sm mr-2 align-middle"
      style={{ background: color }}
    />
  );
}

function LinesCell({ added, deleted }: { added: number; deleted: number }) {
  if (added === 0 && deleted === 0) return <span className="text-ink-faint">—</span>;
  return (
    <span className="font-mono tabular-nums">
      <span className="text-emerald-500 dark:text-emerald-400">+{fmtCompact(added)}</span>
      <span className="text-ink-faint"> / </span>
      <span className="text-rose-500 dark:text-rose-400">−{fmtCompact(deleted)}</span>
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-card border border-card p-6 text-center text-xs text-ink-faint">
      {children}
    </div>
  );
}

function BackendLegend({ backends }: { backends: Backend[] }) {
  return (
    <div className="flex items-center gap-3">
      {backends.map((b) => (
        <div key={b} className="flex items-center gap-1.5 text-ink-muted">
          <span className="w-2 h-2 rounded-sm" style={{ background: backendColor(b) }} />
          <span>{backendName(b)}</span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting                                                         */
/* ------------------------------------------------------------------ */

/// Compact number — 1.2k / 3.4M / 5.6B. Keeps the dense tables readable
/// when token counts run into the millions.
function fmtCompact(n: number): string {
  if (!isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatDurationMs(ms: number): string {
  if (ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function fmtUSD(n: number): string {
  if (!isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}

/// Round an axis maximum up to 1 / 2 / 2.5 / 5 × 10ⁿ so gridline labels are clean.
function niceCeil(n: number): number {
  if (!isFinite(n) || n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (n <= step * pow) return step * pow;
  }
  return 10 * pow;
}

function leafName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function formatClock(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
