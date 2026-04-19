import { useEffect, useMemo, useState } from 'react';
import { Backend, DailyBucket, StatsReport } from '@shared/types';
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
  const backends: Backend[] = report.byBackend.map((b) => b.backend);

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="text-2xl font-semibold">Usage</div>
        <button
          onClick={reload}
          className="text-xs text-ink-faint hover:text-ink ml-auto hover:bg-white/5 px-2 py-1 rounded"
        >
          ↻ Refresh
        </button>
      </div>

      <div className="grid grid-cols-4 gap-3 mb-6">
        <StatCard label="Active today" value={String(activeToday)} />
        <StatCard label="Sessions" value={String(report.totalSessions)} />
        <StatCard label="Turns" value={report.totalTurns.toLocaleString()} />
        <StatCard label="Tokens (7d)" value={tokensLast7d.toLocaleString()} />
      </div>

      <SectionHeader>
        <span>Activity — last {report.daily.length} days</span>
        <BackendLegend backends={backends} />
      </SectionHeader>
      <StackedActivityChart daily={report.daily} backends={backends} metric="tokens" />
      <div className="h-3" />
      <StackedActivityChart daily={report.daily} backends={backends} metric="turns" />

      <SectionHeader>By backend</SectionHeader>
      <div className="rounded-lg bg-white/[0.02] border border-white/5 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-faint">
              <th className="text-left font-normal px-3 py-1.5">Backend</th>
              <th className="text-right font-normal px-3 py-1.5">Sessions</th>
              <th className="text-right font-normal px-3 py-1.5">Turns</th>
              <th className="text-right font-normal px-3 py-1.5">Input</th>
              <th className="text-right font-normal px-3 py-1.5">Output</th>
              <th className="text-right font-normal px-3 py-1.5">5h</th>
              <th className="text-right font-normal px-3 py-1.5">24h</th>
              <th className="text-right font-normal px-3 py-1.5">7d</th>
            </tr>
          </thead>
          <tbody>
            {report.byBackend.map((b) => (
              <tr key={b.backend} className="border-t border-white/5">
                <td className="px-3 py-1.5">
                  <span
                    className="inline-block w-2 h-2 rounded-sm mr-2 align-middle"
                    style={{ background: backendColor(b.backend) }}
                  />
                  {backendName(b.backend)}
                </td>
                <td className="px-3 py-1.5 text-right">{b.sessions.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.turns.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.inputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.outputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.tokensLast5h.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.tokensLast24h.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{b.tokensLast7d.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHeader>By model</SectionHeader>
      <div className="rounded-lg bg-white/[0.02] border border-white/5 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-faint">
              <th className="text-left font-normal px-3 py-1.5">Model</th>
              <th className="text-right font-normal px-3 py-1.5">Turns</th>
              <th className="text-right font-normal px-3 py-1.5">Input</th>
              <th className="text-right font-normal px-3 py-1.5">Output</th>
              <th className="text-right font-normal px-3 py-1.5">Cache read</th>
            </tr>
          </thead>
          <tbody>
            {report.byModel.map((m) => (
              <tr key={m.model} className="border-t border-white/5">
                <td className="px-3 py-1.5 font-mono">
                  <span
                    className="inline-block w-2 h-2 rounded-sm mr-2 align-middle"
                    style={{ background: backendColor(backendFromModel(m.model)) }}
                  />
                  {m.model}
                </td>
                <td className="px-3 py-1.5 text-right">{m.turns.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{m.inputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{m.outputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{m.cacheRead.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionHeader>By project</SectionHeader>
      <div className="rounded-lg bg-white/[0.02] border border-white/5 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-ink-faint">
              <th className="text-left font-normal px-3 py-1.5">Project</th>
              <th className="text-right font-normal px-3 py-1.5">Sessions</th>
              <th className="text-right font-normal px-3 py-1.5">Turns</th>
              <th className="text-right font-normal px-3 py-1.5">Input</th>
              <th className="text-right font-normal px-3 py-1.5">Output</th>
            </tr>
          </thead>
          <tbody>
            {report.byProject.slice(0, 40).map((p) => (
              <tr key={p.id} className="border-t border-white/5">
                <td className="px-3 py-1.5 truncate max-w-[340px]">{p.name}</td>
                <td className="px-3 py-1.5 text-right">{p.sessions}</td>
                <td className="px-3 py-1.5 text-right">{p.turns.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{p.inputTokens.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-right">{p.outputTokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className="text-xl mt-1">{value}</div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint mt-5 mb-2">
      {children}
    </div>
  );
}

function BackendLegend({ backends }: { backends: Backend[] }) {
  return (
    <div className="flex items-center gap-3 normal-case tracking-normal">
      {backends.map((b) => (
        <div key={b} className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm" style={{ background: backendColor(b) }} />
          <span>{backendName(b)}</span>
        </div>
      ))}
    </div>
  );
}

/// Stacked bar chart — one column per day, one segment per backend. The
/// y-axis is sqrt-scaled so a single outlier day doesn't flatten everything
/// else into a pixel-thin strip. Hover shows the per-backend breakdown.
function StackedActivityChart({
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
  const label = metric === 'tokens' ? 'tokens' : 'turns';

  if (totals === 0) {
    return (
      <div className="rounded-lg bg-white/[0.02] border border-white/5 p-6 text-center text-xs text-ink-faint">
        No {label} in the last {daily.length} days.
      </div>
    );
  }

  const scale = (v: number) => (v <= 0 ? 0 : Math.sqrt(v / max) * 100);

  return (
    <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint mb-2">{label}</div>
      <div className="flex items-end gap-[2px] h-32">
        {rows.map((row) => {
          const h = scale(row.total);
          const breakdownSummary = row.breakdown
            .filter((b) => b.value > 0)
            .map((b) => `${backendName(b.backend)}: ${b.value.toLocaleString()}`)
            .join('\n');
          const title =
            `${row.day} · ${row.total.toLocaleString()} ${label}` +
            (breakdownSummary ? `\n${breakdownSummary}` : '');
          return (
            <div key={row.day} className="flex-1 min-w-[3px] relative h-full" title={title}>
              <div
                className="absolute bottom-0 w-full rounded-sm overflow-hidden flex flex-col-reverse"
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
      <div className="flex justify-between text-[9px] text-ink-faint mt-2">
        <span>{daily[0]?.day ?? ''}</span>
        <span>
          {totals.toLocaleString()} {label}
        </span>
        <span>{daily[daily.length - 1]?.day ?? ''}</span>
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
