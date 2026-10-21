import { describe, expect, it } from 'vitest';
import {
  COORDINATOR_LANE,
  briefOpening,
  cellLabel,
  chipState,
  defaultCell,
  nextTab,
  pieceIn,
  planLayout,
  planStatus,
  roleTitle,
  shortDuration,
  stageMs,
  stageWhen,
  taskStatusPill,
} from './planView';
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
    expect(planLayout({ stages }).lanes.map((l) => l.id)).toEqual([COORDINATOR_LANE, 'maya', 'ade', 'rook']);
  });

  it('places coordinator stages in the coordinator lane and members in theirs', () => {
    const { columns } = planLayout({ stages });
    expect(columns.map((c) => c.lanes)).toEqual([
      ['maya', 'ade'],
      [COORDINATOR_LANE],
      ['rook'],
      ['maya', 'ade'],
      [COORDINATOR_LANE],
    ]);
  });

  it('marks where the work handed off from the room begins', () => {
    const layout = planLayout({ stages: [...stages, stage('contribute', [piece('maya')], { fromRoom: { messageId: 'm1', exchange: 0 } })] });
    expect(layout.packAt).toBe(5);
    expect(layout.columns.map((c) => c.afterPack)).toEqual([false, false, false, false, false, true]);
    expect(planLayout({ stages }).packAt).toBeUndefined();
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

describe('roleTitle', () => {
  it('keeps the part before the colon', () => {
    expect(roleTitle('Customer advocate: reviews the feedback and unmet demand')).toBe('Customer advocate');
  });
  it('takes a role with no colon whole, or its first clause', () => {
    expect(roleTitle('Report writer')).toBe('Report writer');
    expect(roleTitle('Challenger, attacks the case')).toBe('Challenger');
  });
  it('drops a title too long to be one', () => {
    expect(roleTitle('Reviews every ticket the customer opened in the last quarter and more')).toBe('');
    expect(roleTitle(undefined)).toBe('');
  });
});

describe('chipState', () => {
  it('maps a piece to its dot', () => {
    expect(chipState({ status: 'done' })).toBe('done');
    expect(chipState({ status: 'running' })).toBe('working');
    expect(chipState({ status: 'paused' })).toBe('waiting');
    expect(chipState({ status: 'failed' })).toBe('failed');
    expect(chipState({ status: 'skipped' })).toBe('skipped');
    expect(chipState({ status: 'pending' })).toBe('pending');
  });
});

describe('taskStatusPill', () => {
  const stages = [stage('contribute', []), stage('draft', []), stage('synthesize', [])];
  it('says where the task stands', () => {
    expect(taskStatusPill({ status: 'running', stageIndex: 1, stages })).toEqual({ tone: 'working', text: 'Working · stage 2 of 3' });
    expect(taskStatusPill({ status: 'review', stageIndex: 2, stages })).toEqual({ tone: 'accent', text: 'Pack ready to review' });
    expect(taskStatusPill({ status: 'waiting', stageIndex: 1, stages, waiting: { reason: 'failed', message: '' } }).text).toBe('Waiting on you');
    expect(taskStatusPill({ status: 'waiting', stageIndex: 1, stages, waiting: { reason: 'budget', message: '' } }).text).toBe('Paused at the budget');
  });
  it('says a running task with a piece stopped for you is waiting on you', () => {
    const paused: TeamAssignment = { workerId: 'h', workerName: 'Hugo', ask: '', status: 'paused', waitingFor: 'wants your OK to use bash' };
    const live = [stage('contribute', [paused], { status: 'running' }), ...stages.slice(1)];
    expect(taskStatusPill({ status: 'running', stageIndex: 0, stages: live })).toEqual({ tone: 'waiting', text: 'Waiting on you' });
  });
  it('says who is answering in the conversation', () => {
    expect(taskStatusPill({ status: 'review', stageIndex: 2, stages, room: { messages: [], busy: { speaker: 'Coordinator', since: 0 } } }).text).toBe(
      'Coordinator is answering',
    );
  });
});

describe('nextTab', () => {
  const ids = ['pack', 'conversation', 'plan'];
  it('moves with the arrows and wraps', () => {
    expect(nextTab(ids, 'pack', 'ArrowRight')).toBe('conversation');
    expect(nextTab(ids, 'plan', 'ArrowRight')).toBe('pack');
    expect(nextTab(ids, 'pack', 'ArrowLeft')).toBe('plan');
    expect(nextTab(ids, 'conversation', 'Home')).toBe('pack');
    expect(nextTab(ids, 'conversation', 'End')).toBe('plan');
    expect(nextTab(ids, 'pack', 'a')).toBeNull();
  });
});

describe('stageWhen', () => {
  const clock = (at: number) => `t${at}`;
  it('says when a stage finished and how long it took', () => {
    expect(stageWhen(stage('contribute', [], { startedAt: 0, finishedAt: 11 * 60_000 }), 0, clock)).toBe(`t${11 * 60_000} · 11m`);
  });
  it('counts a running stage up to now', () => {
    expect(stageWhen(stage('draft', [], { status: 'running', startedAt: 0 }), 4 * 60_000, clock)).toBe('now · 4m');
  });
  it('is blank before a stage starts', () => {
    expect(stageWhen(stage('draft', [], { status: 'pending' }), 9, clock)).toBe('');
    expect(stageMs(stage('draft', [], { status: 'pending' }), 9)).toBeUndefined();
  });
});

describe('cellLabel', () => {
  const running = stage('contribute', [], { status: 'running', startedAt: 0 });
  it('reads a piece plainly, timing one at work by its stage', () => {
    expect(cellLabel({ status: 'done' }, running, 0)).toBe('Done');
    expect(cellLabel({ status: 'running' }, running, 4 * 60_000)).toBe('Working · 4m');
    expect(cellLabel({ status: 'paused' }, running, 0)).toBe('Waiting on you');
    expect(cellLabel({ status: 'failed' }, running, 0)).toBe('Failed');
    expect(cellLabel({ status: 'pending' }, stage('respond', [], { status: 'pending' }), 0)).toBe('Up next');
  });
});

describe('defaultCell', () => {
  it('opens on a piece at work', () => {
    const stages = [stage('contribute', [piece('wes')]), stage('draft', []), stage('challenge', [piece('rook', { status: 'running' })], { status: 'running' })];
    expect(defaultCell({ stages })).toEqual({ stage: 2, lane: 'rook' });
  });
  it('else on the last one done, the coordinator’s included', () => {
    const stages = [stage('contribute', [piece('wes'), piece('ada')]), stage('draft', []), stage('challenge', [piece('rook', { status: 'pending' })], { status: 'pending' })];
    expect(defaultCell({ stages })).toEqual({ stage: 1, lane: COORDINATOR_LANE });
    expect(defaultCell({ stages: stages.slice(0, 1) })).toEqual({ stage: 0, lane: 'ada' });
  });
  it('else the first piece, or nothing in an empty plan', () => {
    expect(defaultCell({ stages: [stage('contribute', [piece('wes', { status: 'pending' })], { status: 'pending' })] })).toEqual({ stage: 0, lane: 'wes' });
    expect(defaultCell({ stages: [] })).toBeNull();
  });
});

describe('planStatus', () => {
  const s = (status: TeamStage['status']) => stage('contribute', [], { status });
  it('says how far the plan has got', () => {
    expect(planStatus({ status: 'review', stageIndex: 2, stages: [s('done'), s('skipped'), s('done')] })).toBe('all done');
    expect(planStatus({ status: 'running', stageIndex: 1, stages: [s('done'), s('running'), s('pending')] })).toBe('stage 2 running');
    expect(planStatus({ status: 'waiting', stageIndex: 1, stages: [s('done'), s('failed'), s('pending')] })).toBe('stopped at stage 2');
    expect(planStatus({ status: 'cancelled', stageIndex: 1, stages: [s('done'), s('pending')] })).toBe('cancelled after 1');
  });
});

describe('briefOpening', () => {
  it('keeps a short brief whole, on one line', () => {
    expect(briefOpening('Review the spend.\n\nPlan the year.')).toBe('Review the spend. Plan the year.');
  });
  it('cuts a long one at a word', () => {
    const out = briefOpening('Review everything you can find about the Acme accounts and then plan the year in detail', 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out).toBe('Review everything you can find about…');
  });
});
