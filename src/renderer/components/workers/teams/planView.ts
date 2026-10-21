// A task's plan laid out as swimlanes: the coordinator's lane first, then one
// per member, one column per stage. A cell holds a piece only where that
// member works that stage; the rest stay empty, so who works when reads at a
// glance. Work handed off from the room after the pack sits past a divider
// rather than looking like part of the approved plan.

import { piecesWaiting, type TeamAssignment, type TeamStage, type TeamTask } from '@shared/flows/team';

export interface PlanLane {
  /// `coordinator`, or the member's worker id.
  id: string;
  name: string;
  workerId?: string;
}

export interface PlanColumn {
  index: number;
  stage: TeamStage;
  /// Lane ids with work in this stage, top to bottom.
  lanes: string[];
  /// Past the pack: handed off from the room.
  afterPack: boolean;
}

export interface PlanLayout {
  lanes: PlanLane[];
  columns: PlanColumn[];
  /// The column index the after-the-pack zone starts at, if any stage is
  /// past the pack.
  packAt?: number;
}

export const COORDINATOR_LANE = 'coordinator';

export function planLayout(task: Pick<TeamTask, 'stages'>): PlanLayout {
  // The coordinator on top, then members in the order the plan first calls
  // on them — so the lanes read down in roughly the order work happens.
  const lanes: PlanLane[] = [{ id: COORDINATOR_LANE, name: 'Coordinator' }];
  const seen = new Set<string>();
  for (const s of task.stages) {
    for (const a of s.assignments) {
      if (seen.has(a.workerId)) continue;
      seen.add(a.workerId);
      lanes.push({ id: a.workerId, name: a.workerName, workerId: a.workerId });
    }
  }
  const row = new Map(lanes.map((l, i) => [l.id, i]));
  const columns = task.stages.map((stage, index): PlanColumn => {
    const ids = stage.assignments.length > 0 ? stage.assignments.map((a) => a.workerId) : [COORDINATOR_LANE];
    return {
      index,
      stage,
      lanes: ids.map((id) => row.get(id)!).sort((a, b) => a - b).map((r) => lanes[r].id),
      afterPack: !!stage.fromRoom,
    };
  });
  const packAt = columns.findIndex((c) => c.afterPack);
  return { lanes, columns, packAt: packAt >= 0 ? packAt : undefined };
}

/// The title a member plays on the team, for a label too narrow for the whole
/// role: "Customer advocate: reviews the feedback" reads "Customer advocate".
/// A role with no colon is all title; a long one is cut at the first clause.
export function roleTitle(role: string | undefined): string {
  const head = (role ?? '').split(':')[0].split(/[.,;—–]| - /)[0].trim();
  return head.length > 40 ? '' : head;
}

/// The member's piece in a stage, if that member has one.
export function pieceIn(stage: TeamStage, workerId: string): TeamAssignment | undefined {
  return stage.assignments.find((a) => a.workerId === workerId);
}

/// "4m", "1h 12m"; under a minute rounds up so a finished stage never reads 0.
export function shortDuration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/// How long a stage took, or has taken so far; absent before it starts.
export function stageMs(stage: Pick<TeamStage, 'startedAt' | 'finishedAt' | 'status'>, now: number): number | undefined {
  if (stage.startedAt === undefined) return undefined;
  return (stage.finishedAt ?? (stage.status === 'running' ? now : stage.startedAt)) - stage.startedAt;
}

/// A stage header's "time · duration": "1:02 PM · 11m" once done, "now · 4m"
/// while it runs, nothing before it starts. `clock` is the desk's clock.
export function stageWhen(stage: Pick<TeamStage, 'status' | 'startedAt' | 'finishedAt'>, now: number, clock: (at: number) => string): string {
  const ms = stageMs(stage, now);
  if (ms === undefined) return stage.status === 'skipped' ? 'Skipped' : '';
  if (stage.status === 'running') return `now · ${shortDuration(ms)}`;
  const at = stage.finishedAt ? clock(stage.finishedAt) : '';
  return [at, ms > 0 ? shortDuration(ms) : ''].filter(Boolean).join(' · ');
}

export type ChipState = 'done' | 'working' | 'waiting' | 'failed' | 'skipped' | 'pending';

/// Where a member's piece stands, for its cell's dot.
export function chipState(a: Pick<TeamAssignment, 'status'>): ChipState {
  switch (a.status) {
    case 'done':
      return 'done';
    case 'running':
      return 'working';
    case 'paused':
      return 'waiting';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

/// A member's cell: "Done", "Working · 4m", "Waiting on you", "Failed".
/// A running piece is timed by its stage: pieces carry no clock of their own.
export function cellLabel(a: Pick<TeamAssignment, 'status'>, stage: Pick<TeamStage, 'status' | 'startedAt' | 'finishedAt'>, now: number): string {
  switch (chipState(a)) {
    case 'done':
      return 'Done';
    case 'working': {
      const ms = stageMs(stage, now);
      return ms === undefined ? 'Working' : `Working · ${shortDuration(ms)}`;
    }
    case 'waiting':
      return 'Waiting on you';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return 'Up next';
  }
}

/// A cell of the plan: a stage, and the lane (`coordinator` or a worker id).
export interface PlanCell {
  stage: number;
  lane: string;
}

/// The cell the detail strip opens on: a piece at work (or waiting on you),
/// else the last one done, else the first piece of the plan.
export function defaultCell(task: Pick<TeamTask, 'stages'>): PlanCell | null {
  const cellsOf = (s: TeamStage, i: number): Array<PlanCell & { status: string }> =>
    s.assignments.length > 0
      ? s.assignments.map((a) => ({ stage: i, lane: a.workerId, status: a.status }))
      : [{ stage: i, lane: COORDINATOR_LANE, status: s.status }];
  const all = task.stages.flatMap(cellsOf);
  const pick = (c: PlanCell & { status: string }): PlanCell => ({ stage: c.stage, lane: c.lane });
  const live = all.find((c) => c.status === 'running' || c.status === 'paused');
  if (live) return pick(live);
  const done = all.filter((c) => c.status === 'done' || c.status === 'failed').at(-1);
  if (done) return pick(done);
  return all[0] ? pick(all[0]) : null;
}

/// The plan header's "N stages, <status>" tail: "all done", "stage 5 running".
export function planStatus(task: Pick<TeamTask, 'status' | 'stages' | 'stageIndex'>): string {
  const total = task.stages.length;
  const finished = task.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  if (total > 0 && finished === total) return 'all done';
  if (task.status === 'cancelled') return `cancelled after ${finished}`;
  if (task.status === 'waiting') return `stopped at stage ${task.stageIndex + 1}`;
  const running = task.stages.findIndex((s) => s.status === 'running');
  if (running >= 0) return `stage ${running + 1} running`;
  return `${finished} done`;
}

export type TaskPillTone = 'accent' | 'working' | 'waiting' | 'done' | 'muted' | 'failed';

/// The task's state as one pill for its tab bar: "Pack ready to review",
/// "Working · stage 5 of 7", "Waiting on you".
export function taskStatusPill(
  task: Pick<TeamTask, 'status' | 'stageIndex' | 'stages' | 'room' | 'waiting'>,
): { tone: TaskPillTone; text: string } {
  const busy = task.room?.busy;
  switch (task.status) {
    case 'running':
      if (piecesWaiting(task).length > 0) return { tone: 'waiting', text: 'Waiting on you' };
      return { tone: 'working', text: `Working · stage ${Math.min(task.stageIndex + 1, task.stages.length)} of ${task.stages.length}` };
    case 'waiting':
      return task.waiting?.reason === 'budget' ? { tone: 'waiting', text: 'Paused at the budget' } : { tone: 'waiting', text: 'Waiting on you' };
    case 'review':
      return busy ? { tone: 'working', text: `${busy.speaker} is answering` } : { tone: 'accent', text: 'Pack ready to review' };
    case 'done':
      return busy ? { tone: 'working', text: `${busy.speaker} is answering` } : { tone: 'done', text: 'Done' };
    case 'failed':
      return { tone: 'failed', text: 'Stopped on a failure' };
    case 'cancelled':
      return { tone: 'muted', text: 'Cancelled' };
    default:
      return { tone: 'muted', text: 'Planning' };
  }
}

/// The tab an arrow key, Home or End moves to in a tab bar, wrapping at the
/// ends; null for any other key.
export function nextTab<T>(ids: readonly T[], current: T, key: string): T | null {
  const i = ids.indexOf(current);
  if (i < 0 || ids.length === 0) return null;
  if (key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

/// The opening of a brief, for a one-line fold: its first sentence or line,
/// cut at a word near `max` with an ellipsis.
export function briefOpening(brief: string, max = 140): string {
  const flat = brief.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
}
