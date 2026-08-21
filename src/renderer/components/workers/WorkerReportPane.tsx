// The crew's timesheet.
//
// This is a performance review, not an analytics dashboard. The question it
// exists to answer is the one you ask about staff and not about software —
// "was this crew worth it?" — so it opens with the answer in a sentence and
// then shows its working, the way a payroll statement does.
//
// Four things the drawing has to carry, in order:
//
//   - THE TRADE, UP FRONT. Time the crew worked, jobs it finished, time off
//     your desk, money spent — one sentence, because those four numbers only
//     mean anything against each other. Six equal tiles said they were six
//     equal facts, which is the one thing they are not.
//   - THE SHAPE OF THE WINDOW. Four small charts, a bar a day, each on its
//     own labelled axis — jobs, dollars, hours, tokens are four units and no
//     two of them belong on one scale. Totals say what the month came to;
//     only the days say whether the crew is ramping up, coasting, or was
//     busy for one afternoon three weeks ago.
//   - A QUIET SHIFT IS A SUCCESS. A worker that looked and found nothing did
//     its job. So shifts are drawn as one band per worker — solid where the
//     shift spawned work, faded where it was quiet, red where it broke — in
//     that worker's OWN colour, the same one its avatar and its calendar
//     blocks already carry. Colour is who; intensity is how busy. The counts
//     are spelled out underneath, so nothing is ever colour-alone.
//   - WHAT A JOB COSTS. Money per finished job is the number that decides who
//     to promote, defund or fire, and it was nowhere on the old screen: a
//     worker billing $87 for one job looked exactly like one billing $42 for
//     eleven. It gets its own column, and the roster's own median is what
//     flags an outlier — no threshold invented from outside the roster.
//
// Rows are separated by rhythm and hover, not by rules. Thirteen hairlines
// down a dense table read as a grid you have to look past; the numbers are
// already in columns, and columns do not need to be drawn to be seen.

import { useEffect, useMemo, useState } from 'react';

import { useWorkersStore } from '../../workersStore';
import {
  formatTokens,
  formatWorkedTime,
  WORKER_MINUTES_SAVED_PER_ITEM,
  type WorkerReport,
  type WorkerReportDay,
  type WorkerReportRow,
} from '@shared/flows/workerReport';
import { WorkerAvatar, useWorkerColors } from './WorkerAvatar';
import { workerColorFor } from './workerPalette';
import { relativeTime } from './workerDeskSelectors';

const RANGES: Array<{ days: 7 | 30 | 0; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 0, label: 'All time' },
];

/// A shift that broke is the one state that is not "this worker's colour at
/// some intensity" — it is a fault, and faults are red everywhere else in the
/// app. Kept out of the identity palette on purpose.
const FAILED_TINT = '#ef4444';

/// One plottable measure. Each gets its own chart and its own axis: two
/// measures of different scale sharing one axis is the fastest way to make a
/// page look informative and be misleading.
type Metric = 'itemsDone' | 'costUSD' | 'workedMs' | 'tokens';

interface MetricSpec {
  key: Metric;
  label: string;
  format: (n: number) => string;
  /// The measure's own colour. Four panels in one hue read as one chart cut
  /// into quarters; a hue per measure makes "the cost one" a thing you can
  /// point at. Deliberately NOT from `WORKER_PALETTE` — that palette means
  /// "which worker", and borrowing it here would imply these charts were
  /// somebody's rather than something's.
  ///
  /// Checked with the dataviz validator against this app's dark surface in
  /// the order they render: lightness band, chroma floor, adjacent-pair CVD
  /// and contrast all pass. Emerald↔orange sits at ΔE 7.9 under protanopia,
  /// which is only legal alongside a second encoding — every panel carries
  /// its name and its own labelled axis, so no reader has to tell the hues
  /// apart to know which chart they are looking at.
  tint: string;
  /// The axis tick, which has a narrow gutter to live in. Only cost differs:
  /// cents are the point in a total and noise on a scale.
  formatAxis?: (n: number) => string;
}

const METRICS: MetricSpec[] = [
  { key: 'itemsDone', label: 'Jobs finished', format: (n) => `${n}`, tint: '#5d72ff' },
  {
    key: 'costUSD',
    label: 'Cost',
    format: (n) => `$${n.toFixed(2)}`,
    formatAxis: (n) => `$${Math.round(n)}`,
    tint: '#d97706',
  },
  { key: 'workedMs', label: 'Agent time', format: (n) => formatWorkedTime(n), tint: '#059669' },
  { key: 'tokens', label: 'Tokens', format: (n) => formatTokens(n), tint: '#a855f7' },
];

/// Which column the table is ordered by. Money leads, because "what did this
/// cost me" is the question the page is opened with — the old default (jobs
/// done, descending) buried the expensive-and-idle workers at the bottom,
/// which is precisely where you would not look for them.
type SortKey = 'cost' | 'perJob' | 'done' | 'shifts' | 'time' | 'tokens';

const money = (n: number) => `$${n.toFixed(2)}`;

/// Cost per finished job. Null when nothing landed — a worker with no jobs
/// has no rate, and printing `$0.00` would say the opposite of what is true.
function perJob(row: WorkerReportRow): number | null {
  return row.itemsDone > 0 ? row.costUSD / row.itemsDone : null;
}

/// " · 24 quiet · 6 spawned work", with the empty halves left out. A row that
/// reads "0 quiet" spends a reader's attention on a category this worker was
/// never in.
function splitOf(row: WorkerReportRow): string {
  const parts = [
    row.quietShifts > 0 && `${row.quietShifts} quiet`,
    row.workingShifts > 0 && `${row.workingShifts} spawned work`,
    row.failedShifts > 0 && `${row.failedShifts} failed`,
  ].filter(Boolean);
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : '';
}

function sortValue(row: WorkerReportRow, key: SortKey): number {
  switch (key) {
    case 'cost':
      return row.costUSD;
    // A worker with no finished jobs sorts last on rate rather than first:
    // it has no rate, and -1 would rank "never delivered" as the cheapest
    // worker on the roster.
    case 'perJob':
      return perJob(row) ?? -1;
    case 'done':
      return row.itemsDone;
    case 'shifts':
      return row.shifts;
    case 'time':
      return row.workedMs;
    case 'tokens':
      return row.inputTokens + row.outputTokens;
  }
}

/// "Mon 12" — enough to find a day on, short enough to repeat 30 times.
function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export function WorkerReportPane() {
  const workers = useWorkersStore((s) => s.workers);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const colors = useWorkerColors();
  const [range, setRange] = useState<7 | 30 | 0>(30);
  const [report, setReport] = useState<WorkerReport | null>(null);
  const [sort, setSort] = useState<SortKey>('cost');

  useEffect(() => {
    // The range can be changed faster than main answers, and two invokes have
    // no ordering guarantee — without this an earlier reply can land last and
    // paint the wrong window under the selected label.
    let cancelled = false;
    // Snap to whole local days: "30 days" means today plus the 29 before it,
    // not "the instant 30×24h ago" — which straddles 31 calendar days and
    // drew a 31-bar chart under a button labelled 30. `setDate` walks the
    // calendar, so it stays right across month ends and daylight saving.
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (range - 1));
    const sinceMs = range === 0 ? 0 : from.getTime();
    void window.overcli.invoke('workers:report', { sinceMs }).then((next) => {
      if (!cancelled) setReport(next);
    });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const view = useMemo(() => {
    if (!report) return null;
    const rows = [...report.byWorker].sort(
      (a, b) => sortValue(b, sort) - sortValue(a, sort) || a.name.localeCompare(b.name),
    );
    // The band's scale is the busiest worker on the roster, so every bar is
    // read against the same ruler and a long row means a long month.
    const maxShifts = Math.max(1, ...rows.map((r) => r.shifts));
    // The outlier test is the roster's own median rate, not a number picked
    // from outside it: a crew of expensive workers should not be flagged
    // wholesale, and a crew of cheap ones should still surface its spender.
    const rates = rows
      .map(perJob)
      .filter((r): r is number => r !== null)
      .sort((a, b) => a - b);
    const median = rates.length > 0 ? rates[Math.floor(rates.length / 2)] : 0;
    return { rows, maxShifts, dear: median > 0 ? median * 2 : Infinity };
  }, [report, sort]);

  const totals = report?.totals;
  const tokens = totals ? totals.inputTokens + totals.outputTokens : 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
      <header className="flex items-start justify-between gap-6 pt-6">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
          What your workers did
        </h2>
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setRange(r.days)}
              aria-pressed={range === r.days}
              className={
                'rounded px-2 py-1 text-[12px] transition-colors ' +
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
                (range === r.days
                  ? 'bg-card-strong text-ink'
                  : 'text-ink-muted hover:bg-card hover:text-ink')
              }
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {!report || !view || !totals ? (
        <div className="mt-6 text-sm text-ink-muted">Loading the report…</div>
      ) : report.byWorker.length === 0 ? (
        <div className="mt-6 text-sm text-ink-muted">
          Nobody's been hired yet. Hire a worker and this fills in after its first shift.
        </div>
      ) : totals.shifts === 0 && totals.runs === 0 ? (
        <div className="mt-6 text-sm text-ink-muted">
          Nothing in this window — the roster worked no shifts. Try a longer range.
        </div>
      ) : (
        <>
          {/* The thesis. These four numbers only mean anything against each
              other, so they are one sentence rather than four tiles. */}
          <p className="mt-3 text-[19px] leading-[1.5] text-ink-muted">
            Your crew worked <Figure>{formatWorkedTime(totals.workedMs)}</Figure> across{' '}
            <Figure>{totals.shifts}</Figure> shift{totals.shifts === 1 ? '' : 's'} and finished{' '}
            <Figure>{totals.itemsDone}</Figure> job{totals.itemsDone === 1 ? '' : 's'} — about{' '}
            <Figure>{Math.max(1, Math.round(totals.savedMinutes / 60))}h</Figure> off your desk, for{' '}
            <Figure>{money(totals.costUSD)}</Figure>.
          </p>

          <p className="mt-2.5 text-[12px] leading-relaxed text-ink-faint">
            <span className="text-ink-muted tabular-nums">{totals.quietShifts}</span> of those
            shifts looked and found nothing to do — that's the crew watching, not idling.
            {totals.rejected > 0 && (
              <>
                {' '}
                You turned down <span className="text-ink-muted tabular-nums">
                  {totals.rejected}
                </span>
                .
              </>
            )}{' '}
            <span className="tabular-nums">{formatTokens(tokens)}</span> tokens spent. The desk-time
            figure is an estimate at {WORKER_MINUTES_SAVED_PER_ITEM} minutes a job; everything else
            here is measured.
            {totals.skippedShifts > 0 && (
              <>
                {' '}
                <span className="text-amber-500 tabular-nums">{totals.skippedShifts}</span> shift
                {totals.skippedShifts === 1 ? '' : 's'} never ran — missed while the app was closed,
                or out of budget.
              </>
            )}
          </p>

          {/* Small multiples rather than one chart with a switch. The four
              measures have four different units, so they can never share an
              axis — and a switch would keep three of them one click out of
              sight, which is where a number nobody is looking for goes to
              be missed. Four small charts, four labelled axes, one glance. */}
          <div className="mt-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
            {METRICS.map((spec) => (
              <MetricChart
                key={spec.key}
                spec={spec}
                daily={report.daily}
                rows={report.byWorker}
              />
            ))}
          </div>

          <div className="mt-8 flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint">
            <span>Per worker</span>
            {/* Legend. The hues in the table are identities (each worker's own
                colour, as on its avatar); what the legend has to teach is the
                INTENSITY, so its swatches are deliberately colourless. */}
            <span className="flex items-center gap-4">
              <Key className="bg-ink-faint">spawned work</Key>
              <Key className="bg-ink-faint opacity-[0.32]">quiet</Key>
              <Key style={{ background: FAILED_TINT }}>failed</Key>
            </span>
          </div>

          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-card text-[10px] uppercase tracking-wider text-ink-faint">
                <th className="w-[24%] py-2 text-left font-medium">Worker</th>
                <th className="w-[22%] py-2 text-left font-medium">
                  <SortHead label="Shifts" k="shifts" sort={sort} onSort={setSort} align="left" />
                </th>
                <th className="py-2 text-right font-medium">
                  <SortHead label="Done" k="done" sort={sort} onSort={setSort} />
                </th>
                <th className="py-2 text-right font-medium">Turned down</th>
                <th className="py-2 text-right font-medium">Failed</th>
                <th className="py-2 text-right font-medium">
                  <SortHead label="Time" k="time" sort={sort} onSort={setSort} />
                </th>
                <th className="py-2 text-right font-medium">
                  <SortHead label="Tokens" k="tokens" sort={sort} onSort={setSort} />
                </th>
                <th className="py-2 text-right font-medium">
                  <SortHead label="Cost" k="cost" sort={sort} onSort={setSort} />
                </th>
                <th className="py-2 pl-3 text-right font-medium">
                  <SortHead label="Per job" k="perJob" sort={sort} onSort={setSort} />
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => {
                const worker = workers[row.workerId];
                const rate = perJob(row);
                const tint = workerColorFor(colors, row.workerId);
                return (
                  <tr
                    key={row.workerId}
                    onClick={() => selectWorker(row.workerId)}
                    className="group cursor-pointer hover:bg-card"
                  >
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2">
                        {worker && <WorkerAvatar worker={worker} />}
                        <div className="min-w-0">
                          {/* A real button inside the row: the row's own click
                              is a convenience, and a convenience is not
                              something to reach a worker's desk THROUGH if you
                              are on a keyboard. */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              selectWorker(row.workerId);
                            }}
                            className="block truncate text-left text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 group-hover:underline"
                          >
                            {row.name}
                          </button>
                          <div className="truncate text-[11px] text-ink-faint">
                            {row.lastShiftAt === null
                              ? 'no shift in this window'
                              : `last shift ${relativeTime(row.lastShiftAt)}`}
                            {!row.enabled && ' · paused'}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="py-2.5 pr-6">
                      <ShiftBand row={row} max={view.maxShifts} tint={tint} />
                      <div className="mt-1 text-[11px] tabular-nums text-ink-faint">
                        <span className="text-ink-muted">{row.shifts}</span> shift
                        {row.shifts === 1 ? '' : 's'}
                        {splitOf(row)}
                      </div>
                    </td>

                    <Cell value={row.itemsDone} strong />
                    <Cell value={row.rejected} />
                    <Cell value={row.itemsFailed} />
                    <Cell text={formatWorkedTime(row.workedMs)} muted={row.workedMs === 0} />
                    <Cell
                      text={formatTokens(row.inputTokens + row.outputTokens)}
                      muted={row.inputTokens + row.outputTokens === 0}
                    />
                    <Cell text={money(row.costUSD)} muted={row.costUSD === 0} />
                    <td className="py-2.5 pl-3 text-right tabular-nums">
                      {rate === null ? (
                        <span className="text-ink-faint" title="Nothing finished in this window">
                          —
                        </span>
                      ) : (
                        <span
                          className={rate > view.dear ? 'text-amber-500' : 'text-ink-muted'}
                          title={
                            rate > view.dear
                              ? 'More than twice the roster median for a finished job'
                              : undefined
                          }
                        >
                          {money(rate)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-card text-[13px]">
                <td className="py-2.5 text-ink-muted">Roster total</td>
                <td className="py-2.5 pr-6 text-[11px] tabular-nums text-ink-faint">
                  <span className="text-ink-muted">{totals.shifts}</span> shifts ·{' '}
                  {totals.quietShifts} quiet · {totals.workingShifts} spawned work
                </td>
                <Cell value={totals.itemsDone} strong />
                <Cell value={totals.rejected} />
                <Cell value={totals.itemsFailed} />
                <Cell text={formatWorkedTime(totals.workedMs)} />
                <Cell text={formatTokens(tokens)} />
                <Cell text={money(totals.costUSD)} />
                <td className="py-2.5 pl-3 text-right tabular-nums text-ink-muted">
                  {totals.itemsDone > 0 ? money(totals.costUSD / totals.itemsDone) : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </div>
  );
}

/// One measure over the window, a bar a day, on its own labelled scale.
///
/// Four of these sit side by side rather than one chart with a switch. Jobs,
/// dollars, hours and tokens are four different units — putting any two on one
/// axis would be a lie, and hiding three behind a toggle means the day the
/// cost spiked is only ever found by someone who already suspected it.
function MetricChart({
  spec,
  daily,
  rows,
}: {
  spec: MetricSpec;
  daily: WorkerReportDay[];
  rows: WorkerReportRow[];
}) {
  const max = Math.max(1, ...daily.map((d) => d[spec.key]));
  const total = daily.reduce((sum, d) => sum + d[spec.key], 0);
  const activeDays = daily.filter((d) => d[spec.key] > 0).length;

  /// Who did what on one day. The per-worker half of the question lives on
  /// hover rather than as a thirteen-colour stack, because a bar split
  /// thirteen ways answers "who" for nobody.
  const breakdown = (index: number): string => {
    const named = rows
      .map((row) => ({ name: row.name, value: row.daily[index]?.[spec.key] ?? 0 }))
      .filter((entry) => entry.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map((entry) => `${entry.name} ${spec.format(entry.value)}`);
    return named.length > 0 ? `\n${named.join('\n')}` : '';
  };

  // Four charts across the pane give each day a narrow column already, so the
  // gutter only survives on the short ranges. Past a couple of months it goes
  // entirely, or the bars would be thinner than the space between them.
  const gap = daily.length > 45 ? 'gap-px' : daily.length > 14 ? 'gap-[2px]' : 'gap-1';

  return (
    <div className="rounded-lg border border-card bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] uppercase tracking-wider text-ink-faint">
          {spec.label} a day
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-ink">{spec.format(total)}</span>
      </div>

      <div className="mt-2.5 flex gap-1.5">
        {/* The y axis. Two labels and two rules — the ceiling and the floor —
            is the whole scale at this size; a third gridline would be more
            ink than the bars it sits behind. */}
        <div className="flex h-16 w-11 shrink-0 flex-col justify-between text-right text-[9px] leading-none tabular-nums text-ink-faint">
          <span className="truncate" title={spec.format(max)}>
            {(spec.formatAxis ?? spec.format)(max)}
          </span>
          <span>0</span>
        </div>

        <div className="relative h-16 min-w-0 flex-1">
          <div className="absolute inset-x-0 top-0 h-px bg-card-strong" />
          <div className="absolute inset-x-0 bottom-0 h-px bg-card-strong" />
          <div className={`flex h-full items-end ${gap}`}>
            {daily.map((d, index) => {
              const value = d[spec.key];
              return (
                <div
                  key={d.day}
                  className="group relative h-full min-w-0 flex-1"
                  title={
                    `${dayLabel(d.day)} — ${spec.format(value)}` +
                    (d.shifts > 0
                      ? ` · ${d.shifts} shift${d.shifts === 1 ? '' : 's'}`
                      : ' · no shifts') +
                    breakdown(index)
                  }
                >
                  <div
                    className="absolute bottom-0 w-full rounded-sm opacity-80 transition-opacity group-hover:opacity-100"
                    style={{
                      background: spec.tint,
                      height: `${(value / max) * 100}%`,
                      // A day with something on it must never round to nothing.
                      minHeight: value > 0 ? 2 : 0,
                    }}
                  />
                  {/* A day with shifts but no output still happened. Without
                      this tick, a week of quiet watching draws as a week the
                      crew was switched off. */}
                  {value === 0 && d.shifts > 0 && (
                    <div className="absolute bottom-0 h-px w-full bg-ink-faint opacity-60" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-1.5 flex justify-between pl-[50px] text-[9px] tabular-nums text-ink-faint">
        <span>{daily[0] ? dayLabel(daily[0].day) : ''}</span>
        <span>
          {activeDays} of {daily.length} days
        </span>
      </div>
    </div>
  );
}

/// One worker's month, on the roster's ruler. Length is shifts worked against
/// the busiest worker; the split inside is what those shifts amounted to.
function ShiftBand({ row, max, tint }: { row: WorkerReportRow; max: number; tint: string }) {
  const segments = [
    { key: 'work', n: row.workingShifts, style: { background: tint } },
    { key: 'quiet', n: row.quietShifts, style: { background: tint, opacity: 0.32 } },
    { key: 'failed', n: row.failedShifts, style: { background: FAILED_TINT } },
  ].filter((s) => s.n > 0);

  return (
    <div
      // The empty track is the ruler — it has to be visible, or a short bar
      // floats against nothing and "a third of the busiest worker" cannot be
      // read off it.
      className="h-1.5 w-full overflow-hidden rounded-full bg-card-strong"
      title={`${row.shifts} shift${row.shifts === 1 ? '' : 's'} — ${row.workingShifts} spawned work, ${row.quietShifts} quiet, ${row.failedShifts} failed`}
    >
      <div
        className="flex h-full gap-[2px] rounded-full"
        // A single shift on a roster whose busiest worker ran thirty would be
        // a third of a pixel, so the floor keeps every worker on the ruler.
        style={{ width: `${Math.max(row.shifts > 0 ? 4 : 0, (row.shifts / max) * 100)}%` }}
      >
        {segments.map((s) => (
          <div
            key={s.key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{ ...s.style, flex: s.n }}
          />
        ))}
      </div>
    </div>
  );
}

/// A number inside the opening sentence. Numerals step up to the ink and to
/// tabular figures; the prose around them stays muted, so the sentence reads
/// as a sentence and scans as a row of figures.
function Figure({ children }: { children: React.ReactNode }) {
  return <span className="font-medium tabular-nums text-ink">{children}</span>;
}

function Key({
  children,
  className,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-4 rounded-full ${className ?? ''}`} style={style} />
      {children}
    </span>
  );
}

/// A right-aligned figure. A zero is dimmed rather than dropped: it is a real
/// answer ("none failed"), but on a roster of thirteen it should not compete
/// with the numbers that have something to say.
function Cell({
  value,
  text,
  strong,
  muted,
}: {
  value?: number;
  text?: string;
  strong?: boolean;
  muted?: boolean;
}) {
  const zero = muted ?? value === 0;
  return (
    <td
      className={
        'py-2.5 text-right tabular-nums ' +
        (zero ? 'text-ink-faint' : strong ? 'text-ink' : 'text-ink-muted')
      }
    >
      {text ?? value}
    </td>
  );
}

function SortHead({
  label,
  k,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = sort === k;
  return (
    <button
      onClick={() => onSort(k)}
      aria-pressed={active}
      className={
        'inline-flex items-center gap-1 uppercase tracking-wider transition-colors ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (align === 'left' ? 'flex-row' : 'flex-row-reverse') +
        (active ? ' text-ink' : ' hover:text-ink-muted')
      }
    >
      {label}
      <span aria-hidden className={active ? 'text-accent' : 'text-transparent'}>
        ↓
      </span>
    </button>
  );
}
