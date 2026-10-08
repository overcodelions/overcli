import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { Worker } from '@shared/flows/worker';
import {
  BOARD_GROUPS,
  DAY_MARKS,
  boardGroup,
  boardLine,
  boardReasons,
  dayProgress,
  dayTicks,
  foldSummary,
  groupByProject,
  teamOnlyIds,
  groupBoard,
  railDropIndex,
  railMark,
  tickKind,
  workerNow,
  type BoardEntry,
} from './workerBoard';
import { startOfDay, toWorkerActivity, type WorkerActivity } from './workerDeskSelectors';

const NOON = new Date(2026, 8, 3, 12, 0, 0).getTime();

function worker(id = 'worker-1', overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    name: 'Spec Hygiene',
    jobDescription: 'Keep project checks healthy and useful.',
    projectPath: '/workspace',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'probation',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 10,
    heartbeatModel: 'model',
    flowIds: ['flow'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function batch(
  id: string,
  at: number,
  statuses: string[] = [],
  extra: { task?: 'shift' | 'errand'; title?: string } = {},
): Orchestration {
  return {
    id,
    title: extra.title ?? `[Shift ${id}] Spec Hygiene`,
    projectPath: '/workspace',
    maxConcurrent: 1,
    origin: {
      kind: 'worker',
      workerId: 'worker-1',
      workerName: 'Spec Hygiene',
      task: extra.task,
    },
    createdAt: at,
    items: statuses.map((status, index) => ({
      candidate: { id: `${id}-${index}`, title: `Candidate ${index}`, prompt: 'p' },
      flowId: 'flow',
      status: status as any,
    })),
  };
}

function activity(
  id: string,
  at: number,
  statuses: string[] = [],
  extra: { task?: 'shift' | 'errand'; title?: string } = {},
): WorkerActivity {
  return toWorkerActivity(batch(id, at, statuses, extra));
}

function entry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    worker: worker(),
    review: 0,
    pausedRuns: 0,
    home: '',
    runs: [],
    starved: false,
    live: false,
    today: [],
    recent: [],
    newest: null,
    target: null,
    ...overrides,
  };
}

describe('board grouping', () => {
  it('puts a worker in exactly one group, most urgent first', () => {
    // A worker that is BOTH waiting on you and mid-turn belongs under
    // "Needs you" — the one place a person has to look — and not in both.
    const both = entry({ review: 2, live: true, today: [activity('1', NOON)] });
    expect(boardGroup(both)).toBe('needsYou');

    expect(boardGroup(entry({ pausedRuns: 1 }))).toBe('needsYou');
    expect(boardGroup(entry({ starved: true }))).toBe('needsYou');
    expect(boardGroup(entry({ live: true, today: [activity('1', NOON)] }))).toBe('running');
    expect(boardGroup(entry({ today: [activity('1', NOON)] }))).toBe('today');
    expect(boardGroup(entry())).toBe('quiet');
  });

  it('benches a disabled worker whatever else is true of it', () => {
    // A paused worker with proposals still owing is still off the board: you
    // cannot act on its work until you re-enable it, so "Needs you" would be
    // sending you somewhere that cannot proceed.
    const off = entry({ worker: worker('w', { enabled: false }), review: 3, live: true });
    expect(boardGroup(off)).toBe('bench');
  });

  it('splits the roster while preserving funding order inside each group', () => {
    const first = entry({ worker: worker('a'), today: [activity('1', NOON)] });
    const second = entry({ worker: worker('b'), review: 1 });
    const third = entry({ worker: worker('c'), today: [activity('2', NOON)] });
    const groups = groupBoard([first, second, third]);
    expect(groups.today.map((e) => e.worker.id)).toEqual(['a', 'c']);
    expect(groups.needsYou.map((e) => e.worker.id)).toEqual(['b']);
    // Every group exists even when empty, so callers never guard on undefined.
    for (const id of BOARD_GROUPS) expect(Array.isArray(groups[id])).toBe(true);
  });

  it('spells out every reason a worker is waiting on a person', () => {
    expect(boardReasons(entry({ review: 3, pausedRuns: 1, starved: true }))).toBe(
      '3 to review · a flow paused · unfunded',
    );
    expect(boardReasons(entry({ pausedRuns: 2 }))).toBe('2 flows paused');
    expect(boardReasons(entry())).toBe('');
  });
});

describe('the row’s second line', () => {
  it('joins what is waiting with what is happening rather than choosing', () => {
    const line = boardLine(entry({ review: 3 }), 'on your errand', 'tagline');
    expect(line).toBe('3 to review · on your errand');
  });

  it('falls back to the last turn’s outcome, then to the tagline', () => {
    const shift = entry({ today: [activity('1', NOON, ['done', 'done'])] });
    expect(boardLine(shift, null, 'tagline')).toBe('2 done');

    // An errand is named by the worker; the name beats its tally.
    const errand = entry({
      today: [activity('2', NOON, ['done'], { task: 'errand', title: 'Draft the RCA' })],
    });
    expect(boardLine(errand, null, 'tagline')).toBe('Draft the RCA');

    expect(boardLine(entry(), null, 'tagline')).toBe('tagline');
    // Nothing to say renders as no line at all.
    expect(boardLine(entry(), null, '')).toBeNull();
  });

  it('reaches back past today for a worker that last worked on Tuesday', () => {
    const stale = entry({ newest: activity('1', NOON - 3 * 86_400_000, ['done']) });
    expect(boardLine(stale, null, 'tagline')).toBe('1 done');
  });
});

describe('the day strip', () => {
  it('places a tick by its time of day', () => {
    const day = startOfDay(NOON);
    const ticks = dayTicks(
      [activity('1', day + 6 * 3_600_000), activity('2', day + 18 * 3_600_000)],
      NOON,
    );
    expect(ticks.map((t) => t.pos)).toEqual([0.25, 0.75]);
    // Oldest first, so the row reads left to right like the rule under it.
    expect(ticks.map((t) => t.id)).toEqual(['1', '2']);
  });

  it('drops turns from other days rather than clamping them to an edge', () => {
    const yesterday = activity('old', NOON - 86_400_000);
    expect(dayTicks([yesterday], NOON)).toEqual([]);
  });

  it('puts a ruler mark exactly where that hour\u2019s tick lands', () => {
    // The reason this test exists: the header first drew the marks with
    // `justify-between`, which pinned "6a" to 0.0 and "6p" to 1.0 — both
    // midnight — under ticks that were placed correctly the whole time.
    const day = startOfDay(NOON);
    for (const mark of DAY_MARKS) {
      const hour = day + mark.pos * 24 * 3_600_000;
      expect(dayTicks([activity(mark.label, hour)], NOON)[0].pos).toBe(mark.pos);
    }
    expect(DAY_MARKS.map((m) => m.label)).toEqual(['6a', '12p', '6p']);
  });

  it('colours a tick by what it wants from you', () => {
    expect(tickKind(activity('1', NOON, ['running']))).toBe('running');
    // Running outranks waiting: the turn is still moving.
    expect(tickKind(activity('2', NOON, ['running', 'proposed']))).toBe('running');
    expect(tickKind(activity('3', NOON, ['proposed']))).toBe('review');
    expect(tickKind(activity('4', NOON, ['done'], { task: 'errand' }))).toBe('errand');
    expect(tickKind(activity('5', NOON, ['done']))).toBe('shift');
  });
});

describe('project labels', () => {
  it('keeps the line about status, so the row can draw the project itself', () => {
    // The project is not in `boardLine`: the row draws it ahead of this text
    // in its own tone, and colour on this board is reserved for state.
    expect(boardLine(entry({ review: 3 }), 'running', 'tagline')).toBe('3 to review · running');
    expect(boardLine(entry(), null, '')).toBeNull();
  });
});

describe('dayProgress', () => {
  it('reads noon as half the day, on the same rule the ticks use', () => {
    expect(dayProgress(NOON)).toBeCloseTo(0.5, 5);
  });

  it('puts midnight at the very start, so nothing of the day is shaded yet', () => {
    expect(dayProgress(startOfDay(NOON))).toBe(0);
  });

  it('stays inside the rule at the last minute of the day', () => {
    const lastMinute = startOfDay(NOON) + 24 * 60 * 60 * 1000 - 60_000;
    const progress = dayProgress(lastMinute);
    expect(progress).toBeLessThanOrEqual(1);
    expect(progress).toBeGreaterThan(0.999);
  });

  it('agrees with dayTicks about where a turn sits', () => {
    // The shading and the ticks are two readings of one clock; if they ever
    // disagree the strip draws a turn in a future it has already shaded.
    const [tick] = dayTicks([activity('turn-1', NOON)], NOON);
    expect(tick.pos).toBeCloseTo(dayProgress(NOON), 5);
  });
});

describe('railMark', () => {
  it('splits needs-you into waiting on a decision and stopped', () => {
    expect(railMark(entry({ review: 2 }))).toBe('waiting');
    expect(railMark(entry({ review: 1, pausedRuns: 1 }))).toBe('waiting');
    expect(railMark(entry({ pausedRuns: 1 }))).toBe('stopped');
    expect(railMark(entry({ starved: true }))).toBe('stopped');
  });

  it('otherwise follows the board group', () => {
    expect(railMark(entry({ live: true }))).toBe('running');
    expect(railMark(entry())).toBe('quiet');
    expect(railMark(entry({ worker: worker('w', { enabled: false }), review: 3 }))).toBe('bench');
  });
});

describe('railDropIndex', () => {
  const ordered = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('lands before or after the target in full roster order', () => {
    expect(railDropIndex(ordered, 'b', false)).toBe(1);
    expect(railDropIndex(ordered, 'b', true)).toBe(2);
    expect(railDropIndex(ordered, 'c', true)).toBe(3);
  });

  it('is null for a target that is not on the roster', () => {
    expect(railDropIndex(ordered, 'zz', false)).toBeNull();
  });
});

describe('workerNow', () => {
  const daily = { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] } as Worker['cadence'];
  const now = 1_000_000_000;

  it('says a paused worker is on the bench even mid-turn', () => {
    expect(workerNow({ enabled: false, cadence: daily }, { task: 'shift', text: 'x', tools: [] }, true, null, now).tone).toBe('bench');
  });

  it('carries the newest streamed line of a running turn, stripped of markdown', () => {
    const out = workerNow({ enabled: true, cadence: daily }, { task: 'errand', text: 'Looking around\n\n## **Reading the CI logs**', tools: ['Read'] }, false, null, now);
    expect(out).toEqual({ tone: 'running', label: 'On your errand', detail: 'Reading the CI logs' });
  });

  it('falls back to the tool, then to getting started', () => {
    expect(workerNow({ enabled: true, cadence: daily }, { task: 'shift', text: '', tools: ['Grep'] }, false, null, now).detail).toBe('using Grep');
    expect(workerNow({ enabled: true, cadence: daily }, { task: 'shift', text: '  ', tools: [] }, false, null, now).detail).toBe('getting started…');
  });

  it('says when an idle worker next works', () => {
    expect(workerNow({ enabled: true, cadence: null }, undefined, false, null, now).detail).toBe('works when you ask');
    expect(workerNow({ enabled: true, cadence: daily }, undefined, false, now + 3 * 3_600_000, now).detail).toMatch(/^next shift in 3h · /);
    expect(workerNow({ enabled: true, cadence: daily }, undefined, true, null, now).label).toBe('Running a flow');
  });
});

describe('the rail with a big crew', () => {
  it('reaches team-only hires through their team', () => {
    const crew = [
      worker('theo', { hiredFor: { teamName: 'Release Crew' }, cadence: null }),
      worker('shifty', { hiredFor: { teamName: 'Release Crew' } }),
      worker('loose', { hiredFor: { teamName: 'Gone' }, cadence: null }),
      worker('lena'),
    ];
    const teams = [{ members: [{ workerId: 'theo' }, { workerId: 'shifty' }, { workerId: 'lena' }] }];
    // Given shifts, or off every team, a hire is back on the crew list.
    expect([...teamOnlyIds(crew, teams)]).toEqual(['theo']);
  });

  it('groups by project in roster order, first appearance first', () => {
    const rows = [
      entry({ worker: worker('a', { projectPath: '/acme' }) }),
      entry({ worker: worker('b', { projectPath: '/overcli' }) }),
      entry({ worker: worker('c', { projectPath: '/acme' }) }),
    ];
    const groups = groupByProject(rows, (p) => p.slice(1));
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.worker.id)])).toEqual([
      ['acme', ['a', 'c']],
      ['overcli', ['b']],
    ]);
  });

  it('sums up a folded group by what you would act on', () => {
    const rows = [
      entry({ worker: worker('a'), review: 1 }),
      entry({ worker: worker('b'), review: 2 }),
      entry({ worker: worker('c'), live: true, today: [activity('1', NOON)] }),
      entry({ worker: worker('d') }),
    ];
    expect(foldSummary(rows)).toEqual([
      { text: '2 need you', tone: 'waiting' },
      { text: '1 working', tone: 'running' },
    ]);
    expect(foldSummary([entry()])).toEqual([]);
  });
});
