// Today as the one place to look: every decision and everything moving, of
// every kind. The crew's own runs were always here; a team task waiting on
// its plan or a process item waiting on your call lived on their own pages,
// so with a process, a team and a worker all going at once there was no one
// page that said so. This gathers the other two kinds into the same two
// lists — Needs you, and In flight — and says each one in the same words.
//
// Pure: the components hand it what the stores (and the process poll) hold.

import { describeTeamTaskStatus, piecesWaiting, teamTaskProgress, unhired, type TeamTask } from '@shared/flows/team';
import type { ProcessDef, ProcessStage } from '@shared/org/process';
import type { ProcessItemView } from '@shared/types';

import { itemTrack } from './processes/processView';
import { clockStamp } from './todaySpine';
import type { QueueRow, UpcomingRow } from './workQueue';

export type BoardKind = 'worker' | 'team' | 'process';

/// One segment of a row's mini track.
export type TrackSeg = 'done' | 'now' | 'stuck' | 'ahead';

/// A process as `processes:get` returns it, cut to what Today reads.
export interface ProcessBoardData {
  process: Pick<ProcessDef, 'id' | 'name' | 'stages'>;
  items: ProcessItemView[];
}

/// Where a row opens. A worker run and a team task open beside the list; a
/// process item opens its board, on its own page.
export type BoardTarget =
  | { kind: 'run'; rowKey: string }
  | { kind: 'team'; taskId: string; teamId: string }
  | { kind: 'process'; processId: string; itemId: string };

/// A decision that is not a worker run's: a team task or a process item.
export interface OtherNeed {
  kind: 'team' | 'process';
  key: string;
  title: string;
  /// What is being asked of you, in a few words: "Approve the plan".
  ask: string;
  /// Whose it is: the team, or the process.
  who: string;
  /// Since when it has waited.
  at: number;
  target: BoardTarget;
}

export interface FlightRow {
  kind: BoardKind;
  key: string;
  title: string;
  /// Whose it is: the worker, the team, or the process.
  who: string;
  /// Where it has got to, in one line.
  now: string;
  track: TrackSeg[];
  stuck: boolean;
  startedAt: number;
  target: BoardTarget;
}

export interface TodayBoard {
  needs: OtherNeed[];
  flight: FlightRow[];
  /// Team tasks drawn above — in Needs you or In flight, or covered by the
  /// process item they are a stage of — so the day's lists leave them out.
  pinnedTasks: Set<string>;
}

// ---- team tasks -----------------------------------------------------------

/// What a team task is waiting on you for, or null when it is not.
export function teamAsk(task: Pick<TeamTask, 'status' | 'waiting' | 'stages' | 'stageIndex' | 'hires'>): string | null {
  switch (task.status) {
    case 'questions':
      return 'Answer its questions';
    case 'proposed':
      return 'Approve the plan';
    case 'review':
      return 'Review the pack';
    case 'waiting':
      // Held while the crew is away is not a decision: it starts by itself
      // when you are back.
      if (task.waiting?.reason === 'away') return null;
      return task.waiting?.message?.trim() || describeTeamTaskStatus(task);
    case 'running': {
      // Running, but a piece's run is stopped for you: the stage can't end.
      const waiting = piecesWaiting(task);
      if (waiting.length === 0) return null;
      if (waiting.length === 1) return `${waiting[0].workerName} ${waiting[0].waitingFor}`;
      return `${waiting.map((a) => a.workerName).join(', ')} are waiting on you`;
    }
    default:
      return null;
  }
}

/// Moving without you: thinking, working, or held for the crew's return.
function teamMoving(task: Pick<TeamTask, 'status' | 'waiting'>): boolean {
  return task.status === 'planning' || task.status === 'running' || (task.status === 'waiting' && task.waiting?.reason === 'away');
}

function teamTitle(task: Pick<TeamTask, 'title' | 'brief' | 'kind' | 'teamName'>): string {
  if (task.kind === 'learn') return `Learning what ${task.teamName} needs to know`;
  return task.title?.trim() || task.brief.split('\n')[0].trim() || `${task.teamName} task`;
}

/// One segment per stage: done (or skipped) green, the one being worked
/// accent, a failed one red, the rest grey.
export function teamTrack(task: Pick<TeamTask, 'stages' | 'stageIndex' | 'status'>): TrackSeg[] {
  return task.stages.map((stage, i) => {
    if (stage.status === 'done' || stage.status === 'skipped') return 'done';
    if (stage.status === 'failed') return 'stuck';
    if (i === task.stageIndex && (task.status === 'running' || task.status === 'waiting')) return 'now';
    return 'ahead';
  });
}

/// "Draft · Scout & Quill, 1 done".
export function teamNowLine(task: TeamTask): string {
  if (task.status === 'planning') return 'Planning · Coordinator';
  if (task.status === 'running' && unhired(task).length > 0) return describeTeamTaskStatus(task);
  const stage = task.stages[task.stageIndex];
  const { done } = teamTaskProgress(task);
  if (!stage) return `${done} done`;
  if (task.status === 'waiting' && task.waiting?.reason === 'away') return `${stage.title} · held while the crew is away`;
  const working = stage.assignments.filter((a) => a.status === 'running').map((a) => a.workerName);
  const who = working.length
    ? working.join(' & ')
    : stage.assignments.length
      ? stage.assignments.map((a) => a.workerName).join(' & ')
      : 'Coordinator';
  return `${stage.title} · ${who}, ${done} done`;
}

// ---- process items --------------------------------------------------------

/// When the item came into the stage it is at: the last time it entered
/// it, else its last change.
function enteredStageAt(item: ProcessItemView, stage: ProcessStage | undefined): number {
  const entered = [...item.history].reverse().find((e) => e.kind === 'entered' && (!stage || e.stageId === stage.id));
  return entered?.at ?? item.updatedAt;
}

/// The call is yours: a decision at a people stage, or your team's or
/// worker's questions, plan, pack or paused run at theirs.
export function processWaitsOnYou(item: ProcessItemView): boolean {
  return item.status === 'active' && item.yourTurn;
}

const TURN_ASK: Record<NonNullable<ProcessItemView['ownerTurn']>, string> = {
  questions: 'Answer the questions',
  plan: 'Approve the plan',
  pack: 'Sign off the pack',
  paused: 'Unblock the run',
};

/// "Decide: Approve the fix", "Sign off the pack: Publish and explain".
export function processAsk(item: ProcessItemView, stage: ProcessStage | undefined): string {
  const name = stage?.name ?? item.stageName;
  return item.ownerTurn && stage?.kind !== 'people' ? `${TURN_ASK[item.ownerTurn]}: ${name}` : `Decide: ${name}`;
}

/// "Review · Waiting on Pat", "Build · stuck: the branch is gone".
export function processNowLine(item: ProcessItemView, stage: ProcessStage | undefined): string {
  const name = stage?.name ?? item.stageName;
  if (item.blocked) return `${name} · stuck: ${item.blocked}`;
  return item.stageNote?.trim() ? `${name} · ${item.stageNote.trim()}` : name;
}

// ---- workers --------------------------------------------------------------

/// "Step 2 of 3 · review".
export function workerNowLine(row: Pick<QueueRow, 'status' | 'steps' | 'note'>): string {
  if (row.status === 'planning') return row.note ? `Planning · ${row.note}` : 'Planning what to do';
  if (row.status === 'responding') return 'Answering you';
  if (row.status === 'queued') return 'Queued';
  const total = row.steps.length;
  if (total === 0) return row.note ?? 'Working';
  const at = row.steps.findIndex((s) => s.state === 'current' || s.state === 'failed');
  if (at >= 0) return `Step ${at + 1} of ${total} · ${row.steps[at].id}`;
  const done = row.steps.filter((s) => s.state === 'done').length;
  return `Step ${Math.min(done + 1, total)} of ${total}`;
}

export function workerTrack(row: Pick<QueueRow, 'steps'>): TrackSeg[] {
  return row.steps.map((s) => (s.state === 'current' ? 'now' : s.state === 'failed' ? 'stuck' : s.state));
}

// ---- the board ------------------------------------------------------------

export function buildTodayBoard({
  working,
  tasks,
  processes,
  teamNames = {},
  groupTeams = true,
}: {
  /// The crew's running rows — `WorkQueue.running`.
  working: QueueRow[];
  tasks: Record<string, TeamTask>;
  processes: ProcessBoardData[];
  /// Current team names, over the name a task kept from when it was briefed.
  teamNames?: Record<string, string | undefined>;
  /// The crew's list: a team piece stands for its team task. One worker's
  /// inbox lists its own runs only.
  groupTeams?: boolean;
}): TodayBoard {
  const needs: OtherNeed[] = [];
  const flight: FlightRow[] = [];
  const pinnedTasks = new Set<string>();

  // A team task working a process stage is that item's progress: the item's
  // row says where it is, and its own row would say it twice.
  const processTasks = new Set<string>();
  for (const { items } of processes) {
    for (const item of items) if (item.status === 'active' && item.taskId) processTasks.add(item.taskId);
  }

  for (const { process, items } of processes) {
    for (const item of items) {
      if (item.status !== 'active') continue;
      const stage = process.stages[item.stageIndex];
      const target: BoardTarget = { kind: 'process', processId: process.id, itemId: item.id };
      // A worker stage's paused run is already in Needs you as the run
      // itself, where Continue is; the item's row just says it waits on you.
      const runWaits = item.ownerTurn === 'paused' && stage?.kind === 'worker';
      if (processWaitsOnYou(item) && !runWaits) {
        needs.push({
          kind: 'process',
          key: `process:${item.id}`,
          title: item.title,
          ask: processAsk(item, stage),
          who: process.name,
          at: enteredStageAt(item, stage),
          target,
        });
        continue;
      }
      flight.push({
        kind: 'process',
        key: `process:${item.id}`,
        title: item.title,
        who: process.name,
        now: runWaits && item.yourTurn ? `${stage?.name ?? item.stageName} · waiting on you: its run is paused` : processNowLine(item, stage),
        track: itemTrack(item, process.stages.length),
        stuck: !!item.blocked,
        startedAt: item.createdAt,
        target,
      });
    }
  }

  for (const task of Object.values(tasks)) {
    const who = teamNames[task.teamId] ?? task.teamName;
    const target: BoardTarget = { kind: 'team', taskId: task.id, teamId: task.teamId };
    const ask = teamAsk(task);
    if (ask) {
      pinnedTasks.add(task.id);
      needs.push({ kind: 'team', key: `team:${task.id}`, title: teamTitle(task), ask, who, at: task.updatedAt, target });
      continue;
    }
    if (!teamMoving(task)) continue;
    pinnedTasks.add(task.id);
    if (processTasks.has(task.id)) continue;
    const track = teamTrack(task);
    flight.push({
      kind: 'team',
      key: `team:${task.id}`,
      title: teamTitle(task),
      who,
      now: teamNowLine(task),
      track,
      stuck: track.includes('stuck'),
      startedAt: task.createdAt,
      target,
    });
  }

  for (const row of working) {
    // A team's piece is drawn as its task.
    if (groupTeams && row.team && pinnedTasks.has(row.team.taskId)) continue;
    const track = workerTrack(row);
    flight.push({
      kind: 'worker',
      key: `worker:${row.key}`,
      title: row.title,
      who: row.workerName,
      now: workerNowLine(row),
      track,
      stuck: track.includes('stuck'),
      startedAt: row.at,
      target: { kind: 'run', rowKey: row.key },
    });
  }

  return { needs: needs.sort((a, b) => a.at - b.at), flight: sortFlight(flight), pinnedTasks };
}

/// Stuck first — it is the one moving thing you may have to step into —
/// then the most recently started.
export function sortFlight(rows: FlightRow[]): FlightRow[] {
  return [...rows].sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.startedAt - a.startedAt);
}

/// How many decisions that are not worker runs are waiting — the rail's
/// Today badge adds these to the crew's own.
export function otherNeedsCount(tasks: Record<string, TeamTask>, processes: ProcessBoardData[]): number {
  return buildTodayBoard({ working: [], tasks, processes }).needs.length;
}

/// The worker decisions and the others as one queue, the one that has waited
/// longest first. Stable: rows that tie keep the worker rows' own order.
export type NeedsEntry = { type: 'worker'; row: QueueRow } | { type: 'other'; need: OtherNeed };

export function mergeNeeds(workerNeeds: QueueRow[], others: OtherNeed[]): NeedsEntry[] {
  const entries: Array<NeedsEntry & { at: number; i: number }> = [
    ...workerNeeds.map((row, i) => ({ type: 'worker' as const, row, at: row.at, i })),
    ...others.map((need, i) => ({ type: 'other' as const, need, at: need.at, i: workerNeeds.length + i })),
  ];
  return entries.sort((a, b) => a.at - b.at || a.i - b.i).map(({ at: _at, i: _i, ...entry }) => entry as NeedsEntry);
}

/// "Up next: Chief of Staff 05:15 · Triage 06:00" — the next few shifts,
/// soonest first. Empty when none is booked.
export function upNextLine(upcoming: UpcomingRow[], count = 3): string {
  const next = [...upcoming].sort((a, b) => a.at - b.at).slice(0, count);
  if (next.length === 0) return '';
  return `Up next: ${next.map((row) => `${row.workerName} ${clockStamp(row.at)}`).join(' · ')}`;
}
