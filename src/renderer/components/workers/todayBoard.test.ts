import { describe, expect, it } from 'vitest';

import type { TeamStage, TeamTask } from '@shared/flows/team';
import type { ProcessStage } from '@shared/org/process';
import type { ProcessItemView } from '@shared/types';

import {
  buildTodayBoard,
  mergeNeeds,
  otherNeedsCount,
  teamAsk,
  teamNowLine,
  upNextLine,
  workerNowLine,
  type ProcessBoardData,
} from './todayBoard';
import type { QueueRow, UpcomingRow } from './workQueue';

const T0 = new Date('2026-10-20T09:00:00').getTime();
const MIN = 60_000;

function stage(title: string, over: Partial<TeamStage> = {}): TeamStage {
  return { kind: 'contribute', title, assignments: [], status: 'pending', ...over } as TeamStage;
}

function task(id: string, over: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    teamId: 'team-acme',
    teamName: 'Acme Launch',
    brief: `Brief for ${id}\nmore`,
    status: 'running',
    createdAt: T0,
    updatedAt: T0,
    stages: [],
    stageIndex: 0,
    spentUSD: 0,
    budgetUSD: 10,
    folder: '/tmp/acme',
    files: [],
    ...over,
  } as TeamTask;
}

function row(key: string, over: Partial<QueueRow> = {}): QueueRow {
  return { key, workerId: 'w1', workerName: 'Scout', task: 'errand', status: 'running', title: key, steps: [], at: T0, ...over } as QueueRow;
}

const STAGES: ProcessStage[] = [
  { id: 'build', name: 'Build', kind: 'team', teamId: 'team-acme' },
  { id: 'signoff', name: 'Sign-off', kind: 'people', approvers: [{ name: 'You' }] },
  { id: 'ship', name: 'Ship', kind: 'team', teamId: 'team-acme' },
];

function item(id: string, over: Partial<ProcessItemView> = {}): ProcessItemView {
  return {
    id,
    processId: 'proc-1',
    title: `Item ${id}`,
    brief: '',
    initiator: { name: 'You' },
    source: 'desktop',
    stageIndex: 0,
    status: 'active',
    artifacts: [],
    history: [],
    createdAt: T0,
    updatedAt: T0,
    stageName: 'Build',
    canDecide: false,
    yourTurn: false,
    canSteer: true,
    ...over,
  } as ProcessItemView;
}

function proc(items: ProcessItemView[]): ProcessBoardData {
  return { process: { id: 'proc-1', name: 'Acme release', stages: STAGES }, items };
}

describe('teamAsk', () => {
  it('names what each waiting state asks of you', () => {
    expect(teamAsk(task('a', { status: 'questions' }))).toBe('Answer its questions');
    expect(teamAsk(task('a', { status: 'proposed' }))).toBe('Approve the plan');
    expect(teamAsk(task('a', { status: 'review' }))).toBe('Review the pack');
    expect(teamAsk(task('a', { status: 'waiting', waiting: { reason: 'checkpoint', message: 'Read the draft first' } }))).toBe(
      'Read the draft first',
    );
    expect(teamAsk(task('a', { status: 'waiting', waiting: { reason: 'budget', message: '' } }))).toBe('Paused at the budget');
  });

  it('names a running piece that is stopped for you', () => {
    const piece = (workerName: string, waitingFor?: string) => ({ workerId: workerName, workerName, ask: '', status: 'paused' as const, runId: `run-${workerName}`, waitingFor });
    const stages = (...assignments: ReturnType<typeof piece>[]) => [{ kind: 'contribute' as const, title: 's', status: 'running' as const, assignments }];
    expect(teamAsk(task('a', { stages: stages(piece('Hugo', 'wants your OK to use bash')) }))).toBe('Hugo wants your OK to use bash');
    expect(teamAsk(task('a', { stages: stages(piece('Hugo', 'has a question for you'), piece('Dana', 'wants your OK to use bash')) }))).toBe(
      'Hugo, Dana are waiting on you',
    );
    // Held by you: not a decision it is waiting on.
    expect(teamAsk(task('a', { stages: stages(piece('Hugo')) }))).toBeNull();
  });

  it('leaves out work that moves without you', () => {
    expect(teamAsk(task('a', { status: 'running' }))).toBeNull();
    expect(teamAsk(task('a', { status: 'planning' }))).toBeNull();
    expect(teamAsk(task('a', { status: 'waiting', waiting: { reason: 'away', message: 'Held' } }))).toBeNull();
    expect(teamAsk(task('a', { status: 'done' }))).toBeNull();
  });
});

describe('now lines', () => {
  it('says which step a worker run is on', () => {
    expect(
      workerNowLine(
        row('r', {
          steps: [
            { id: 'research', state: 'done' },
            { id: 'write', state: 'current' },
            { id: 'review', state: 'ahead' },
          ],
        }),
      ),
    ).toBe('Step 2 of 3 · write');
    expect(workerNowLine(row('r', { status: 'planning', note: 'reading the tracker' }))).toBe('Planning · reading the tracker');
  });

  it('says the stage, who is on it and how many are done for a team task', () => {
    const t = task('a', {
      stageIndex: 1,
      stages: [
        stage('Gather', { status: 'done' }),
        stage('Draft', {
          status: 'running',
          assignments: [
            { workerId: 'w1', workerName: 'Scout', ask: '', status: 'running' },
            { workerId: 'w2', workerName: 'Quill', ask: '', status: 'done' },
          ],
        }),
        stage('Pack', { kind: 'synthesize' }),
      ],
    });
    expect(teamNowLine(t)).toBe('Draft · Scout, 1 done');
    expect(teamNowLine(task('b', { status: 'planning' }))).toBe('Planning · Coordinator');
  });
});

describe('buildTodayBoard', () => {
  it('gathers team and process decisions, oldest first', () => {
    const board = buildTodayBoard({
      working: [],
      tasks: {
        a: task('a', { status: 'proposed', title: 'Acme pricing page', updatedAt: T0 + 5 * MIN }),
        b: task('b', { status: 'running' }),
      },
      processes: [
        proc([
          item('i1', {
            stageIndex: 1,
            stageName: 'Sign-off',
            canDecide: true,
            yourTurn: true,
            history: [{ at: T0 + 2 * MIN, kind: 'entered', stageId: 'signoff' }],
          }),
        ]),
      ],
    });
    expect(board.needs.map((n) => [n.kind, n.title, n.ask])).toEqual([
      ['process', 'Item i1', 'Decide: Sign-off'],
      ['team', 'Acme pricing page', 'Approve the plan'],
    ]);
    expect(board.needs[0].target).toEqual({ kind: 'process', processId: 'proc-1', itemId: 'i1' });
    expect(board.needs[1].target).toEqual({ kind: 'team', taskId: 'a', teamId: 'team-acme' });
  });

  it('lists everything moving, stuck first then newest, with a track per stage', () => {
    const board = buildTodayBoard({
      working: [
        row('run-old', { at: T0, steps: [{ id: 'a', state: 'done' }, { id: 'b', state: 'current' }] }),
        row('run-new', { at: T0 + 30 * MIN }),
      ],
      tasks: {
        t: task('t', {
          createdAt: T0 + 10 * MIN,
          stageIndex: 0,
          stages: [stage('Gather', { status: 'running' }), stage('Pack')],
        }),
      },
      processes: [proc([item('i2', { createdAt: T0 - 60 * MIN, blocked: 'The branch is gone', stageNote: 'building' })])],
    });
    expect(board.flight.map((r) => r.key)).toEqual(['process:i2', 'worker:run-new', 'team:t', 'worker:run-old']);
    expect(board.flight[0]).toMatchObject({ stuck: true, now: 'Build · stuck: The branch is gone', track: ['stuck', 'ahead', 'ahead'] });
    expect(board.flight[2]).toMatchObject({ kind: 'team', track: ['now', 'ahead'] });
    expect(board.flight[3]).toMatchObject({ now: 'Step 2 of 2 · b', track: ['done', 'now'] });
  });

  it('says a process item where it is, and does not list a process stage’s team task twice', () => {
    const board = buildTodayBoard({
      working: [row('piece', { team: { teamId: 'team-acme', teamName: 'Acme Launch', taskId: 't' } })],
      tasks: { t: task('t', { stages: [stage('Gather', { status: 'running' })] }) },
      processes: [proc([item('i3', { taskId: 't', stageNote: 'Acme Launch is gathering' })])],
    });
    expect(board.flight.map((r) => r.key)).toEqual(['process:i3']);
    expect(board.flight[0].now).toBe('Build · Acme Launch is gathering');
    expect(board.pinnedTasks.has('t')).toBe(true);
  });

  it('keeps a team piece as a worker row in one worker’s inbox', () => {
    const board = buildTodayBoard({
      working: [row('piece', { team: { teamId: 'team-acme', teamName: 'Acme Launch', taskId: 't' } })],
      tasks: {},
      processes: [],
      groupTeams: false,
    });
    expect(board.flight.map((r) => r.kind)).toEqual(['worker']);
  });

  it('asks you to sign off a pack your team holds at a process stage', () => {
    const board = buildTodayBoard({ working: [], tasks: {}, processes: [proc([item('i', { stageIndex: 0, yourTurn: true, ownerTurn: 'pack' })])] });
    expect(board.needs.map((n) => n.ask)).toEqual([`Sign off the pack: ${STAGES[0].name}`]);
    expect(board.flight).toEqual([]);
  });

  it('leaves a worker stage’s paused run to the run’s own row in Needs you', () => {
    const stages: ProcessStage[] = [{ id: 'fix', name: 'Fix', kind: 'worker', workerId: 'w-triage' }];
    const board = buildTodayBoard({
      working: [],
      tasks: {},
      processes: [{ process: { id: 'proc-1', name: 'Acme bugs', stages }, items: [item('i', { stageIndex: 0, yourTurn: true, ownerTurn: 'paused' })] }],
    });
    expect(board.needs).toEqual([]);
    expect(board.flight[0].now).toBe('Fix · waiting on you: its run is paused');
  });

  it('counts other decisions for the rail', () => {
    expect(
      otherNeedsCount(
        { a: task('a', { status: 'questions' }), b: task('b', { status: 'review' }), c: task('c', { status: 'done' }) },
        [proc([item('i', { stageIndex: 1, canDecide: true, yourTurn: true }), item('j', { stageIndex: 1, canDecide: false })])],
      ),
    ).toBe(3);
  });
});

describe('mergeNeeds', () => {
  it('interleaves worker runs and other decisions by how long they have waited', () => {
    const board = buildTodayBoard({ working: [], tasks: { a: task('a', { status: 'review', updatedAt: T0 + 5 * MIN }) }, processes: [] });
    const merged = mergeNeeds([row('r1', { at: T0 }), row('r2', { at: T0 + 10 * MIN })], board.needs);
    expect(merged.map((e) => (e.type === 'worker' ? e.row.key : e.need.key))).toEqual(['r1', 'team:a', 'r2']);
  });
});

describe('upNextLine', () => {
  it('lists the next three shifts, soonest first', () => {
    const up = (workerName: string, at: number): UpcomingRow => ({
      workerId: workerName,
      workerName,
      at,
      cadence: '',
      imminent: false,
      overdue: false,
    });
    const line = upNextLine([up('Late', T0 + 240 * MIN), up('Chief of Staff', T0 - 225 * MIN), up('Triage', T0), up('Scout', T0 + 60 * MIN)]);
    expect(line).toBe('Up next: Chief of Staff 05:15 · Triage 09:00 · Scout 10:00');
    expect(upNextLine([])).toBe('');
  });
});
