// The work queue: every job the crew has run, found rather than scrolled to.
//
// See `queueTable.ts` for why this page stopped being the landing page and
// what question it answers instead. This file is the drawing of it, and it
// obeys three rules the old bands did not:
//
//   - A ZERO COSTS A PILL. The three bands became four filters. An empty
//     band used to cost a header, a border, a count badge and forty pixels
//     of padding to say "none"; a pill says the same thing in its own width
//     and doubles as the way to go looking.
//   - COLUMNS, NOT CARDS. Eleven rows fit in 360px instead of 620, and time,
//     worker, job, flow and result each read straight down the page. This is
//     a surface for scanning, and a scan wants a grid.
//   - THE PAGE ADMITS WHAT IT HID. Four filters can silently drop ninety
//     rows, and a filtered list looks exactly like a crew that did nothing.
//     One line under the table says which it is.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useRunningMap } from '../../runnersStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { PausedActions } from './PausedActions';
import { WorkerAvatar, useWorkerColors } from './WorkerAvatar';
import { clockTime } from './workerCalendar';
import { relativeTime } from './workerDeskSelectors';
import { workerColorFor } from './workerPalette';
import { useDeliverables } from './useDeliverables';
import {
  NO_FILTERS,
  RANGES,
  describeLive,
  describeReach,
  describeState,
  moreBeyond,
  partitionLive,
  stateCounts,
  stateOf,
  tableRows,
  workersInView,
  type QueueFilters,
  type QueueRange,
  type RowState,
} from './queueTable';
import {
  baseName,
  buildWorkQueue,
  groupByDay,
  flowOf,
  isLive,
  type QueueRow,
} from './workQueue';

import type { WorkerFile } from './workerDeskSelectors';

export function WorkQueuePane() {
  const workers = useWorkersStore((s) => s.workers);
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runs = useFlowsStore((s) => s.runs);
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const library = useFlowsStore((s) => s.flows);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const runners = useRunningMap();
  const openFile = useStore((s) => s.openFile);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [filters, setFilters] = useState<QueueFilters>(NO_FILTERS);
  const set = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const queue = useMemo(
    () => buildWorkQueue(orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners),
    [orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners],
  );

  const rows = useMemo(() => tableRows(queue, filters, now), [queue, filters, now]);
  const counts = useMemo(() => stateCounts(queue, filters, now), [queue, filters, now]);
  const roster = useMemo(() => workersInView(queue, filters, now), [queue, filters, now]);
  const unfiltered = useMemo(
    () => tableRows(queue, { ...filters, state: null, query: '', workerId: null }, now).length,
    [queue, filters, now],
  );
  const { live, history } = useMemo(() => partitionLive(rows), [rows]);
  const days = useMemo(() => groupByDay(history, now), [history, now]);
  const beyond = useMemo(() => moreBeyond(queue, filters, now), [queue, filters, now]);
  const filed = useDeliverables(rows, now);
  // The run's own snapshot first, the library second — see `QueueRow.flowId`.
  const flowNames = useMemo(
    () => Object.fromEntries(library.map((f) => [f.id, f.name])),
    [library],
  );

  const open = (row: QueueRow) => {
    selectWorker(row.workerId);
    if (row.runId && runs[row.runId]) setActiveRun(row.runId);
    else if (row.orchestrationId) openWorkerActivity(row.workerId, row.orchestrationId, row.at);
  };

  const empty = Object.keys(workers).length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-4">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">Work queue</h2>
        <p className="mt-[3px] text-[12px] text-ink-faint">
          Every job the crew has run — filter it, find it, act on it.
        </p>
      </div>

      {/* Content before chrome. */}
      <p className="mt-[18px] text-[19px] leading-[1.45] text-ink-muted">
        {describeState(counts, filters.range)}
      </p>

      <div className="mt-4 flex items-center gap-2.5">
        <SearchBox value={filters.query} onChange={(v) => set('query', v)} />
        <RangePicker value={filters.range} onChange={(v) => set('range', v)} />
        <WorkerPicker
          value={filters.workerId}
          options={roster}
          onChange={(v) => set('workerId', v)}
        />
      </div>

      {/* Only states you could actually switch TO. A pill reading zero is the
          empty band all over again, in a smaller font: it costs a slot in the
          row to tell you about work that does not exist. The one exception is
          the pill already pressed — it has to stay so you can unpress it. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">
        {PILLS.filter(({ id }) => counts[id] > 0 || filters.state === id).map(({ id, label }) => (
          <StatePill key={id} id={id} label={label} count={counts[id]} filters={filters} onPick={set} />
        ))}
        {(filters.state || filters.query || filters.workerId) && (
          <button
            onClick={() => setFilters((f) => ({ ...NO_FILTERS, range: f.range }))}
            className="ml-1 text-[11.5px] text-ink-faint hover:text-ink focus:outline-none"
          >
            Clear
          </button>
        )}
      </div>

      <section className="mt-3 overflow-hidden rounded-[10px] border border-card">
        {live.length > 0 && (
          <div>
            <div
              className="flex items-center gap-2.5 border-b px-3 py-1.5"
              style={{
                borderColor: 'var(--c-card-border)',
                background: 'color-mix(in srgb, var(--c-running-pulse) 7%, transparent)',
              }}
            >
              <span
                aria-hidden
                className="h-[6px] w-[6px] animate-pulse rounded-full"
                style={{ background: 'var(--c-running-pulse)' }}
              />
              <span
                className="text-[11.5px] font-semibold tracking-[0.02em]"
                style={{ color: 'color-mix(in srgb, var(--c-running-pulse) 78%, var(--c-ink))' }}
              >
                {describeLive(live)}
              </span>
            </div>
            {live.map((row) => (
              <TableRow
                key={row.key}
                row={row}
                onOpen={open}
                filed={filed[row.key]}
                onOpenFile={openFile}
                flowNames={flowNames}
                emphasis
                now={now}
              />
            ))}
          </div>
        )}

        {rows.length === 0 ? (
          <p className="px-3 py-8 text-center text-[12.5px] text-ink-faint">
            {empty
              ? 'No workers hired yet.'
              : unfiltered === 0
                ? 'The crew has run nothing in this stretch.'
                : 'Nothing matches. Widen the range, or clear the filters.'}
          </p>
        ) : (
          days.map((day) => (
            <div key={day.at}>
              <div className="flex items-center gap-2.5 border-b border-card/60 bg-card/40 px-3 py-1.5">
                <span className="text-[11.5px] font-semibold tracking-[0.02em] text-ink-muted">
                  {day.label}
                </span>
                <span className="text-[11px] tabular-nums text-ink-faint">
                  {day.rows.length} job{day.rows.length === 1 ? '' : 's'}
                </span>
              </div>
              {day.rows.map((row) => (
                <TableRow
                  key={row.key}
                  row={row}
                  onOpen={open}
                  filed={filed[row.key]}
                  onOpenFile={openFile}
                  flowNames={flowNames}
                  now={now}
                />
              ))}
            </div>
          ))
        )}
      </section>

      {beyond && (
        <button
          onClick={() => set('range', beyond.range)}
          className="mt-2 flex w-full items-center gap-2.5 rounded-[10px] border border-dashed border-card px-3 py-2.5 text-left hover:border-card-strong hover:bg-card/40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          <span className="text-[11.5px] text-ink-muted">
            {beyond.count} more job{beyond.count === 1 ? '' : 's'} further back
          </span>
          <span className="ml-auto text-[11.5px] text-ink-faint">Show {beyond.label} →</span>
        </button>
      )}

      <div className="mt-2.5 flex items-center gap-2 text-[11.5px] text-ink-faint">
        <span>{describeReach(rows.length, filters, unfiltered)}</span>
        {nextUp(workers, nextShiftAt, now) && (
          <>
            <span className="text-ink-faint/50">·</span>
            <span>{nextUp(workers, nextShiftAt, now)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/// The soonest shift, as one clause. The Today page draws this properly; here
/// it is a footnote, because a find surface that opens with a countdown is
/// answering a question you did not come here with.
function nextUp(
  workers: Record<string, { id: string; name: string; enabled: boolean }>,
  nextShiftAt: Record<string, number | null>,
  now: number,
): string | null {
  const next = Object.entries(nextShiftAt)
    .filter(([id, at]) => at != null && workers[id]?.enabled && (at as number) > now)
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0];
  if (!next) return null;
  return `${workers[next[0]].name} is on next at ${clockTime(next[1] as number)}.`;
}

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-card bg-card px-2.5 py-1.5 focus-within:border-card-strong">
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 text-ink-faint"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        placeholder="Search jobs, workers, flows…"
        className="min-w-0 flex-1 bg-transparent text-[12px] text-ink placeholder:text-ink-faint/85 focus:outline-none"
      />
      {value && (
        <button
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
          aria-label="Clear search"
          className="shrink-0 text-[11.5px] text-ink-faint hover:text-ink focus:outline-none"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/// One control, four stops. A segmented row rather than a dropdown because
/// the reach is the thing you change most and it is worth one click, not two.
function RangePicker({ value, onChange }: { value: QueueRange; onChange: (v: QueueRange) => void }) {
  return (
    <div className="flex shrink-0 items-center overflow-hidden rounded-lg border border-card">
      {RANGES.map((range, i) => (
        <button
          key={range.id}
          onClick={() => onChange(range.id)}
          className={
            'px-2.5 py-1.5 text-[11.5px] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
            (i > 0 ? 'border-l border-card ' : '') +
            (value === range.id
              ? 'bg-card-strong text-ink'
              : 'text-ink-faint hover:text-ink-muted')
          }
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

function WorkerPicker({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: Array<{ id: string; name: string; count: number }>;
  onChange: (v: string | null) => void;
}) {
  const chosen = options.find((o) => o.id === value);
  return (
    <div className="relative shrink-0">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="appearance-none rounded-lg border border-card bg-transparent py-1.5 pl-2.5 pr-7 text-[11.5px] text-ink-faint hover:text-ink-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <option value="">All workers</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.count})
          </option>
        ))}
      </select>
      <span
        aria-hidden
        className={
          'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] ' +
          (chosen ? 'text-ink' : 'text-ink-faint')
        }
      >
        ▾
      </span>
    </div>
  );
}

/// The three bands, as switches.
///
/// A pill at zero is not dimmed into uselessness — it stays legible and stays
/// clickable, because "show me the failures" answered with an empty table is
/// a real answer and one the old empty band gave far more expensively.
const PILLS: Array<{ id: RowState; label: string }> = [
  { id: 'running', label: 'running' },
  { id: 'needsYou', label: 'need you' },
  { id: 'done', label: 'done' },
  { id: 'failed', label: 'failed' },
];

const PILL_TONE: Record<RowState, string> = {
  running: 'var(--c-running-pulse)',
  needsYou: '#fbbf24',
  done: 'var(--c-ink-muted)',
  failed: 'var(--c-diff-remove-ink)',
};

const PILL_GLYPH: Record<RowState, string> = {
  running: '▶',
  needsYou: '⏸',
  done: '✓',
  failed: '✕',
};

function StatePill({
  id,
  label,
  count,
  filters,
  onPick,
}: {
  id: RowState;
  label: string;
  count: number;
  filters: QueueFilters;
  onPick: <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) => void;
}) {
  const on = filters.state === id;
  return (
    <button
      onClick={() => onPick('state', on ? null : id)}
      aria-pressed={on}
      className={
        'flex items-center gap-[7px] rounded-full border py-1 pl-2.5 pr-3 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (on ? 'border-card-strong bg-card-strong' : 'border-card hover:border-card-strong')
      }
    >
      <span
        aria-hidden
        className="text-[10px]"
        style={{ color: count > 0 || on ? PILL_TONE[id] : 'var(--c-ink-faint)', opacity: 0.85 }}
      >
        {PILL_GLYPH[id]}
      </span>
      <span
        className="text-[12px] font-semibold tabular-nums"
        style={{ color: count > 0 || on ? PILL_TONE[id] : 'var(--c-ink-faint)' }}
      >
        {count}
      </span>
      <span className={'text-[12px] ' + (on ? 'text-ink-muted' : 'text-ink-faint')}>{label}</span>
    </button>
  );
}

/// One job.
///
/// Deliberately the ORIGINAL page's row, not the table row that briefly
/// replaced it. The five problems this page was rebuilt to fix were problems
/// with the PAGE — two bands framing a zero, a readout said twice, no shape
/// to the day, no reach past today. Only one of them was about the row, and
/// "the filed deliverable sits five hundred pixels from its title" did not
/// justify turning every row into a 28px spreadsheet line at 10px in the
/// faintest ink on the ramp. Filters, ranges and day groups are what make
/// this a find surface; small type never was.
///
/// What it keeps from the table: time as a left gutter rather than a
/// right-hand stamp, so the column of times reads straight down and matches
/// Today's spine — the two pages are siblings and should feel it.
function TableRow({
  row,
  onOpen,
  filed,
  onOpenFile,
  flowNames,
  emphasis = false,
  now,
}: {
  row: QueueRow;
  onOpen: (row: QueueRow) => void;
  filed?: WorkerFile | null;
  onOpenFile: (path: string, a?: undefined, mode?: 'preview') => void;
  flowNames: Record<string, string>;
  /// A hoisted row. Work that is happening has to look like it is happening —
  /// the same eleven-point grey as a job that finished at dawn is the page
  /// failing at the only question it is asked while the crew is busy.
  emphasis?: boolean;
  now: number;
}) {
  const colors = useWorkerColors();
  const tint = workerColorFor(colors, row.workerId);
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const state = stateOf(row.status);
  const live = isLive(row.status);
  const flow = flowOf(row, flowNames);
  const quiet = row.status === 'quiet' || row.status === 'orphaned';

  return (
    <div
      className="group flex items-start gap-3 border-b border-card/60 px-3 py-2.5 last:border-b-0 hover:bg-card/60"
      style={
        emphasis
          ? {
              background: `color-mix(in srgb, ${
                state === 'needsYou' ? '#fbbf24' : 'var(--c-running-pulse)'
              } 5%, transparent)`,
            }
          : undefined
      }
    >
      <span
        className={
          'w-[52px] shrink-0 pt-[3px] text-right tabular-nums ' +
          (emphasis ? 'text-[11.5px] text-ink-muted' : 'text-[11px] text-ink-faint')
        }
        title={new Date(row.at).toLocaleString()}
      >
        {clockTime(row.at)}
      </span>

      {/* The rule and the face, the way the roster and the calendar already
          draw this worker. Colour is who — the one encoding the old row got
          right and the table dropped for a 5px dot. */}
      <span
        aria-hidden
        className="mt-[1px] h-[30px] w-[3px] shrink-0 rounded-full"
        style={{ background: state === 'failed' ? 'var(--c-diff-remove-ink)' : tint, opacity: quiet ? 0.35 : 1 }}
      />
      {worker && <WorkerAvatar worker={worker} size="xs" live={live} />}

      <button
        onClick={() => onOpen(row)}
        className="min-w-0 flex-1 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <span className="block truncate text-[13px] leading-[1.35] text-ink" title={row.title}>
          {row.title}
        </span>
        <span className="mt-[3px] flex items-center gap-1.5 text-[11.5px]">
          <span style={{ color: tint, opacity: 0.92 }}>{row.workerName}</span>
          {flow && (
            <>
              <span className="text-ink-faint/50">·</span>
              <span className="truncate text-ink-muted">{flow}</span>
            </>
          )}
          {live && row.steps.length > 0 && (
            <>
              <span className="text-ink-faint/50">·</span>
              <StepTrack steps={row.steps} tint={tint} />
            </>
          )}
        </span>
      </button>

      <span className="flex w-[15rem] shrink-0 items-start justify-end gap-2.5 pt-[1px]">
        <Result row={row} filed={filed} onOpenFile={onOpenFile} />
        {live && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-ink-muted">
            {relativeTime(row.at, now)}
          </span>
        )}
      </span>
    </div>
  );
}

/// The flow's steps with the live one marked and pulsing — the same words the
/// Flows rail and the Today spine use, so "review" means one thing everywhere.
function StepTrack({ steps, tint }: { steps: QueueRow['steps']; tint: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {steps.map((step, i) => (
        <span key={step.id} className="flex shrink-0 items-center gap-1.5">
          {i > 0 && <span className="text-ink-faint/50">›</span>}
          {step.state === 'current' && (
            <span aria-hidden className="h-[5px] w-[5px] animate-pulse rounded-full" style={{ background: tint }} />
          )}
          <span
            className={
              step.state === 'current'
                ? 'font-medium text-ink'
                : step.state === 'failed'
                  ? 'text-red-700 dark:text-red-300/80'
                  : step.state === 'done'
                    ? 'text-ink-muted'
                    : 'text-ink-faint/60'
            }
          >
            {step.id}
          </span>
        </span>
      ))}
    </span>
  );
}

function Result({
  row,
  filed,
  onOpenFile,
}: {
  row: QueueRow;
  filed?: WorkerFile | null;
  onOpenFile: (path: string, a?: undefined, mode?: 'preview') => void;
}) {
  if (row.status === 'paused' && row.runId) return <PausedActions row={row} />;
  if (row.status === 'proposed') {
    return <span className="text-[11.5px] text-amber-500">Wants your go-ahead</span>;
  }
  if (filed) {
    return (
      <button
        onClick={() => onOpenFile(filed.path, undefined, 'preview')}
        title={`Open ${baseName(filed.name)}`}
        className="flex min-w-0 items-center gap-1.5 rounded-md border border-card-strong bg-card px-2 py-1 text-[11.5px] text-ink-muted hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        <span className="truncate">{baseName(filed.name)}</span>
        <span aria-hidden className="text-ink-faint">↗</span>
      </button>
    );
  }
  if (row.status === 'failed') {
    return (
      <span className="truncate text-[11.5px] text-red-700 dark:text-red-300/80" title={row.note}>
        {row.note ?? 'Failed'}
      </span>
    );
  }
  if (row.status === 'orphaned') {
    return <span className="text-[11.5px] text-ink-faint">Its run is gone</span>;
  }
  if (row.status === 'quiet') {
    return (
      <span className="truncate text-[11.5px] text-ink-faint">
        {row.task === 'errand' ? 'Answered in chat' : 'Found nothing to do'}
      </span>
    );
  }
  if (row.status === 'responding') {
    return <span className="animate-pulse text-[11.5px] text-ink-muted">Answering you</span>;
  }
  if (row.status === 'queued') return <span className="text-[11.5px] text-ink-faint">Queued</span>;
  if (row.status === 'planning') {
    return <span className="animate-pulse text-[11.5px] text-ink-faint">Working out what to do</span>;
  }
  if (row.status === 'running') {
    const current = row.steps.find((s) => s.state === 'current');
    return (
      <span className="truncate text-[11.5px] text-ink-muted">
        {current ? current.id : 'Running'}
      </span>
    );
  }
  return <span className="text-[11.5px] text-ink-faint/60">—</span>;
}
