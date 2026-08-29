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

import { isRenderableOutput } from '@shared/flows/worker';

import { startOfDay, toWorkerActivity } from './workerDeskSelectors';

import type { WorkerFile } from './workerDeskSelectors';

/// How many finished rows the tail keeps. The band is a glance backwards, not
/// the Report — ten is roughly a morning's work for a small roster, and the
/// Report is one click away in the same sidebar for anything longer.
export const FINISHED_LIMIT = 10;

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
  /// The flow the job runs. Absent while a shift is still planning, and on a
  /// quiet shift, which never picked one.
  flowName?: string;
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
  /// Capped at `FINISHED_LIMIT`, newest first.
  finished: QueueRow[];
  /// Everything finished since midnight, INCLUDING what the cap dropped —
  /// the count has to be the day's real total or the heading misreports it.
  finishedToday: number;
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
      const status = reconcile(item, run, runsLoaded);
      const band = status && bandFor(status);
      if (!status || !band) continue;
      // A benched worker is OFF DUTY, and nothing off duty gets to hold the
      // front page. Its leftovers are exactly the rows most likely to be
      // stale — it stopped working the day you benched it — and a decision
      // "waiting on you" from a worker you have already stood down is a
      // decision you have implicitly made. The one exception is work that is
      // genuinely still moving: benching someone mid-run does not stop the
      // run, and hiding a live job would be the worse lie.
      if (!worker.enabled && status !== 'running') continue;
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

  const midnight = startOfDay(now);
  return {
    running,
    needsYou,
    // Consolidated BEFORE the cap, not in the view: a morning of questions
    // would otherwise spend the whole tail, and the jobs the tail exists to
    // show would fall off the bottom of the page.
    finished: consolidateAnswers(finished).slice(0, FINISHED_LIMIT),
    // Counted from the un-consolidated list. Three answers are three things
    // the crew finished, whatever the tail chooses to draw them as.
    finishedToday: finished.filter((r) => r.at >= midnight).length,
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
): QueueStatus | null {
  if (item.status === 'cancelled') return null;
  // Nothing has launched, so there is nothing to check them against.
  if (item.status === 'proposed' || item.status === 'queued') return item.status;
  if (run) {
    const kind = run.state.kind;
    if (kind === 'running') return 'running';
    if (kind === 'paused') return 'paused';
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
  if (status === 'running' || status === 'queued' || status === 'planning') return 'running';
  // Both of these are stopped until a person does something: `proposed`
  // needs the batch approved, `paused` needs the run continued.
  if (status === 'proposed' || status === 'paused') return 'needsYou';
  if (status === 'done' || status === 'failed' || status === 'quiet' || status === 'orphaned') {
    return 'finished';
  }
  return null;
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

/// The one sentence over the bands. Written as a sentence and not as tiles
/// because these three numbers only mean anything against each other: two
/// running and nothing waiting is a good morning; nothing running and six
/// waiting is a morning you have to spend.
export function describeQueue(queue: WorkQueue): string {
  const jobs = queue.running.length;
  const blocked = queue.needsYou.length;
  const done = queue.finishedToday;
  if (jobs === 0 && blocked === 0 && done === 0) return '';
  const parts: string[] = [];
  parts.push(jobs === 0 ? 'Nothing running' : `${jobs} job${jobs === 1 ? '' : 's'} running`);
  if (blocked > 0) parts.push(`${blocked} waiting on you`);
  parts.push(
    done === 0
      ? 'nothing finished yet today'
      : `${done} finished today`,
  );
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
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
