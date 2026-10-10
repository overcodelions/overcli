import { describe, expect, it } from 'vitest';
import { COORDINATOR_LANE, pieceIn, planLayout, shortDuration } from './planView';
import type { TeamAssignment, TeamStage } from '@shared/flows/team';

const piece = (workerId: string, extra: Partial<TeamAssignment> = {}): TeamAssignment => ({
  workerId,
  workerName: workerId[0].toUpperCase() + workerId.slice(1),
  ask: 'do it',
  status: 'done',
  ...extra,
});
const stage = (kind: TeamStage['kind'], assignments: TeamAssignment[], extra: Partial<TeamStage> = {}): TeamStage => ({
  kind,
  title: kind,
  assignments,
  status: 'done',
  ...extra,
});

describe('planLayout', () => {
  const stages = [
    stage('contribute', [piece('maya'), piece('ade')]),
    stage('draft', []),
    stage('challenge', [piece('rook')]),
    stage('respond', [piece('ade'), piece('maya')]),
    stage('synthesize', []),
  ];

  it('puts the coordinator on top, then members in the order the plan calls on them', () => {
    expect(planLayout({ stages }, 0).lanes.map((l) => l.id)).toEqual([COORDINATOR_LANE, 'maya', 'ade', 'rook']);
  });

  it('places coordinator stages in the coordinator lane and members in theirs', () => {
    const { columns } = planLayout({ stages }, 0);
    expect(columns.map((c) => c.lanes)).toEqual([
      ['maya', 'ade'],
      [COORDINATOR_LANE],
      ['rook'],
      ['maya', 'ade'],
      [COORDINATOR_LANE],
    ]);
  });

  it('spans parallel pieces from the first lane to the last, and only those', () => {
    const { columns } = planLayout(
      { stages: [stage('contribute', [piece('maya'), piece('ade')]), stage('contribute', [piece('rook'), piece('maya')])] },
      0,
    );
    expect(columns.map((c) => c.span)).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(planLayout({ stages }, 0).columns[2].span).toBeUndefined();
  });

  it('marks where the work handed off from the room begins', () => {
    const layout = planLayout(
      { stages: [...stages, stage('contribute', [piece('maya')], { fromRoom: { messageId: 'm1', exchange: 0 } })] },
      0,
    );
    expect(layout.packAt).toBe(5);
    expect(layout.columns.map((c) => c.afterPack)).toEqual([false, false, false, false, false, true]);
    expect(planLayout({ stages }, 0).packAt).toBeUndefined();
  });

  it('times finished stages, and running ones up to now', () => {
    const { columns } = planLayout(
      {
        stages: [
          stage('contribute', [piece('maya')], { startedAt: 1_000, finishedAt: 61_000 }),
          stage('draft', [], { status: 'running', startedAt: 100_000 }),
          stage('synthesize', [], { status: 'pending' }),
        ],
      },
      400_000,
    );
    expect(columns.map((c) => c.ms)).toEqual([60_000, 300_000, undefined]);
  });
});

describe('pieceIn', () => {
  it('finds the member’s piece in a stage', () => {
    expect(pieceIn(stage('contribute', [piece('maya'), piece('ade')]), 'ade')?.workerName).toBe('Ade');
    expect(pieceIn(stage('draft', []), 'ade')).toBeUndefined();
  });
});

describe('shortDuration', () => {
  it('reads in minutes, then hours', () => {
    expect(shortDuration(10_000)).toBe('1m');
    expect(shortDuration(29 * 60_000)).toBe('29m');
    expect(shortDuration(60 * 60_000)).toBe('1h');
    expect(shortDuration(98 * 60_000)).toBe('1h 38m');
  });
});
