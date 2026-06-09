import { useEffect, useMemo, useState } from 'react';
import { Backend, DailyBucket, FlowImpactRow, ModelTier, StatsReport, TierStats } from '@shared/types';
import { backendColor, backendFromModel, backendName } from '../theme';

export function StatsPage() {
  const [report, setReport] = useState<StatsReport | null>(null);
  const [loading, setLoading] = useState(true);

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
      <div className="max-w-[1600px] mx-auto px-8 2xl:px-12 py-7">
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
            disabled={loading}
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

        {/* Model mix — the fast vs premium question */}
        <ModelMixPanel rows={report.byTier} />

        {/* Flow impact — the "are flows helping" question */}
        <FlowImpactPanel impact={report.flowImpact} />

        {/* Activity over time */}
        <Panel
          title={`Activity — last ${report.daily.length} days`}
          aside={<BackendLegend backends={backends} />}
        >
          <ActivityChart daily={report.daily} backends={backends} metric="tokens" />
          <div className="h-3" />
          <ActivityChart daily={report.daily} backends={backends} metric="turns" />
        </Panel>

        {/* Detail tables */}
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

        <Panel title="By project" aside={<span className="text-ink-faint">top 40 by output</span>}>
          <DataTable head={['Project', 'Sessions', 'Turns', 'Input', 'Output', 'Lines']} align="lrrrrr">
            {report.byProject.slice(0, 40).map((p) => (
              <tr key={p.id} className="border-t border-card hover:bg-card-strong/60 transition-colors">
                <Td>
                  <span className="truncate max-w-[340px] inline-block align-middle">{p.name}</span>
                </Td>
                <Td right>{p.sessions}</Td>
                <Td right>{p.turns.toLocaleString()}</Td>
                <Td right>{fmtCompact(p.inputTokens)}</Td>
                <Td right>{fmtCompact(p.outputTokens)}</Td>
                <Td right>
                  <LinesCell added={p.linesAdded} deleted={p.linesDeleted} />
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      </div>
    </div>
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

  return (
    <div className="rounded-lg bg-card border border-card p-4">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint mb-3">
        <span>{metricLabel} per day</span>
        <span className="normal-case tracking-normal tabular-nums">
          peak {fmtCompact(max)} · avg {fmtCompact(avg)} / active day
        </span>
      </div>
      <div className="flex items-end gap-[2px] h-32">
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
              className="flex-1 min-w-[3px] relative h-full group"
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

function formatClock(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
