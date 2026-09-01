// The Workers tab's front page. See `todaySpine.ts` for why it is a spine
// and not a set of bands; this file is the drawing of it.
//
// Three rules govern every choice below:
//
//   - AN ABSENCE COSTS NOTHING. Nothing running draws no rows, no header and
//     no bordered box saying so. The old page spent its top half framing two
//     zeros, which is the most expensive way to say "no".
//   - THE GUTTER IS A COLUMN. Every stamp — future, now, past — sits at the
//     same x, in tabular figures, so the times read straight down the page
//     and the eye can find 10am without reading a word.
//   - WHAT IT PRODUCED TRAVELS WITH THE ROW. The queue parked the filed
//     deliverable in a fixed column 500px from the title it belonged to. Here
//     it sits immediately after the title, because the file IS the outcome.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useRunningMap } from '../../runnersStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { PAUSE_TEXT } from './pauseCopy';
import { PausedActions } from './PausedActions';
import { WorkerAvatar, useWorkerColors } from './WorkerAvatar';
import { workerColorFor } from './workerPalette';
import {
  barHours,
  buildTodaySpine,
  clockStamp,
  dayTicks,
  type SpineItem,
} from './todaySpine';
import { baseName, buildWorkQueue, flowOf, upcomingShifts, type QueueRow } from './workQueue';
import { useDeliverables } from './useDeliverables';

import type { WorkerFile } from './workerDeskSelectors';

import { untilLabel } from '@shared/flows/schedule';

export function TodayPane() {
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

  // Every stamp here is an age or a countdown, and the now-line is the page's
  // whole spine — a minute is as coarse as this may ever get.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const spine = useMemo(() => {
    const queue = buildWorkQueue(orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners);
    // No horizon here: the spine trims the list itself, and it needs to see
    // the shift beyond the horizon to be able to keep the soonest one.
    const soon = upcomingShifts(workers, nextShiftAt, shiftProgress, now, Infinity);
    return buildTodaySpine(queue, soon, now);
  }, [orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners, nextShiftAt]);

  const open = (row: QueueRow) => {
    selectWorker(row.workerId);
    if (row.runId && runs[row.runId]) setActiveRun(row.runId);
    else if (row.orchestrationId) openWorkerActivity(row.workerId, row.orchestrationId, row.at);
  };

  // Only the day's own rows: the pinned decision and the live work have
  // filed nothing yet, by definition.
  const finishedToday = useMemo(
    () =>
      spine.below
        .filter((item): item is Extract<SpineItem, { kind: 'job' }> => item.kind === 'job')
        .map((item) => item.row),
    [spine.below],
  );
  const filed = useDeliverables(finishedToday, now);
  const flowNames = useMemo(
    () => Object.fromEntries(library.map((f) => [f.id, f.name])),
    [library],
  );
  const withFiles = Object.values(filed).filter(Boolean).length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-4">
      <div>
        <h2 className="text-[13px] font-semibold text-ink">Today</h2>
        <p className="mt-[3px] text-[12px] text-ink-faint">
          Where the crew is, in the order it happened. Anything waiting on you is pinned to the top.
        </p>
      </div>

      <DayBar spine={spine} now={now} withFiles={withFiles} />

      <div className="mt-4">
        {spine.upcoming.map((row) => (
          <UpcomingLine key={row.workerId} row={row} now={now} onOpen={selectWorker} />
        ))}
        {spine.pinned.map((row) => (
          <PinnedDecision key={row.key} row={row} now={now} onOpen={open} />
        ))}

        <NowLine now={now} live={spine.live.length > 0} />

        {spine.live.map((row) => (
          <JobRow
            key={row.key}
            row={row}
            onOpen={open}
            live
            now={now}
            filed={filed[row.key]}
            onOpenFile={openFile}
            flowNames={flowNames}
          />
        ))}

        {spine.below.map((item) => (
          <SpineNode
            key={item.key}
            item={item}
            onOpen={open}
            filed={item.kind === 'job' ? filed[item.key] : null}
            onOpenFile={openFile}
            flowNames={flowNames}
            now={now}
          />
        ))}

        {spine.below.length === 0 && spine.live.length === 0 && (
          <p className="py-4 pl-[75px] text-[12px] text-ink-faint">
            Nothing yet today. The spine fills in as the crew works.
          </p>
        )}
      </div>
    </div>
  );
}

/// The day, as a shape.
///
/// This replaced BOTH the crew-status sentence and the three metric tiles
/// that sat beside it repeating the same numbers. One readout, and it carries
/// something neither of those could: where in the day the work actually fell.
/// Four jobs inside twelve minutes is a fact about the crew; eleven rows with
/// timestamps is arithmetic you have to do yourself.
function DayBar({ spine, now, withFiles }: { spine: ReturnType<typeof buildTodaySpine>; now: number; withFiles: number }) {
  const colors = useWorkerColors();
  const { ticks, from } = dayTicks(spine, now);
  const hours = ticks.length > 0 ? barHours(from, now) : [];

  const headline =
    spine.done === 0
      ? spine.live.length > 0
        ? `${spine.live.length} job${spine.live.length === 1 ? '' : 's'} running`
        : 'Nothing yet today'
      : `${spine.done} job${spine.done === 1 ? '' : 's'} done`;

  const under: string[] = [];
  if (withFiles > 0) under.push(`${withFiles} left you a file`);
  if (spine.failed > 0) under.push(`${spine.failed} failed`);
  under.push(spine.pinned.length > 0 ? `${spine.pinned.length} waiting on you` : 'nothing waiting');

  return (
    <section className="mt-[18px] flex items-end gap-5 border-b border-card pb-3.5">
      <div className="shrink-0">
        <div className="text-[19px] font-semibold tracking-[-0.012em] text-ink">{headline}</div>
        <div className="mt-0.5 text-[12px] text-ink-faint">{under.join(' · ')}</div>
      </div>

      {ticks.length > 0 && (
        <div className="min-w-0 flex-1">
          <div className="relative h-3">
            {hours.map((h) => (
              <span
                key={h.at}
                className="absolute top-0 -translate-x-1/2 text-[9px] text-ink-faint/75 tabular-nums"
                style={{ left: `${h.pct}%` }}
              >
                {h.label}
              </span>
            ))}
          </div>
          <div className="relative mt-0.5 h-3.5">
            {ticks.map((tick) => (
              <span
                key={tick.key}
                aria-hidden
                className="absolute bottom-0 w-0.5 rounded-[1px]"
                style={{
                  left: `${tick.pct}%`,
                  height: tick.failed ? '13px' : '11px',
                  background: tick.failed
                    ? 'var(--c-diff-remove-ink)'
                    : workerColorFor(colors, tick.workerId),
                  opacity: 0.85,
                }}
              />
            ))}
            <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-card-strong" />
            <span
              aria-hidden
              className="absolute -bottom-0.5 -right-px h-[5px] w-[5px] rounded-full"
              style={{ background: 'var(--c-running-pulse)' }}
            />
          </div>
        </div>
      )}
    </section>
  );
}

/// The gutter. Every stamp on the page goes through here so the column holds.
function Gutter({ children, tone = 'faint' }: { children?: React.ReactNode; tone?: 'faint' | 'muted' | 'live' }) {
  const color = tone === 'live' ? 'text-[color:var(--c-running-pulse)]' : tone === 'muted' ? 'text-ink-muted' : 'text-ink-faint/90';
  return (
    <span className={`w-[52px] shrink-0 pt-0.5 text-right text-[10px] tabular-nums ${color}`}>
      {children}
    </span>
  );
}

/// The spine's own vertical rule, and the dot that hangs a row off it.
function Stem({
  tint,
  hollow = false,
  dashed = false,
  live = false,
  bare = false,
}: {
  tint?: string;
  hollow?: boolean;
  dashed?: boolean;
  live?: boolean;
  bare?: boolean;
}) {
  return (
    <span className="relative flex w-[9px] shrink-0 justify-center pt-[5px]">
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 -bottom-2.5 mx-auto w-px"
        style={{
          background: dashed
            ? 'repeating-linear-gradient(to bottom, var(--c-card-border) 0 2px, transparent 2px 5px)'
            : 'var(--c-card-border)',
        }}
      />
      {!bare && (
        <span
          className="relative h-[7px] w-[7px] rounded-full"
          style={{
            background: hollow ? 'var(--c-surface)' : tint,
            border: hollow ? `1px solid ${tint}` : undefined,
            boxShadow: live
              ? `0 0 0 3px var(--c-surface), 0 0 0 6px color-mix(in srgb, ${tint} 22%, transparent)`
              : '0 0 0 3px var(--c-surface)',
          }}
        />
      )}
    </span>
  );
}

/// A shift that hasn't started. Above the now-line, and the only rows on the
/// page drawn against a dashed stem — nothing about them has happened yet.
function UpcomingLine({
  row,
  now,
  onOpen,
}: {
  row: ReturnType<typeof upcomingShifts>[number];
  now: number;
  onOpen: (id: string) => void;
}) {
  const colors = useWorkerColors();
  const tint = workerColorFor(colors, row.workerId);
  const near = row.imminent || row.overdue;
  return (
    <button
      onClick={() => onOpen(row.workerId)}
      className={
        'flex w-full items-start gap-3.5 rounded-lg py-[3px] pr-2 text-left transition-colors hover:bg-card/70 ' +
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (near ? 'opacity-100' : 'opacity-60')
      }
    >
      <Gutter>{clockStamp(row.at)}</Gutter>
      <Stem tint={tint} hollow dashed />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[12px] text-ink-muted">{row.workerName}</span>
        <span className="text-[11px] text-ink-faint/50">·</span>
        <span className="truncate text-[11px] text-ink-faint">{row.cadence}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">
          {untilLabel(row.at, now)}
        </span>
      </span>
    </button>
  );
}

/// A decision, lifted out of the day.
///
/// It keeps its own stamp — "asked at 11:52" — because the row is drawn
/// somewhere the clock did not put it, and a page that reorders rows without
/// saying so is a page you stop trusting about time.
function PinnedDecision({ row, now, onOpen }: { row: QueueRow; now: number; onOpen: (row: QueueRow) => void }) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const waited = Math.max(0, Math.round((now - row.at) / 60_000));
  return (
    <div
      className="mb-1 flex items-center gap-3 rounded-xl border px-3.5 py-2.5"
      style={{
        borderColor: 'color-mix(in srgb, #fbbf24 30%, var(--c-card-border))',
        background: 'color-mix(in srgb, #fbbf24 6%, transparent)',
      }}
    >
      <button
        onClick={() => onOpen(row)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        {worker && <WorkerAvatar worker={worker} size="xs" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-ink">{row.title}</span>
          <span className="mt-[3px] block text-[11px] text-amber-500">
            {row.workerName} · {PAUSE_TEXT[row.pausedReason ?? 'preStep']} · asked at {clockStamp(row.at)}
            {waited >= 1 && ` · waiting ${waited < 60 ? `${waited}m` : `${Math.round(waited / 60)}h`}`}
          </span>
        </span>
      </button>
      {row.runId && <PausedActions row={row} tone="solid" />}
    </div>
  );
}

/// The now-line. The page's one horizon: future above, past below.
function NowLine({ now, live }: { now: number; live: boolean }) {
  return (
    <div className="flex items-center gap-3.5 py-2">
      <span className="w-[52px] shrink-0 text-right text-[10px] font-semibold tabular-nums text-[color:var(--c-running-pulse)]">
        {clockStamp(now)}
      </span>
      <span className="flex w-[9px] shrink-0 justify-center">
        <span
          aria-hidden
          className={'h-[7px] w-[7px] rounded-full ' + (live ? 'animate-pulse' : '')}
          style={{
            background: 'var(--c-running-pulse)',
            boxShadow: '0 0 0 3px color-mix(in srgb, var(--c-running-pulse) 22%, transparent)',
          }}
        />
      </span>
      <span
        aria-hidden
        className="h-px flex-1"
        style={{
          background:
            'linear-gradient(to right, color-mix(in srgb, var(--c-running-pulse) 55%, transparent), transparent)',
        }}
      />
      <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[color:color-mix(in_srgb,var(--c-running-pulse)_80%,var(--c-ink-faint))]">
        Now
      </span>
    </div>
  );
}

function SpineNode({
  item,
  onOpen,
  filed,
  onOpenFile,
  flowNames,
  now,
}: {
  item: SpineItem;
  onOpen: (row: QueueRow) => void;
  filed: WorkerFile | null | undefined;
  onOpenFile: (path: string, a?: undefined, mode?: 'preview') => void;
  flowNames: Record<string, string>;
  now: number;
}) {
  if (item.kind === 'hour') {
    return (
      <div className="flex items-center gap-3.5 pb-1 pt-2.5">
        <span className="w-[52px] shrink-0 text-right text-[10px] font-semibold tracking-[0.04em] text-ink-muted tabular-nums">
          {item.label}
        </span>
        <span className="flex w-[9px] shrink-0 justify-center">
          <span aria-hidden className="h-3.5 w-px bg-card-border" style={{ background: 'var(--c-card-border)' }} />
        </span>
        <span
          aria-hidden
          className="h-px flex-1"
          style={{ background: 'linear-gradient(to right, var(--c-card-border), transparent)' }}
        />
      </div>
    );
  }
  if (item.kind === 'quiet') {
    return (
      <div className="flex items-center gap-3.5 py-0.5">
        <span className="w-[52px] shrink-0" />
        <span className="flex w-[9px] shrink-0 justify-center">
          <span
            aria-hidden
            className="h-[22px] w-px"
            style={{
              background:
                'repeating-linear-gradient(to bottom, var(--c-card-border) 0 2px, transparent 2px 5px)',
            }}
          />
        </span>
        <span className="text-[10px] text-ink-faint/70">{item.label}</span>
      </div>
    );
  }
  return (
    <JobRow
      row={item.row}
      onOpen={onOpen}
      filed={filed}
      onOpenFile={onOpenFile}
      flowNames={flowNames}
      now={now}
    />
  );
}

/// One job on the spine.
///
/// The deliverable rides beside the title rather than in a far column, and a
/// row that produced nothing is drawn quieter than one that did — "looked,
/// found nothing to do" is a real outcome but it is not the same weight as a
/// report you have not read.
function JobRow({
  row,
  onOpen,
  filed,
  onOpenFile,
  flowNames,
  live = false,
  now,
}: {
  row: QueueRow;
  onOpen: (row: QueueRow) => void;
  filed?: WorkerFile | null;
  onOpenFile: (path: string, a?: undefined, mode?: 'preview') => void;
  flowNames: Record<string, string>;
  live?: boolean;
  now: number;
}) {
  const colors = useWorkerColors();
  const tint = workerColorFor(colors, row.workerId);
  const quiet = row.status === 'quiet' || row.status === 'orphaned';
  const failed = row.status === 'failed';

  return (
    <div className="group flex items-start gap-3.5 rounded-lg py-[5px] pr-2 transition-colors hover:bg-card/70">
      <Gutter tone={live ? 'muted' : 'faint'}>{clockStamp(row.at)}</Gutter>
      <Stem tint={failed ? 'var(--c-diff-remove-ink)' : tint} live={live} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <button
            onClick={() => onOpen(row)}
            className={
              'min-w-0 truncate text-left text-[13px] focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
              (quiet ? 'text-ink-muted' : 'text-ink')
            }
          >
            {row.title}
          </button>
          {filed && (
            <button
              onClick={() => onOpenFile(filed.path, undefined, 'preview')}
              title={`Open ${baseName(filed.name)}`}
              className="flex shrink-0 items-center gap-1 rounded-[5px] border border-card-strong bg-card px-1.5 py-px text-[10px] text-ink-muted hover:bg-card-strong hover:text-ink focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
            >
              <span className="max-w-[11rem] truncate">{baseName(filed.name)}</span>
              <span aria-hidden className="text-ink-faint">↗</span>
            </button>
          )}
          {live && (
            <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">
              {elapsed(row.at, now)}
            </span>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span style={{ color: tint, opacity: 0.9 }}>{row.workerName}</span>
          <span className="text-ink-faint/50">·</span>
          {live && row.steps.length > 0 ? (
            <StepTrack row={row} tint={tint} />
          ) : (
            <span className={failed ? 'text-red-700 dark:text-red-300/80' : undefined}>
              {describeOutcome(row, flowNames)}
            </span>
          )}
        </span>
        {row.note && failed && (
          <span className="mt-1 block truncate text-[11px] text-red-700 dark:text-red-300/80">{row.note}</span>
        )}
      </span>
    </div>
  );
}

function StepTrack({ row, tint }: { row: QueueRow; tint: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {row.steps.map((step, i) => (
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

function describeOutcome(row: QueueRow, flowNames: Record<string, string>): string {
  if (row.status === 'quiet') {
    return row.task === 'errand' ? 'Answered without launching work' : 'Looked, found nothing to do';
  }
  if (row.status === 'orphaned') return 'Ended — its run is gone';
  if (row.status === 'failed') return 'Failed';
  if (row.status === 'responding') return 'Answering you';
  return flowOf(row, flowNames) ?? 'Done';
}

function elapsed(from: number, now: number): string {
  const mins = Math.max(0, Math.round((now - from) / 60_000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 === 0 ? `${hours}h` : `${hours}h ${mins % 60}m`;
  return `${Math.round(hours / 24)}d`;
}

