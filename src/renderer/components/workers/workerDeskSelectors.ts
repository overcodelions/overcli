import type { Orchestration } from '@shared/flows/orchestration';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { FlowArtifact, FlowRun } from '@shared/flows/schema';
import { flowRunActivityAt, isWorkerRun } from '@shared/flows/schema';
import type { Worker } from '@shared/flows/worker';
import { parseWorkerSubject, stripWorkerSubject } from '@shared/flows/worker';
import { flowRunMatchesQuery, runIsLive } from '../flows/FlowRunSidebarRow';

/// Runs are claimed by worker identity, not by owner path: a workspace worker
/// can launch a run whose logical owner is a member repository.
export function workerDeskRuns(runs: Record<string, FlowRun>, workerId: string): FlowRun[] {
  return Object.values(runs)
    .filter((run) => isWorkerRun(run) && run.workerId === workerId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/// This worker's batches and the subset still awaiting explicit approval.
export function workerDeskOrchestrations(
  orchestrations: Record<string, Orchestration>,
  workerId: string,
): { mine: Orchestration[]; awaiting: Orchestration[] } {
  const mine = Object.values(orchestrations)
    .filter((o) => o.origin?.kind === 'worker' && o.origin.workerId === workerId)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { mine, awaiting: mine.filter(isOrchestrationAwaitingApproval) };
}

export interface DeskSummary {
  running: number;
  needReview: number;
  done: number;
  live: boolean;
}

export function summarizeDesk(
  runs: FlowRun[],
  awaiting: Orchestration[],
  runners: Record<string, { isRunning: boolean } | undefined>,
  shiftActive: boolean,
): DeskSummary {
  let running = 0;
  let done = 0;
  let live = shiftActive;
  for (const run of runs) {
    if (runIsLive(run, runners)) live = true;
    if (run.state.kind === 'running' || run.state.kind === 'paused' || run.state.kind === 'watching') {
      running++;
    } else if (run.state.kind !== 'archived') {
      done++;
    }
  }
  const needReview = awaiting.reduce(
    (count, orchestration) =>
      count + orchestration.items.filter((item) => item.status === 'proposed').length,
    0,
  );
  return { running, needReview, done, live };
}

export function workersForPath(workers: Record<string, Worker>, path: string): Worker[] {
  return Object.values(workers)
    .filter((worker) => worker.projectPath === path)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function deskMatchesQuery(worker: Worker, runs: FlowRun[], query: string): boolean {
  if (!query) return true;
  return worker.name.toLowerCase().includes(query) || runs.some((run) => flowRunMatchesQuery(run, query));
}

// ---- Activity ------------------------------------------------------------

/// How many of a worker's batches a desk lists. Shifts accumulate forever on a
/// cadence; past a screenful the older ones are history, and history is what
/// the journal drawer is for.
export const WORKER_ACTIVITY_LIMIT = 12;

/// One thing a worker did — a scheduled shift or an errand you sent — with the
/// batch's outcome already reduced to counts. Shifts and errands share this
/// shape on purpose: they are the same event to a reader ("what did this
/// worker do, and does it need me?"), and separating them into two lists makes
/// the answer take two lookups.
export interface WorkerActivity {
  orchestration: Orchestration;
  task: 'shift' | 'errand';
  at: number;
  /// What to CALL this turn — the worker's own subject for an errand, the
  /// number for a shift. A label, for lists.
  title: string;
  /// What you actually said, verbatim. The desk renders this as your message
  /// bubble, so it must stay your words even though the label above is the
  /// worker's: a chat that rewrites what you typed is not a transcript.
  /// Empty for a shift — nobody asked for it.
  ask: string;
  /// The planning turn's prose with the machine payload stripped — the whole
  /// content of a batch that launched nothing.
  reply: string;
  proposed: number;
  running: number;
  done: number;
  failed: number;
  /// Nothing was launched and nothing is waiting: a refusal, an answered
  /// question, or an honest empty shift. `reply` is the only thing that can
  /// tell those apart, so the UI must show it rather than label it.
  launchedNothing: boolean;
}

/// What to call one batch in a list that already shows the worker's name.
///
/// The two tasks need opposite treatment. A shift's ledger title is
/// `[Shift 3] Warden` — stripping the prefix leaves "Warden", which is the
/// worker's name repeated, so three shifts render as three identical rows.
/// The shift NUMBER is the only distinguishing thing in it, so keep that and
/// drop the name.
///
/// An errand is named by the WORKER, off its own reply — "Report the parser
/// test coverage" rather than "can you give me a report of the test coverage in
/// the parser". What you typed is still shown verbatim, in the message
/// bubble where your words belong; a label is a different job, and the worker
/// has just read the ask closely enough to write one. Anything from before the
/// worker was asked for a subject falls back to what you typed.
function activityTitle(orchestration: Orchestration, task: 'shift' | 'errand'): string {
  const origin = orchestration.origin;
  if (task === 'errand') {
    const named = parseWorkerSubject(orchestration.producer?.reply ?? '');
    if (named) return named;
    const typed = origin?.kind === 'worker' ? origin.errand?.trim() : '';
    const subject = (typed || orchestration.title.replace(/^\[Errand\]\s*/i, '')).trim();
    const firstLine = subject.split('\n')[0]?.trim() ?? '';
    return firstLine || 'Errand';
  }
  const numbered = /^\[Shift\s+(\d+)\]/i.exec(orchestration.title);
  return numbered ? `Shift ${numbered[1]}` : 'Shift';
}

/// The instruction as it was typed. Batches from before `origin.errand`
/// existed only have it inside their ledger title.
function errandAsk(orchestration: Orchestration): string {
  const origin = orchestration.origin;
  const typed = origin?.kind === 'worker' ? origin.errand?.trim() : '';
  return typed || orchestration.title.replace(/^\[Errand\]\s*/i, '').trim();
}

function producerProse(orchestration: Orchestration): string {
  // The subject block is a label, and it is already rendered as one — leaving
  // it in the prose shows the reader the same words twice, once as XML.
  return stripWorkerSubject(orchestration.producer?.reply ?? '')
    .replace(/<candidates>[\s\S]*$/i, '')
    .trim();
}

/// Shift or errand. `origin.task` is authoritative, but batches written before
/// that field existed carry the distinction only in their ledger title — and
/// an errand from last week is exactly the one the user wants to find. Falling
/// straight through to 'shift' mislabels every errand that predates the field
/// and, worse, drops it out of the thread entirely.
export function orchestrationTask(orchestration: Orchestration): 'shift' | 'errand' {
  const origin = orchestration.origin;
  if (origin?.kind === 'worker' && origin.task) return origin.task;
  return /^\[Errand\]/i.test(orchestration.title) ? 'errand' : 'shift';
}

export function toWorkerActivity(orchestration: Orchestration): WorkerActivity {
  const task = orchestrationTask(orchestration);
  let proposed = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const item of orchestration.items) {
    if (item.status === 'proposed') proposed++;
    else if (item.status === 'queued' || item.status === 'running' || item.status === 'paused') {
      running++;
    } else if (item.status === 'done') done++;
    else if (item.status === 'failed') failed++;
  }
  return {
    orchestration,
    task,
    at: orchestration.createdAt,
    title: activityTitle(orchestration, task),
    ask: task === 'errand' ? errandAsk(orchestration) : '',
    reply: producerProse(orchestration),
    proposed,
    running,
    done,
    failed,
    launchedNothing: orchestration.items.length === 0,
  };
}

/// A worker's shifts and errands as one list, newest first, bounded.
export function workerActivity(
  orchestrations: Record<string, Orchestration>,
  workerId: string,
  limit = WORKER_ACTIVITY_LIMIT,
): WorkerActivity[] {
  return workerDeskOrchestrations(orchestrations, workerId)
    .mine.slice(0, limit)
    .map(toWorkerActivity);
}

/// The same list across every worker — what the Workers sidebar shows at the
/// top so opening the tab answers "what happened while I was away" before you
/// pick anyone.
export function recentWorkerActivity(
  orchestrations: Record<string, Orchestration>,
  workers: Record<string, Worker>,
  limit = WORKER_ACTIVITY_LIMIT,
): Array<WorkerActivity & { workerId: string; workerName: string }> {
  return Object.values(orchestrations)
    .filter((o) => o.origin?.kind === 'worker')
    // A fired worker's batches survive it by design; without this they would
    // headline a sidebar that has no row to click through to.
    .filter((o) => o.origin?.kind === 'worker' && !!workers[o.origin.workerId])
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((o) => {
      const origin = o.origin as { kind: 'worker'; workerId: string; workerName: string };
      return { ...toWorkerActivity(o), workerId: origin.workerId, workerName: origin.workerName };
    });
}

/// "5m ago" / "2h ago" / "3d ago" — shared by the roster's last-shift stamp
/// and every activity row. `now` is injectable so tests don't chase the clock.
export function relativeTime(t: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/// "2 need review · 1 running · 3 done", or the empty-batch case spelled out.
export function describeActivity(activity: WorkerActivity): string {
  if (activity.launchedNothing) return 'nothing launched';
  const parts = [
    activity.proposed > 0 && `${activity.proposed} need review`,
    activity.running > 0 && `${activity.running} running`,
    activity.done > 0 && `${activity.done} done`,
    activity.failed > 0 && `${activity.failed} failed`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'no items';
}

export function anyDeskLive(
  workers: Worker[],
  runs: Record<string, FlowRun>,
  orchestrations: Record<string, Orchestration>,
  runners: Record<string, { isRunning: boolean } | undefined>,
  shiftProgress: Record<string, unknown>,
): boolean {
  return workers.some((worker) => {
    const batches = workerDeskOrchestrations(orchestrations, worker.id);
    return summarizeDesk(
      workerDeskRuns(runs, worker.id),
      batches.awaiting,
      runners,
      !!shiftProgress[worker.id],
    ).live;
  });
}

// ---- Deliverable ---------------------------------------------------------

/// What a run was FOR: the artifact its last step produced.
///
/// An errand exists to get you an answer, and when the answer takes a flow to
/// find, the answer is that flow's final artifact. Without this the desk can
/// only say "done" and leave you to go dig it out of the Flows tab — the work
/// happened and the deliverable never came back to the person who asked.
export function runDeliverable(run: FlowRun): FlowArtifact | null {
  const steps = run.flowSnapshot?.steps ?? [];
  // Prefer the declared output of the last step — that is the flow author's
  // statement of what the run produces. Fall back to the most recently written
  // artifact for flows whose last step never ran (a paused or aborted run
  // still has something worth reading).
  for (let i = steps.length - 1; i >= 0; i--) {
    const named = run.artifacts?.[steps[i].output];
    if (named) return named;
  }
  const all = Object.values(run.artifacts ?? {});
  if (all.length === 0) return null;
  return all.reduce((newest, art) => (art.producedAt > newest.producedAt ? art : newest));
}

// ---- Files ---------------------------------------------------------------

export interface WorkerFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: number;
}

/// One job's worth of output — the folder a run was filed into, or a single
/// loose file for a run that produced only one.
export interface WorkerFileJob {
  key: string;
  label: string;
  at: number;
  files: WorkerFile[];
  folder: boolean;
}

export interface WorkerFileGroup {
  key: 'errand' | 'shift' | 'notes';
  label: string;
  blurb: string;
  jobs: WorkerFileJob[];
}

/// Group a worker's directory into the three things that are actually in it.
///
/// The engine files deliverables as `errand-…` / `shift-…`, so the prefix is a
/// real signal, not a guess. Everything else is what the worker wrote for
/// itself — baselines, tallies, notes to its next shift — which is a different
/// kind of thing to look at and deserves its own heading rather than being
/// interleaved by date with the reports.
/// `2026-08-16-1031-errand-…` and the older `errand-…`, both. The date prefix
/// was added later; files already on disk keep working.
const FILE_KIND = /^(?:\d{4}-\d{2}-\d{2}-\d{4}-)?(errand|shift)(?:-\d+)?-/;

export function workerFileKind(name: string): 'errand' | 'shift' | 'notes' {
  const match = FILE_KIND.exec(name);
  return match ? (match[1] as 'errand' | 'shift') : 'notes';
}

/// What to show in a list that is already grouped by kind: drop the date (it
/// has its own column) and the kind word (the heading said it), keep the shift
/// number and the subject, keep the extension so the row still names a real
/// file you could go find on disk.
export function workerFileLabel(name: string): string {
  return name.replace(/^\d{4}-\d{2}-\d{2}-\d{4}-/, '').replace(/^(errand|shift)-/, '');
}

/// Absolute date, because these are an archive. "3h ago" is the right answer
/// for a message and the wrong one for a report you are trying to find again
/// three weeks later; the relative form stays in the row's tooltip.
export function fileDate(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const month = d.toLocaleString(undefined, { month: 'short' });
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return sameYear ? `${month} ${d.getDate()}, ${time}` : `${month} ${d.getDate()} ${d.getFullYear()}`;
}

export function groupWorkerFiles(files: WorkerFile[], query = ''): WorkerFileGroup[] {
  const needle = query.trim().toLowerCase();
  const match = needle ? files.filter((f) => f.name.toLowerCase().includes(needle)) : files;
  const byRecency = [...match].sort((a, b) => b.modifiedAt - a.modifiedAt);
  const groups: WorkerFileGroup[] = [
    {
      key: 'errand',
      label: 'From errands',
      blurb: 'what it produced when you asked',
      jobs: groupIntoJobs(byRecency.filter((f) => workerFileKind(f.name) === 'errand')),
    },
    {
      key: 'shift',
      label: 'From shifts',
      blurb: 'what it produced on its own clock',
      jobs: groupIntoJobs(byRecency.filter((f) => workerFileKind(f.name) === 'shift')),
    },
    {
      key: 'notes',
      label: 'Working notes',
      blurb: 'what it keeps for itself between shifts',
      jobs: groupIntoJobs(byRecency.filter((f) => workerFileKind(f.name) === 'notes')),
    },
  ];
  return groups.filter((g) => g.jobs.length > 0);
}

/// The job a file came out of, as a folder.
///
/// A multi-artifact run is filed into a directory named for the errand or
/// shift, so the grouping already exists on disk — the list was just flattening
/// it, leaving you to read five near-identical filenames and work out which
/// three belonged together. A run that produced ONE file has no directory, and
/// gets a job of one rather than a folder with a single child, because a
/// folder you must open to find one file is a step that buys nothing.
export function groupIntoJobs(files: WorkerFile[]): WorkerFileJob[] {
  const byFolder = new Map<string, WorkerFile[]>();
  const loose: WorkerFileJob[] = [];
  for (const file of files) {
    const cut = file.name.indexOf('/');
    if (cut === -1) {
      loose.push({
        key: file.name,
        label: workerFileLabel(file.name),
        at: file.modifiedAt,
        files: [file],
        folder: false,
      });
      continue;
    }
    const folder = file.name.slice(0, cut);
    const list = byFolder.get(folder);
    if (list) list.push(file);
    else byFolder.set(folder, [file]);
  }
  const foldered: WorkerFileJob[] = [...byFolder.entries()].map(([folder, list]) => ({
    key: folder,
    label: workerFileLabel(folder),
    // The newest file in the job stands for the job — that is when the work
    // finished, which is what you are scanning the column for.
    at: Math.max(...list.map((f) => f.modifiedAt)),
    files: list.slice().sort((a, b) => a.name.localeCompare(b.name)),
    folder: true,
  }));
  return [...foldered, ...loose].sort((a, b) => b.at - a.at);
}

// ---- The desk's day ------------------------------------------------------
//
// A desk accumulates. Two weeks of errands and shifts stacked in one scroll is
// not a record, it is a pile — and the pile is in the way of the thing you
// came to do, which is say something to this worker today. So the desk shows
// ONE DAY, and the rest is behind a step backwards. Same principle as clearing
// your desk at night: nothing is thrown away, it is just not left out.

export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface DeskDay {
  /// Local midnight — the day's identity.
  at: number;
  count: number;
}

/// Days this worker did anything on, newest first. Days with nothing are
/// absent by construction: stepping back through a fortnight of silence one
/// empty day at a time is not navigation.
export function deskDays(items: Array<{ at: number }>): DeskDay[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    const day = startOfDay(item.at);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([at, count]) => ({ at, count }))
    .sort((a, b) => b.at - a.at);
}

export function activityOnDay<T extends { at: number }>(items: T[], day: number): T[] {
  return items.filter((item) => startOfDay(item.at) === day);
}

/// The next day with work on it, in the given direction. `-1` is older.
/// Returns null at either end, which is what disables the arrow.
export function adjacentDeskDay(days: DeskDay[], current: number, dir: -1 | 1): number | null {
  // `days` is newest-first, so "older" walks forward through the array.
  const candidates = dir === -1 ? days.filter((d) => d.at < current) : days.filter((d) => d.at > current);
  if (candidates.length === 0) return null;
  return dir === -1 ? candidates[0].at : candidates[candidates.length - 1].at;
}

/// Which day the desk opens on: today, always. Landing on the last day that
/// happened to have work would mean the desk shows a different date every time
/// you open it, and "clean" would depend on what the worker did last week.
export function initialDeskDay(now: number = Date.now()): number {
  return startOfDay(now);
}

/// "Today" / "Yesterday" / "Mon, Aug 11". A date on its own reads as archive;
/// the two relative words are what make a day feel current.
export function deskDayLabel(day: number, now: number = Date.now()): string {
  const today = startOfDay(now);
  if (day === today) return 'Today';
  const dayMs = 24 * 60 * 60_000;
  if (day === startOfDay(today - dayMs)) return 'Yesterday';
  if (day === startOfDay(today + dayMs)) return 'Tomorrow';
  return new Date(day).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/// The batch a run belongs to. The run itself only knows its worker, so this
/// is what lets a run pane offer the way BACK to the turn that launched it —
/// worker runs are deliberately absent from the Flows sidebar, so without it a
/// run opened from a desk is a room with no door.
export function orchestrationForRun(
  orchestrations: Record<string, Orchestration>,
  runId: string,
): Orchestration | null {
  for (const o of Object.values(orchestrations)) {
    if (o.items.some((it) => it.runId === runId)) return o;
  }
  return null;
}

/// The runs the Workers sidebar lists under one worker — the mirror of
/// `flowRunsForPath` for projects. Worker runs are filtered OUT of every
/// project's Flows group on purpose, so this is their one home in the
/// sidebar; without it, work a worker launched had status nowhere except
/// inside the desk's expansion.
///
/// Scoped to the day the same way the turns above it are, with one exception
/// that matters more than the symmetry: a run that is LIVE, PAUSED or WATCHING
/// stays whatever day it started. A paused run from Tuesday still needs a
/// person on Thursday, and hiding it because the calendar rolled over would
/// lose the only place it is visible. A run that merely FINISHED on Tuesday is
/// history, and history belongs in the Files tab and the journal.
///
/// `activeRunId` is pinned in even when it falls outside the cap: the run you
/// are looking at must have a row, or the sidebar is telling you that the
/// thing filling your screen doesn't exist.
export function workerRunsForSidebar(
  runs: Record<string, FlowRun>,
  workerId: string,
  query: string,
  limit: number,
  activeRunId?: string | null,
  now: number = Date.now(),
): FlowRun[] {
  const mine = workerDeskRuns(runs, workerId).filter((run) => flowRunMatchesQuery(run, query));
  const today = startOfDay(now);
  const current = mine.filter((run) => runNeedsYou(run) || startOfDay(flowRunActivityAt(run)) === today);
  // Nothing today and nothing outstanding: keep the last one, for the same
  // reason a quiet worker keeps its last turn — "did this worker ever run
  // anything" is a different answer from "it ran nothing today".
  const base = current.length > 0 ? current : mine.slice(0, 1);
  const shown = base.slice(0, limit);
  const active = activeRunId ? mine.find((run) => run.id === activeRunId) : undefined;
  if (active && !shown.some((run) => run.id === active.id)) {
    shown.push(active);
    shown.sort((a, b) => b.createdAt - a.createdAt);
  }
  return shown;
}

/// A run whose state is an open question for a person: still going, stopped
/// waiting on a decision, or standing watch.
function runNeedsYou(run: FlowRun): boolean {
  return (
    run.state.kind === 'running' ||
    run.state.kind === 'paused' ||
    run.state.kind === 'watching'
  );
}

/// The turns the sidebar hangs under a worker: TODAY's, capped — the same
/// daily clearing the desk does, so the roster reflects what is going on now
/// rather than accumulating a fortnight of history in a 200px column.
///
/// The one exception is a worker that has done nothing today: it keeps its
/// single most recent turn, because the sidebar's job includes "what did each
/// one do last", and a worker that worked yesterday reading exactly like a
/// worker that has never worked is a worse answer than one stale line.
export function sidebarActivity(
  items: WorkerActivity[],
  now: number,
  limit: number,
): WorkerActivity[] {
  const today = startOfDay(now);
  const todays = items.filter((item) => startOfDay(item.at) === today);
  if (todays.length > 0) return todays.slice(0, limit);
  return items.slice(0, 1);
}
