// The Workers tab's front page: what the crew is doing right now.
//
// Three bands, and they are three different asks of the reader — watch this,
// act on this, notice this happened. That is why the queue is banded rather
// than sorted: status is not a column you order by, it is what the row IS,
// and a single time-ordered table buries the two rows with a decision waiting
// on them under eight that need nothing from anybody.
//
// The step track is the one place this screen spends any boldness. "review"
// as a word tells you where a job is; the track tells you where it is AND how
// much is left, which is the only question you actually have while watching
// something run. Everything around it stays flat: no cards, no rules between
// rows, no second accent colour.
//
// Colour is WHO, borrowed wholesale from the roster — the rule down the left
// of a row is the same hue as that worker's avatar, its calendar blocks and
// its band in the Report. Status is never colour alone: it is the band you
// are in, plus the word. Only a failure earns red, because it is the only one
// of these that is wrong.
//
// Every row is a link, not a control. Approving a batch and continuing a
// paused run are real decisions with real context around them, and that
// context lives on the worker's desk and in the run pane — a second Launch
// button here would be the same act with less to read before you commit to
// it. A row takes you to where the decision is properly made.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { WorkerAvatar, useWorkerColors } from './WorkerAvatar';
import { clockTime } from './workerCalendar';
import { relativeTime, startOfDay } from './workerDeskSelectors';
import { workerColorFor } from './workerPalette';

import type { WorkerFile } from './workerDeskSelectors';
import {
  baseName,
  buildWorkQueue,
  describeQueue,
  groupByDay,
  pickDeliverable,
  type QueueRow,
  type QueueStep,
} from './workQueue';

export function WorkQueuePane() {
  const workers = useWorkersStore((s) => s.workers);
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runs = useFlowsStore((s) => s.runs);
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const openFile = useStore((s) => s.openFile);

  // Every stamp on this page is an age, and an age that never re-renders is
  // the thing that makes a live screen feel dead. A minute is as fine as any
  // of them needs to be.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const queue = useMemo(
    () => buildWorkQueue(orchestrations, runs, workers, shiftProgress, now, runsLoaded),
    [orchestrations, runs, workers, shiftProgress, now, runsLoaded],
  );

  // A row is one of two journeys. A job with a run goes to the run — but via
  // `selectWorker`, which is what puts the roster's selection on the right
  // name; the Workers tab only draws a run when it belongs to the worker on
  // screen, and it clears the active run on the way in, so the order here is
  // load-bearing.
  //
  // The `runs[...]` check is not defensive padding. Runs get deleted and
  // pruned while the item that launched them lives on, and `setActiveRun`
  // with an id nobody holds sets a variable that renders nothing — the click
  // appeared to do nothing at all. Without a run there is still the turn that
  // produced the job, so the desk is where the row goes instead.
  const open = (row: QueueRow) => {
    selectWorker(row.workerId);
    if (row.runId && runs[row.runId]) setActiveRun(row.runId);
    else if (row.orchestrationId) {
      openWorkerActivity(row.workerId, row.orchestrationId, row.at);
    }
  };

  // What each finished job actually PRODUCED. A tail that says "Done" ten
  // times tells you the crew was busy and nothing about what you got — and
  // the report, the spec, the page is the entire reason the job was run.
  //
  // Addressed through `workers:deliverables`, which takes the same four facts
  // the filing used. Main owns that naming rule and the renderer does not
  // reproduce it: the two would drift the first time either changed, and the
  // failure would be a silently missing link rather than anything that breaks.
  const [filed, setFiled] = useState<Record<string, WorkerFile | null>>({});
  useEffect(() => {
    // Only `done` rows: a failure, an orphan and a quiet shift all filed
    // nothing, so asking about them is a directory read per row per render
    // for a guaranteed empty answer.
    const wanted = queue.finished.filter(
      (row) =>
        row.status === 'done' &&
        row.batchLabel &&
        // A null is cached like any other answer, EXCEPT for a job that just
        // landed: the journal fold files the output moments after the item
        // settles, so "nothing filed" inside that window is a race rather
        // than a fact, and caching it would hide the report until a remount.
        (!(row.key in filed) || (filed[row.key] === null && now - row.at < 120_000)),
    );
    if (wanted.length === 0) return;
    let live = true;
    void Promise.all(
      wanted.map(async (row) => {
        const files = await window.overcli.invoke('workers:deliverables', {
          id: row.workerId,
          task: row.task,
          label: row.batchLabel!,
          title: row.title,
          at: row.at,
        });
        return [row.key, pickDeliverable(files)] as const;
      }),
    ).then((pairs) => {
      if (live) setFiled((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
    });
    return () => {
      live = false;
    };
  }, [queue.finished, filed, now]);

  const nothing =
    queue.running.length === 0 && queue.needsYou.length === 0 && queue.finished.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-4">
      {nothing ? (
        <EmptyQueue nextShiftAt={nextShiftAt} workers={workers} />
      ) : (
        <>
          <div>
            <h2 className="text-sm font-semibold text-ink">Work queue</h2>
            <p className="mt-0.5 text-xs text-ink-muted">What is moving, what needs a decision, and what landed today.</p>
          </div>

          <section className="mt-5 flex flex-wrap items-center justify-between gap-5 rounded-xl border border-card-strong bg-card/30 p-5 shadow-sm">
            <div>
              <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-faint">Crew status</div>
              <p className="mt-2 text-[20px] leading-[1.45] text-ink-muted">{describeQueue(queue)}</p>
            </div>
            <div className="grid min-w-[360px] grid-cols-3 divide-x divide-card-strong">
              <QueueMetric label="Running" value={queue.running.length} />
              <QueueMetric label="Needs you" value={queue.needsYou.length} attention={queue.needsYou.length > 0} />
              <QueueMetric label="Finished today" value={queue.finishedToday} />
            </div>
          </section>

          <Band
            title="Running now"
            count={queue.running.length}
            rows={queue.running}
            now={now}
            onOpen={open}
          />
          <Band
            title="Needs you"
            count={queue.needsYou.length}
            rows={queue.needsYou}
            now={now}
            onOpen={open}
          />
          <Band
            title="Finished"
            count={queue.finishedToday}
            countLabel="today"
            rows={queue.finished}
            now={now}
            onOpen={open}
            byDay
            filed={filed}
            onOpenFile={(path) => openFile(path, undefined, 'preview')}
          />
        </>
      )}
    </div>
  );
}

/// A band with nothing in it is drawn anyway, with the reason it is empty.
/// The three bands are the shape of the screen, and a shape that changes
/// every time a job lands makes you re-find everything; an empty "Needs you"
/// is also the single best piece of news this page can give you.
function Band({
  title,
  count,
  countLabel,
  rows,
  now,
  onOpen,
  byDay,
  filed,
  onOpenFile,
}: {
  title: string;
  count: number;
  countLabel?: string;
  rows: QueueRow[];
  now: number;
  onOpen: (row: QueueRow) => void;
  byDay?: boolean;
  filed?: Record<string, WorkerFile | null>;
  onOpenFile?: (path: string) => void;
}) {
  const days = useMemo(() => (byDay ? groupByDay(rows, now) : null), [byDay, rows, now]);

  const renderRow = (row: QueueRow) => (
    <QueueRowView
      key={row.key}
      row={row}
      now={now}
      onOpen={onOpen}
      clock={byDay}
      filed={filed?.[row.key] ?? null}
      onOpenFile={onOpenFile}
    />
  );

  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-card-strong bg-card/20 shadow-sm">
      <h3 className="flex items-baseline gap-2 border-b border-card-strong bg-card/50 px-4 py-3 text-sm font-semibold text-ink">
        {title}
        <span className="rounded-full bg-card-strong px-2 py-0.5 text-[10px] font-medium tabular-nums text-ink-muted">{count}</span>
        {countLabel && <span className="text-[11px] font-normal text-ink-faint">{countLabel}</span>}
      </h3>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[12px] text-ink-faint">{EMPTY_BAND[title]}</p>
      ) : days ? (
        <div className="py-1.5">
          {days.map((day, i) => (
            <div key={day.at} className={i > 0 ? 'mt-4' : undefined}>
              <DayRule label={day.label} />
              {day.rows.map(renderRow)}
            </div>
          ))}
        </div>
      ) : (
        <div className="py-1.5">{rows.map(renderRow)}</div>
      )}
    </section>
  );
}

/// The only rule this screen draws between rows, and it earns the exception
/// by answering something no row can: whether the gap above it is ten minutes
/// or a night. Quiet on purpose — a label and a hairline, not a header.
function DayRule({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 pl-3">
      <span className="text-[11px] text-ink-faint">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-card-strong" />
    </div>
  );
}

const EMPTY_BAND: Record<string, string> = {
  'Running now': 'Nobody is working — the crew is between shifts.',
  'Needs you': 'Nothing is waiting on a decision.',
  Finished: 'Nothing has finished yet today.',
};

function QueueRowView({
  row,
  now,
  onOpen,
  clock,
  filed,
  onOpenFile,
}: {
  row: QueueRow;
  now: number;
  onOpen: (row: QueueRow) => void;
  clock?: boolean;
  filed?: WorkerFile | null;
  onOpenFile?: (path: string) => void;
}) {
  const colors = useWorkerColors();
  const tint = workerColorFor(colors, row.workerId);
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const live = row.status === 'running' || row.status === 'planning';
  // A consolidated row stands for several answers and opens none of them:
  // clicking it unfolds what it rolled up, and each line inside goes to the
  // conversation it names.
  const answers = row.answers;
  const [unfolded, setUnfolded] = useState(false);

  // The wrapper holds the hover state the trailing arrow reads, so the arrow
  // is a sibling of the link rather than a child of it.
  return (
    <>
    <div className="group mx-1 flex items-start gap-2 rounded-lg pr-1 transition-colors hover:bg-card/70">
      <button
        onClick={answers ? () => setUnfolded((v) => !v) : () => onOpen(row)}
        aria-expanded={answers ? unfolded : undefined}
        className={
          'flex min-w-0 flex-1 items-start gap-3 rounded-md py-2 pl-3 pr-2 text-left ' +
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50'
        }
      >
        {/* Whose work this is, said twice on purpose — a rule you read at a
            glance down the column, and a name you read when you stop on one. */}
        <span
          aria-hidden
          className="mt-0.5 h-8 w-[3px] shrink-0 rounded-full"
          style={{ background: tint, opacity: row.status === 'quiet' ? 0.35 : 1 }}
        />
        {worker && <WorkerAvatar worker={worker} size="xs" live={live} />}

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={
                'truncate text-[13px] ' +
                (row.status === 'quiet' || row.status === 'orphaned' ? 'text-ink-muted' : 'text-ink')
              }
            >
              {row.title}
            </span>
            <span className="shrink-0 text-[11px] text-ink-faint">{row.workerName}</span>
          </span>
          <span className="mt-1 flex items-center gap-2 text-[11px] text-ink-faint">
            {row.flowName && <span className="shrink-0 truncate max-w-[9rem]">{row.flowName}</span>}
            {row.flowName && <Dot />}
            {row.steps.length > 0 && row.status !== 'done' && row.status !== 'orphaned' ? (
              <StepTrack steps={row.steps} tint={tint} />
            ) : (
              <StatusWord row={row} />
            )}
          </span>
          {row.note && row.status === 'failed' && (
            <span className="mt-1 block truncate text-[11px] text-red-700 dark:text-red-300/80">
              {row.note}
            </span>
          )}
        </span>

      </button>

      {/* Fixed columns, and the stamp is a sibling of the row rather than its
          last child. Inside the button its x-position was set by whatever the
          job happened to file next to it, so a column of times that should
          read straight down the page zig-zagged by the width of a filename. */}
      {onOpenFile && (
        <div className="flex w-[13rem] shrink-0 justify-end pt-2">
          {filed && (
            <button
              onClick={() => onOpenFile(filed.path)}
              title={`Open ${baseName(filed.name)}`}
              className={
                'flex min-w-0 items-center gap-1 rounded-md border border-card-strong px-2 py-1 ' +
                'text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink ' +
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50'
              }
            >
              <span className="truncate">{baseName(filed.name)}</span>
              <span aria-hidden className="text-ink-faint">
                ↗
              </span>
            </button>
          )}
        </div>
      )}

      {/* Three phrasings, because they are three different questions. Live
          work is timed from when it started — "6m ago" against a running job
          reads as a job that has stalled, and against one running for fifteen
          hours it reads as a bug, which is exactly what it was hiding. A
          finished row under a day heading gives the clock time: "14:32" sorts
          by eye, shows the gaps and the bursts, and doesn't drift under you.
          Only an ungrouped past row still counts backwards. */}
      <span className="w-16 shrink-0 pt-2.5 text-right text-[11px] tabular-nums text-ink-faint">
        {live ? elapsed(row.at, now) : clock ? clockTime(row.at) : relativeTime(row.at, now)}
      </span>

      <span
        aria-hidden
        className={
          'w-3 shrink-0 pt-2.5 text-[11px] text-ink-faint transition-opacity ' +
          (answers ? '' : 'opacity-0 group-hover:opacity-100')
        }
      >
        {answers ? (unfolded ? '▾' : '▸') : '→'}
      </span>
    </div>
    {answers && unfolded && (
      <div className="mb-1 ml-[3.4rem] mr-1 border-l border-card-strong pl-3">
        {answers.map((answer) => (
          <button
            key={answer.key}
            onClick={() =>
              onOpen({
                ...row,
                key: answer.key,
                title: answer.title,
                at: answer.at,
                orchestrationId: answer.orchestrationId,
                answers: undefined,
              })
            }
            className={
              'flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left ' +
              'hover:bg-card/70 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50'
            }
          >
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{answer.title}</span>
            <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">
              {clockTime(answer.at)}
            </span>
          </button>
        ))}
      </div>
    )}
    </>
  );
}

/// "6m" / "2h 10m" / "3d" — how long this has been going, which is a
/// different question from when it started and the only one a live row is
/// ever asked.
function elapsed(from: number, now: number): string {
  const mins = Math.max(0, Math.round((now - from) / 60_000));
  if (mins < 1) return 'just started';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 === 0 ? `${hours}h` : `${hours}h ${mins % 60}m`;
  return `${Math.round(hours / 24)}d`;
}

/// The signature. Named steps in flow order, dimmed behind and ahead of where
/// the run actually is — the same word for a step the Flows tab's own rail
/// uses, so the two screens agree on what "review" means.
function StepTrack({ steps, tint }: { steps: QueueStep[]; tint: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {steps.map((step, i) => (
        <span key={step.id} className="flex shrink-0 items-center gap-1">
          {i > 0 && <span className="text-ink-faint/50">›</span>}
          {step.state === 'current' && (
            <span
              aria-hidden
              className="h-1.5 w-1.5 animate-pulse rounded-full"
              style={{ background: tint }}
            />
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

/// What a row says when there is no track to draw: it hasn't started, it
/// isn't a job, or it's over.
function StatusWord({ row }: { row: QueueRow }) {
  if (row.status === 'planning') {
    return (
      <span className="flex items-center gap-1.5">
        <span className="animate-pulse">Working out what to do</span>
        {row.note && <span className="text-ink-faint/70">· {row.note}</span>}
      </span>
    );
  }
  if (row.status === 'queued') return <span>Waiting for a free slot</span>;
  if (row.status === 'proposed') return <span className="text-ink-muted">Wants your go-ahead</span>;
  if (row.status === 'paused') {
    return <span className="text-ink-muted">{PAUSE_TEXT[row.pausedReason ?? 'preStep']}</span>;
  }
  // Past tense on purpose: it is not waiting for anything, it stopped.
  if (row.status === 'orphaned') return <span>Ended — its run is gone</span>;
  if (row.status === 'failed') return <span className="text-red-700 dark:text-red-300/80">Failed</span>;
  if (row.status === 'quiet') {
    return <span>{row.task === 'errand' ? 'Answered without launching work' : 'Looked, found nothing to do'}</span>;
  }
  return <span>Done</span>;
}

const PAUSE_TEXT: Record<NonNullable<QueueRow['pausedReason']>, string> = {
  preStep: 'Stopped at a checkpoint',
  externalAction: 'Wants to act outside the repo',
  riskyStep: 'Step instructions look risky',
  needsInput: 'Asked you a question',
  failure: 'Stopped after a failure',
  interrupted: 'Interrupted when the app closed',
};

/// "at 09:00" for today, "tomorrow at 09:00", "Thu at 09:00" — enough to know
/// whether waiting is worth it, and no more.
function whenNext(at: number): string {
  const days = Math.round((startOfDay(at) - startOfDay(Date.now())) / 86_400_000);
  if (days <= 0) return `at ${clockTime(at)}`;
  if (days === 1) return `tomorrow at ${clockTime(at)}`;
  return `${new Date(at).toLocaleDateString([], { weekday: 'short' })} at ${clockTime(at)}`;
}

function Dot() {
  return <span className="shrink-0 text-ink-faint/50">·</span>;
}

/// An idle crew is the system working, not a blank page — so this says what
/// is next rather than that there is nothing. It only ever reads "nothing is
/// scheduled" when that is literally true of every worker on the roster.
function EmptyQueue({
  nextShiftAt,
  workers,
}: {
  nextShiftAt: Record<string, number | null>;
  workers: Record<string, { id: string; name: string }>;
}) {
  const next = Object.entries(nextShiftAt)
    .filter(([id, at]) => at != null && workers[id])
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0];

  return (
    <div>
      <h2 className="text-sm font-semibold text-ink">Work queue</h2>
      <div className="mt-5 rounded-xl border border-card-strong bg-card/30 p-5 shadow-sm">
      <p className="text-[20px] leading-[1.5] text-ink-muted">
        Nothing in flight, and nothing waiting on you.
      </p>
      <p className="mt-2 text-[13px] text-ink-faint">
        {next
          ? `${workers[next[0]].name} is on next, ${whenNext(next[1] as number)}. Whatever a shift or an errand starts shows up here first.`
          : 'No shifts are scheduled. Give a worker a cadence, or send one an errand, and its work shows up on this page.'}
      </p>
      </div>
    </div>
  );
}

function QueueMetric({ label, value, attention = false }: { label: string; value: number; attention?: boolean }) {
  return (
    <div className="px-5 first:pl-0 last:pr-0">
      <div className="text-[10px] uppercase tracking-wider text-ink-faint">{label}</div>
      <div className={'mt-1 text-2xl font-semibold tabular-nums ' + (attention ? 'text-amber-500' : 'text-ink')}>
        {value}
      </div>
    </div>
  );
}
