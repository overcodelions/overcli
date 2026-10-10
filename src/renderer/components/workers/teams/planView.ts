// A task's plan laid out as swimlanes: one lane for the coordinator and one
// per member, one column per stage. Members working the same stage share a
// column, so what runs in parallel reads as parallel, and work handed off from
// the room after the pack sits past a line rather than looking like part of
// the approved plan.

import type { TeamAssignment, TeamStage, TeamTask } from '@shared/flows/team';

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
  /// The first and last lane (as indexes into `lanes` of the plan) holding
  /// work here, when more than one does: what the parallel line joins.
  span?: [number, number];
  /// Past the pack: handed off from the room.
  afterPack: boolean;
  /// How long the stage took, or has taken so far; absent before it starts.
  ms?: number;
}

export interface PlanLayout {
  lanes: PlanLane[];
  columns: PlanColumn[];
  /// The column index the after-the-pack zone starts at, if any stage is
  /// past the pack.
  packAt?: number;
}

export const COORDINATOR_LANE = 'coordinator';

export function planLayout(task: Pick<TeamTask, 'stages'>, now: number): PlanLayout {
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
    const rows = ids.map((id) => row.get(id)!).sort((a, b) => a - b);
    return {
      index,
      stage,
      lanes: rows.map((r) => lanes[r].id),
      span: rows.length > 1 ? [rows[0], rows[rows.length - 1]] : undefined,
      afterPack: !!stage.fromRoom,
      ms: stage.startedAt ? (stage.finishedAt ?? (stage.status === 'running' ? now : stage.startedAt)) - stage.startedAt : undefined,
    };
  });

  const packAt = columns.findIndex((c) => c.afterPack);
  return { lanes, columns, packAt: packAt >= 0 ? packAt : undefined };
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
