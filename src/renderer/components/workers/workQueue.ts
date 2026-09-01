// The crew's work queue: every job the roster has in the air, and the last
// few it put down.
//
// The Workers tab could already answer three questions — what's coming (the
// shift calendar), what it cost (Funds), and what it came to (the Report) —
// and none of them answer NOW. That was the tab's landing page: whichever
// worker happened to be hired first, which is an accident of sort order
// rather than a front page. This selector is the front page.
//
// Two shapes go in and one comes out. A batch (`Orchestration`) is one turn a
// worker took; its items are the jobs that turn launched. The queue is a list
// of ITEMS, not of batches, because a batch is a unit of authorship and a job
// is a unit of work — you watch, unblock and read jobs. The one exception is
// a batch that launched nothing: an honest empty shift is a real outcome and
// has to be visible, so an item-less batch becomes one `quiet` row of its own.
//
// Rows are never invented from run state alone. Every row traces back to an
// item a worker proposed, so a flow the user launched by hand in the Flows tab
// can never appear here — this is the crew's work, not the app's.

import type { Orchestration, OrchestrationItem } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';
import type { Worker } from '@shared/flows/worker';

import { describeCadence, isRenderableOutput } from '@shared/flows/worker';

import { runIsLive } from '../flows/FlowRunSidebarRow';
import { startOfDay, toWorkerActivity } from './workerDeskSelectors';

import type { WorkerFile } from './workerDeskSelectors';

/// Where a row sits. The three bands are three different asks of the reader:
/// watch it, act on it, or notice it happened.
export type QueueBand = 'running' | 'needsYou' | 'finished';

/// What a row IS, which is a superset of `OrchestrationItemStatus`:
///
/// - `planning` has no item yet. The worker's turn is still deciding what the
///   jobs are, which is minutes of real work with nothing to show for it — and
///   a queue that stays empty while a worker is visibly thinking is lying.
/// - `quiet` is a finished shift that launched nothing. Not a failure: the
///   worker looked and found nothing worth your time.
export type QueueStatus =
  | 'planning'
  /// The item points at a run that is no longer there — deleted, pruned, or
  /// lost with the worktree. Main settles these to `failed` at boot, so this
  /// is the mid-session case: a run deleted while the app is open. It is over
  /// either way, which is why it files under finished rather than under
  /// "Needs you" — nothing about it can be decided, and a band that asks for
  /// decisions is worth exactly as much as its weakest row.
  | 'orphaned'
  | 'queued'
  | 'running'
  | 'proposed'
  | 'paused'
  | 'done'
  /// The flow is over, but the worker is mid-turn ANSWERING YOU — you typed
  /// at the finished run and it is still writing back. The run's own state
  /// says `done` and always will (a hijack turn rides the participant's
  /// conversation, not the orchestrator), so a queue that reads only the run
  /// files live work under Finished and the front page contradicts the
  /// sidebar, which has always shown these as alive.
  | 'responding'
  | 'failed'
  | 'quiet';

/// One step of the flow a job is running, and where the run has got to. The
/// step's own id is its label — the same word the Flows tab's rail uses, so
/// "review" means the same thing in both places.
export interface QueueStep {
  id: string;
  state: 'done' | 'current' | 'failed' | 'ahead';
}

export interface QueueRow {
  key: string;
  workerId: string;
  workerName: string;
  /// Absent on a `planning` row — the batch does not exist yet.
  orchestrationId?: string;
  /// The item's candidate id, absent for the same reason.
  candidateId?: string;
  /// The batch's ledger title (`[Shift 3] Warden`). Carried because it is one
  /// of the four facts `workers:deliverables` addresses a filed output by —
  /// the naming rule lives in main and is not reproduced here.
  batchLabel?: string;
  /// Which entry point produced the work: the worker's standing cadence, or
  /// something somebody asked for.
  task: 'shift' | 'errand';
  /// How an errand was sent. `chat` is a question answered in prose — it
  /// launched nothing and was never going to. Absent on shifts, and on
  /// The chat answers a consolidated row stands for, newest first. Present
  /// only on a row built by `consolidateAnswers`; a lone answer stays an
  /// ordinary row rather than a group of one.
  answers?: Array<{ key: string; title: string; at: number; orchestrationId?: string }>;
  status: QueueStatus;
  /// The job, in the worker's own words. A `quiet` row is titled by its
  /// batch instead, since there is no job to name.
  title: string;
  /// The flow the job runs, as the RUN recorded it. This is the honest
  /// answer — it is the snapshot of what actually executed — but it dies with
  /// the run, and runs are evicted. Pair it with `flowId` below.
  flowName?: string;
  /// The flow's id, off the item rather than off the run.
  ///
  /// It outlives eviction, which `flowName` does not: after a restart the
  /// renderer holds only the last few runs, so every older row lost its flow
  /// and the queue's Flow column came back a full column of em-dashes. The id
  /// lets a view fall back to the library's current name for that flow —
  /// second-best, because the flow may have been renamed since, but a
  /// slightly stale name beats a dash. Absent on a quiet shift, which never
  /// picked one.
  flowId?: string;
  runId?: string;
  /// Empty unless the job has a run to draw a track for.
  steps: QueueStep[];
  /// Why a `paused` job stopped. "Paused" on its own is the least useful word
  /// on this screen — the whole reason the row is in the Needs you band is
  /// that something specific is being asked of you.
  pausedReason?: 'preStep' | 'externalAction' | 'riskyStep' | 'needsInput' | 'failure' | 'interrupted';
  /// What the row is sorted and stamped by: when it started for live work,
  /// when it stopped for finished work.
  at: number;
  /// The failure, or the tool a planning turn is on — one short line, never
  /// a substitute for opening the thing.
  note?: string;
}

export interface WorkQueue {
  running: QueueRow[];
  needsYou: QueueRow[];
  /// Everything the crew has finished that the renderer still holds, newest
  /// first. Uncapped: both readers of this list slice it themselves — Today
  /// to the day, the queue to whatever the filters say — and a cap here
  /// would silently shorten both.
  finished: QueueRow[];
}

/// Whether each conversation is streaming — `useRunningMap()`. A run's
/// participant conversations are the only place a post-completion turn shows
/// up, so without this the queue cannot see one.
export type RunnerMap = Record<string, { isRunning: boolean } | undefined>;

/// How far ahead the queue is willing to look.
///
/// The page is about now, and "coming up" is only worth a band while it is
/// still part of now — something you will still be sitting here for. Four
/// hours is a morning or an afternoon: past it the answer stops being "wait
/// for it" and starts being "come back tomorrow", which is the shift
/// calendar's question and not this page's. It also keeps the band honest by
/// keeping it OFF: with a roster of daily 09:00 workers it shows for a few
/// hours a day and is absent the rest, so its presence means something.
export const SOON_HORIZON_MS = 4 * 60 * 60 * 1000;

/// Inside this, a shift is something you are about to watch happen; outside
/// it, something merely on the books. The difference is drawn as weight —
/// see `UpcomingRow.imminent`.
export const IMMINENT_MS = 60 * 60 * 1000;

/// A shift that hasn't happened yet. Deliberately NOT a `QueueRow`: every
/// other row on this page is a job a worker actually proposed, and a
/// projection that borrowed the same type would sooner or later be counted
/// as one — in `finishedToday`, in the running count, in the crew sentence.
/// It has no run, no items and no outcome, and the separate type is what
/// keeps it from pretending otherwise.
export interface UpcomingRow {
  workerId: string;
  workerName: string;
  /// When the engine says the shift starts. Never re-derived here — see the
  /// note at the top of `upcoming.ts`; a second answer drifts from the one
  /// the scheduler will act on.
  at: number;
  /// The rule in words: "Every weekday at 09:00". A countdown says how long;
  /// the cadence says why, and it is the difference between "in 40m" and "in
  /// 40m, and then again every day at this time".
  cadence: string;
  /// Full weight, versus dimmed and smaller. Read off the CLOCK and not off
  /// the row's position: three shifts that all land in the same ten minutes
  /// are equally imminent, and fading the third for being third would be the
  /// list telling you something about itself rather than about the work.
  imminent: boolean;
  /// Already due and not yet started — the app was asleep, or the shift is
  /// queued behind something. Kept rather than filtered out for the same
  /// reason `upcomingAgenda` keeps it: a stuck shift that vanishes reads as
  /// no shift at all.
  overdue: boolean;
}

/// The shifts about to start, soonest first.
///
/// Workers only. Schedules fire unattended work too and share the calendar
/// with the crew, but this page's opening rule is that every row traces back
/// to something a WORKER did — a schedule has no desk to click through to and
/// no name in the roster, and the calendar is where the two species are drawn
/// together.
export function upcomingShifts(
  workers: Record<string, Worker>,
  nextShiftAt: Record<string, number | null>,
  /// Workers already mid-turn. Their shift is not coming up, it is HERE —
  /// and it is already drawn as a `planning` row in the running band.
  planning: PlanningProgress = {},
  now: number = Date.now(),
  horizon: number = SOON_HORIZON_MS,
): UpcomingRow[] {
  const rows: UpcomingRow[] = [];
  for (const [workerId, at] of Object.entries(nextShiftAt)) {
    const worker = workers[workerId];
    // A benched worker's cadence is still on file and its next occurrence is
    // still computed; it just isn't going to happen.
    if (at == null || !worker?.enabled || planning[workerId]) continue;
    if (at - now > horizon) continue;
    rows.push({
      workerId,
      workerName: worker.name,
      at,
      cadence: describeCadence(worker.cadence),
      imminent: at - now <= IMMINENT_MS,
      overdue: at <= now,
    });
  }
  return rows.sort((a, b) => a.at - b.at || a.workerId.localeCompare(b.workerId));
}

/// A planning turn in flight, keyed by worker id — `workersStore.shiftProgress`.
export type PlanningProgress = Record<string, { tools: string[]; task: 'shift' | 'errand' } | undefined>;

/// `runsLoaded` is not optional politeness — runs hydrate asynchronously at
/// startup, and before they land EVERY item with a run looks orphaned. Until
/// the flag is true the queue trusts the item's own status and orphans
/// nothing.
export function buildWorkQueue(
  orchestrations: Record<string, Orchestration>,
  runs: Record<string, FlowRun>,
  workers: Record<string, Worker>,
  planning: PlanningProgress = {},
  now: number = Date.now(),
  runsLoaded = true,
  runners: RunnerMap = {},
): WorkQueue {
  const running: QueueRow[] = [];
  const needsYou: QueueRow[] = [];
  const finished: QueueRow[] = [];

  // A worker mid-turn goes to the top of the running band. It is drawn before
  // the batches so that the moment you press Work now, the queue answers.
  for (const [workerId, progress] of Object.entries(planning)) {
    const worker = workers[workerId];
    if (!progress || !worker) continue;
    running.push({
      key: `planning:${workerId}`,
      workerId,
      workerName: worker.name,
      task: progress.task,
      status: 'planning',
      title: progress.task === 'errand' ? 'Working out your errand' : 'Working out this shift',
      steps: [],
      at: now,
      ...(progress.tools.length > 0 ? { note: progress.tools[progress.tools.length - 1] } : {}),
    });
  }

  for (const batch of Object.values(orchestrations)) {
    const origin = batch.origin;
    if (origin?.kind !== 'worker') continue;
    // A fired worker's batches outlive it by design. They keep their place in
    // the Report, but not here: every row on this screen is clickable through
    // to a desk, and theirs is gone.
    const worker = workers[origin.workerId];
    if (!worker) continue;
    const task = origin.task ?? 'shift';

    if (batch.items.length === 0) {
      if (!worker.enabled) continue;
      finished.push({
        key: `quiet:${batch.id}`,
        workerId: origin.workerId,
        workerName: origin.workerName,
        orchestrationId: batch.id,
        task,
        status: 'quiet',
        title: toWorkerActivity(batch).title,
        steps: [],
        at: batch.completedAt ?? batch.createdAt,
      });
      continue;
    }

    for (const item of batch.items) {
      const run = item.runId ? runs[item.runId] : undefined;
      const status = reconcile(item, run, runsLoaded, run ? runIsLive(run, runners) : false);
      const band = status && bandFor(status);
      if (!status || !band) continue;
      // A benched worker is OFF DUTY, and nothing off duty gets to hold the
      // front page. Its leftovers are exactly the rows most likely to be
      // stale — it stopped working the day you benched it — and a decision
      // "waiting on you" from a worker you have already stood down is a
      // decision you have implicitly made. The one exception is work that is
      // genuinely still moving: benching someone mid-run does not stop the
      // run, and hiding a live job would be the worse lie.
      if (!worker.enabled && !isLive(status)) continue;
      const row: QueueRow = {
        key: `${batch.id}:${item.candidate.id}`,
        workerId: origin.workerId,
        workerName: origin.workerName,
        orchestrationId: batch.id,
        candidateId: item.candidate.id,
        batchLabel: batch.title,
        task,
        status,
        title: item.candidate.title,
        steps: run ? stepTrack(run) : [],
        at: stampFor(item, run, batch),
        ...(run?.flowSnapshot?.name ? { flowName: run.flowSnapshot.name } : {}),
        ...(item.flowId ? { flowId: item.flowId } : {}),
        ...(run?.state.kind === 'paused' ? { pausedReason: run.state.reason } : {}),
        // Deliberately only when the run is actually in hand: the row's id is
        // what the pane navigates on, and pointing it at a run nobody has is
        // how a click ended up doing nothing at all.
        ...(run ? { runId: run.id } : {}),
        ...(item.note ? { note: item.note } : {}),
      };
      (band === 'running' ? running : band === 'needsYou' ? needsYou : finished).push(row);
    }
  }

  const newestFirst = (a: QueueRow, b: QueueRow) => b.at - a.at || a.key.localeCompare(b.key);
  running.sort(newestFirst);
  needsYou.sort(newestFirst);
  finished.sort(newestFirst);

  return {
    running,
    needsYou,
    // Consolidated here rather than in either view, so both agree that a
    // morning of chat answers is one row and not five.
    finished: consolidateAnswers(finished),
  };
}

/// Roll a worker's chat answers on one day into a single row.
///
/// A chat answer is a real outcome — you asked, it answered — but it is not a
/// JOB: nothing launched, nothing is filed, nothing can be opened but the
/// conversation you already had. Mixed one-per-row into the tail, a morning
/// of questions reads exactly like a morning of work, and the shift that
/// actually produced something sits below three rows of talk.
///
/// Grouped per worker per day, because those are the two facts the group's
/// one line has to be true about ("Chief of Staff · 3 answers", under today).
/// A single answer is left exactly as it was: a group of one is a heavier row
/// that says less than the row it replaced.
export function consolidateAnswers(rows: QueueRow[]): QueueRow[] {
  const groups = new Map<string, QueueRow[]>();
  for (const row of rows) {
    if (!isChatAnswer(row)) continue;
    const key = `${row.workerId}:${startOfDay(row.at)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const out: QueueRow[] = [];
  const drawn = new Set<string>();
  for (const row of rows) {
    if (!isChatAnswer(row)) {
      out.push(row);
      continue;
    }
    const key = `${row.workerId}:${startOfDay(row.at)}`;
    const group = groups.get(key)!;
    if (group.length === 1) {
      out.push(row);
      continue;
    }
    // The group takes the place of its NEWEST member, which is where the
    // whole group already sorted to — so consolidating never moves a row up
    // the page past work that finished after it.
    if (drawn.has(key)) continue;
    drawn.add(key);
    out.push({
      key: `answers:${key}`,
      workerId: row.workerId,
      workerName: row.workerName,
      task: 'errand',
      status: 'quiet',
      title: `${group.length} answers`,
      steps: [],
      at: group[0].at,
      answers: group.map((r) => ({
        key: r.key,
        title: r.title,
        at: r.at,
        ...(r.orchestrationId ? { orchestrationId: r.orchestrationId } : {}),
      })),
    });
  }
  return out;
}

/// An errand that launched nothing IS an answer — the worker read the ask and
/// settled it in prose. Read off the outcome rather than off the Ask/Create-work
/// toggle that used to label the message before it was sent: that toggle said
/// what you MEANT, and a question you sent as work still came back as an
/// answer. Rows that are already a consolidated group carry `answers` and are
/// never folded a second time.
function isChatAnswer(row: QueueRow): boolean {
  return row.status === 'quiet' && row.task === 'errand' && !row.answers;
}

/// THE RUN IS THE TRUTH. An item's status is a mirror the orchestrator keeps
/// up to date as its child run reports in, and a mirror can be stale: an
/// update missed while the app was closed, a terminal event that never routed
/// back, and the item still says `running` days after its run finished. That
/// is not a rare edge — it is what a queue full of week-old "active" work
/// actually is. So where a run is in hand, the run's own state decides the
/// row, and the item is consulted only for the statuses that have no run yet.
function reconcile(
  item: OrchestrationItem,
  run: FlowRun | undefined,
  runsLoaded: boolean,
  /// True when one of the run's participant conversations is streaming right
  /// now. Only consulted once the run's own state has stopped: a `running`
  /// run is running whether or not the turn happens to be mid-stream.
  live: boolean,
): QueueStatus | null {
  if (item.status === 'cancelled') return null;
  // Nothing has launched, so there is nothing to check them against.
  if (item.status === 'proposed' || item.status === 'queued') return item.status;
  if (run) {
    const kind = run.state.kind;
    if (kind === 'running') return 'running';
    // A paused run you are talking your way through is still a decision
    // waiting on you — the band is right and the turn does not change it.
    if (kind === 'paused') return 'paused';
    // Past here the flow itself has stopped, so a streaming participant can
    // only be a turn the user started against the finished run.
    if (live) return 'responding';
    if (kind === 'aborted') return 'failed';
    if (kind === 'done') return run.state.success ? 'done' : 'failed';
    // `watching` and `archived` are both post-completion tails: the work is
    // over, and the queue's tail is the right place for it.
    return 'done';
  }
  // No run, and the runs are all in: the link is dangling. A finished item
  // stays finished — its outcome was recorded and doesn't need the run to be
  // true — but anything the item still calls live is wedged, not live.
  if (item.status === 'done' || item.status === 'failed') return item.status;
  return runsLoaded ? 'orphaned' : item.status;
}

/// `cancelled` is deliberately nowhere: the user removed it before it ran, so
/// it is not work in flight, not waiting on anyone, and not something the
/// crew finished. Showing it would pad the tail with non-events.
function bandFor(status: QueueStatus): QueueBand | null {
  if (isLive(status) || status === 'queued' || status === 'planning') return 'running';
  // Both of these are stopped until a person does something: `proposed`
  // needs the batch approved, `paused` needs the run continued.
  if (status === 'proposed' || status === 'paused') return 'needsYou';
  if (status === 'done' || status === 'failed' || status === 'quiet' || status === 'orphaned') {
    return 'finished';
  }
  return null;
}

/// Work that is moving right now, whichever half of the run is moving it.
/// Both bench-hiding and the running band ask this same question, and they
/// have to answer it the same way or a job appears in one and not the other.
export function isLive(status: QueueStatus): boolean {
  return status === 'running' || status === 'responding';
}

/// When the row happened. For work the item never settled, the run's last
/// attempt is the only honest answer — an item that still says `running`
/// has no `finishedAt` to read, and dating it from the batch would file a
/// job that finished this morning under last Tuesday.
function stampFor(
  item: OrchestrationItem,
  run: FlowRun | undefined,
  batch: Orchestration,
): number {
  const lastAttempt = run?.attempts[run.attempts.length - 1];
  return item.finishedAt ?? lastAttempt?.endedAt ?? item.startedAt ?? batch.createdAt;
}

/// The flow's steps with the live one marked. The last attempt is what counts:
/// a step that failed and was re-run by `on_fail.goto` has succeeded, and the
/// track has to say so rather than carry the earlier failure forever.
export function stepTrack(run: FlowRun): QueueStep[] {
  const state = run.state;
  return (run.flowSnapshot?.steps ?? []).map((step) => {
    const attempts = run.attempts.filter((a) => a.stepId === step.id);
    const last = attempts[attempts.length - 1];
    const current =
      (state.kind === 'running' && state.currentStepId === step.id) ||
      (state.kind === 'paused' && state.nextStepId === step.id);
    if (current) return { id: step.id, state: 'current' as const };
    if (last?.outcome === 'success') return { id: step.id, state: 'done' as const };
    // `question` is a step still in conversation, not a step that failed.
    if (last?.outcome && last.outcome !== 'question') {
      return { id: step.id, state: 'failed' as const };
    }
    return { id: step.id, state: 'ahead' as const };
  });
}

/// What ran, in this order: what the run said it was, then what the library
/// calls that flow today, then nothing — a shift that looked and found
/// nothing to do never picked a flow, and a dash is the true answer there.
export function flowOf(row: QueueRow, names: Record<string, string>): string | null {
  return row.flowName ?? (row.flowId ? names[row.flowId] ?? null : null);
}

/// Which of a job's filed files is THE answer.
///
/// A run that produced several artifacts is filed as a folder — the last
/// artifact is the answer and the earlier ones are what it was built from.
/// A rendered page or document beats a note about one, because that is what
/// the person asking "did the report land" means; failing that, the last
/// file is the tail of the run and the closest thing to a conclusion.
export function pickDeliverable(files: WorkerFile[]): WorkerFile | null {
  if (files.length === 0) return null;
  const renderable = files.filter((f) => isRenderableOutput(baseName(f.name)));
  return renderable[renderable.length - 1] ?? files[files.length - 1];
}

export function baseName(name: string): string {
  return name.split('/').pop() ?? name;
}

/// The finished tail spans days — the cap is ten rows, not one day's rows —
/// and "3h ago … 1d ago … 2d ago" makes the reader do arithmetic to answer
/// the only question the tail is ever asked: what happened while I was away.
/// Cutting it into days answers that directly, and it stops the band's own
/// count ("5 today") sitting above a list that plainly reaches back further.
export interface QueueDay {
  /// Local midnight — the group's identity, and its React key.
  at: number;
  /// "Today" / "Yesterday" / "Sat, Aug 22". Absolute for anything older,
  /// because two relative days is where relative stops helping.
  label: string;
  rows: QueueRow[];
}

export function groupByDay(rows: QueueRow[], now: number): QueueDay[] {
  const today = startOfDay(now);
  const days: QueueDay[] = [];
  for (const row of rows) {
    const at = startOfDay(row.at);
    const last = days[days.length - 1];
    // Rows arrive newest-first, so a day is a contiguous run and the last
    // group is the only one a row can ever join.
    if (last && last.at === at) last.rows.push(row);
    else days.push({ at, label: dayLabel(at, today), rows: [row] });
  }
  return days;
}

function dayLabel(at: number, today: number): string {
  const days = Math.round((today - at) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}
