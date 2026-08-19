import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { Schedule } from '@shared/flows/schedule';
import type { Worker } from '@shared/flows/worker';

import {
  SHIFT_MINUTES,
  calendarWindow,
  dayLoad,
  entryKey,
  isNextUp,
  layoutDay,
  minutesIntoDay,
  projectShifts,
  scheduleFirings,
  startOfDay,
  workedShifts,
  workerCalendar,
  type CalendarEntry,
} from './workerCalendar';
import {
  WORKER_PALETTE,
  trustRungs,
  workerColorFor,
  workerColorMap,
} from './workerPalette';
import { workerInitials } from './WorkerAvatar';

// A fixed Monday, local time, so weekday-restricted cadences are testable.
const MONDAY_9AM = new Date(2026, 7, 17, 9, 0, 0, 0).getTime();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function makeWorker(overrides: Record<string, unknown> = {}): Worker {
  return {
    id: 'w1',
    name: 'Fielder',
    jobDescription: 'x'.repeat(40),
    projectPath: '/repo',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'trusted',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 20,
    heartbeatModel: 'claude:sonnet',
    flowIds: [],
    enabled: true,
    createdAt: MONDAY_9AM - DAY,
    ...overrides,
  } as unknown as Worker;
}

function makeOrchestration(overrides: Record<string, unknown> = {}): Orchestration {
  return {
    id: 'o1',
    title: '[Shift 3] Fielder',
    createdAt: MONDAY_9AM,
    items: [],
    origin: { kind: 'worker', workerId: 'w1', workerName: 'Fielder', task: 'shift' },
    ...overrides,
  } as unknown as Orchestration;
}

describe('projectShifts', () => {
  it('walks a daily cadence across the window', () => {
    const { start, end } = calendarWindow(MONDAY_9AM, 7);
    const at = projectShifts(makeWorker(), MONDAY_9AM + HOUR, end);
    // Today's 09:00 already passed, so the first projection is tomorrow's.
    expect(at.length).toBe(6);
    expect(new Date(at[0]).getHours()).toBe(9);
    expect(startOfDay(at[0])).toBe(startOfDay(start + DAY));
  });

  it('honours the seed the engine computed instead of re-deriving it', () => {
    const seed = MONDAY_9AM + 3 * HOUR;
    const { end } = calendarWindow(MONDAY_9AM, 2);
    const at = projectShifts(makeWorker(), MONDAY_9AM, end, seed);
    expect(at[0]).toBe(seed);
  });

  it('re-derives when the seed is already in the past', () => {
    const { end } = calendarWindow(MONDAY_9AM, 2);
    const at = projectShifts(makeWorker(), MONDAY_9AM + HOUR, end, MONDAY_9AM - DAY);
    expect(at.every((t) => t > MONDAY_9AM + HOUR)).toBe(true);
  });

  it('projects nothing for a paused worker', () => {
    const { end } = calendarWindow(MONDAY_9AM, 7);
    expect(projectShifts(makeWorker({ enabled: false }), MONDAY_9AM, end)).toEqual([]);
  });

  it('keeps an interval cadence inside its window', () => {
    const worker = makeWorker({
      cadence: {
        kind: 'interval',
        everyMinutes: 60,
        days: [1],
        window: { start: '09:00', end: '17:00' },
      },
    });
    const { end } = calendarWindow(MONDAY_9AM, 7);
    const at = projectShifts(worker, MONDAY_9AM, end);
    for (const t of at) {
      const d = new Date(t);
      expect(d.getDay()).toBe(1);
      expect(d.getHours()).toBeGreaterThanOrEqual(9);
      expect(d.getHours()).toBeLessThanOrEqual(17);
    }
  });
});

function makeSchedule(overrides: Record<string, unknown> = {}): Schedule {
  return {
    id: 's1',
    name: 'Morning triage',
    enabled: true,
    projectPath: '/repo',
    target: { kind: 'flow', flowId: 'f1', prompt: 'go' },
    trigger: { kind: 'daily', time: '07:00' },
    onOverlap: 'skip',
    catchUp: 'skip',
    createdAt: MONDAY_9AM - DAY,
    history: [],
    ...overrides,
  } as unknown as Schedule;
}

describe('workedShifts', () => {
  const workers = { w1: makeWorker() };

  it('takes worker shifts inside the window', () => {
    const { start, end } = calendarWindow(MONDAY_9AM, 7);
    const found = workedShifts({ o1: makeOrchestration() }, workers, start, end);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'worked', source: 'worker', subjectId: 'w1' });
  });

  it('drops errands — they say nothing about cadence', () => {
    const errand = makeOrchestration({
      id: 'o2',
      title: '[Errand] why is CI slow',
      origin: { kind: 'worker', workerId: 'w1', workerName: 'Fielder', task: 'errand' },
    });
    const { start, end } = calendarWindow(MONDAY_9AM, 7);
    expect(workedShifts({ o2: errand }, workers, start, end)).toEqual([]);
  });

  it('drops batches whose worker was fired', () => {
    const { start, end } = calendarWindow(MONDAY_9AM, 7);
    expect(workedShifts({ o1: makeOrchestration() }, {}, start, end)).toEqual([]);
  });

  it('flags a batch still waiting for review', () => {
    const pending = makeOrchestration({
      items: [{ candidate: { id: 'c1', title: 't' }, status: 'proposed' }],
    });
    const { start, end } = calendarWindow(MONDAY_9AM, 7);
    expect(workedShifts({ o1: pending }, workers, start, end)[0].needsReview).toBe(true);
  });
});

describe('workerCalendar', () => {
  const base = {
    workers: { w1: makeWorker() },
    orchestrations: { o1: makeOrchestration() },
    nextShiftAt: {},
    from: MONDAY_9AM,
    days: 7,
    now: MONDAY_9AM + HOUR,
  };

  it('returns one column per day, in order', () => {
    const days = workerCalendar(base);
    expect(days).toHaveLength(7);
    expect(days[0].at).toBe(startOfDay(MONDAY_9AM));
    for (let i = 1; i < days.length; i++) expect(days[i].at).toBeGreaterThan(days[i - 1].at);
  });

  it('puts today’s worked shift on today’s column and projects the rest', () => {
    const days = workerCalendar(base);
    expect(days[0].entries.map((e) => e.kind)).toEqual(['worked']);
    expect(days[1].entries.map((e) => e.kind)).toEqual(['planned']);
  });

  it('never projects into the past half of the window', () => {
    const lastWeek = startOfDay(MONDAY_9AM) - 7 * DAY;
    const days = workerCalendar({ ...base, from: lastWeek, orchestrations: {} });
    expect(days.every((d) => d.entries.length === 0)).toBe(true);
  });

  it('keeps every occurrence — the grid places them, so nothing is folded away', () => {
    const busy = makeWorker({
      id: 'w2',
      name: 'Pinger',
      cadence: { kind: 'interval', everyMinutes: 30 },
    });
    const days = workerCalendar({ ...base, workers: { w2: busy }, orchestrations: {} });
    const tomorrow = days[1];
    expect(dayLoad(tomorrow)).toBe(48);
    expect(tomorrow.entries.every((e) => e.subjectId === 'w2')).toBe(true);
  });
});

describe('layoutDay', () => {
  function entry(hour: number, minute = 0, workerId = 'w1'): CalendarEntry {
    return {
      source: 'worker',
      subjectId: workerId,
      subjectName: workerId,
      trust: 'trusted',
      kind: 'planned',
      at: new Date(2026, 7, 17, hour, minute).getTime(),
    };
  }

  it('positions a block by its clock time', () => {
    const [p] = layoutDay([entry(9, 15)]);
    expect(p.startMinutes).toBe(9 * 60 + 15);
    expect(p.endMinutes).toBe(9 * 60 + 15 + SHIFT_MINUTES);
    expect(p.lanes).toBe(1);
    expect(p.lane).toBe(0);
  });

  it('splits the column between workers whose shifts overlap', () => {
    const placed = layoutDay([entry(9, 0, 'a'), entry(9, 15, 'b'), entry(9, 20, 'c')]);
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 2]);
    expect(placed.every((p) => p.lanes === 3)).toBe(true);
  });

  it('gives a block that clears the previous one the full width', () => {
    const placed = layoutDay([entry(9, 0), entry(10, 0)]);
    expect(placed.every((p) => p.lanes === 1 && p.lane === 0)).toBe(true);
  });

  it('reuses a lane once its block has ended, so an hourly worker stays put', () => {
    const placed = layoutDay([entry(9, 0, 'a'), entry(9, 10, 'b'), entry(9, 40, 'a')]);
    // 'b' overlaps the first 'a', so it takes lane 1; the 09:40 block starts
    // after 09:00's ends and reclaims lane 0.
    expect(placed.map((p) => p.lane)).toEqual([0, 1, 0]);
  });

  it('clamps a block that would run past midnight', () => {
    const [p] = layoutDay([entry(23, 50)]);
    expect(p.endMinutes).toBe(24 * 60);
  });

  it('reads local wall-clock minutes', () => {
    expect(minutesIntoDay(new Date(2026, 7, 17, 6, 45).getTime())).toBe(6 * 60 + 45);
  });
});

describe('scheduleFirings', () => {
  const { start, end } = calendarWindow(MONDAY_9AM, 7);

  it('draws a firing the schedule actually did', () => {
    const s = makeSchedule({
      history: [{ at: MONDAY_9AM, outcome: 'done', runId: 'r1' }],
    });
    const found = scheduleFirings({ s1: s }, {}, start, end);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      source: 'schedule',
      subjectId: 's1',
      kind: 'worked',
      runId: 'r1',
      outcome: 'done',
    });
    // A schedule has no standing, so it must not borrow the trust ladder.
    expect(found[0].trust).toBeUndefined();
  });

  it('leaves a skip off the grid — a block would claim it ran', () => {
    const s = makeSchedule({
      history: [{ at: MONDAY_9AM, outcome: 'skipped', note: 'still running' }],
    });
    expect(scheduleFirings({ s1: s }, {}, start, end)).toEqual([]);
  });

  it('ignores firings outside the window', () => {
    const s = makeSchedule({ history: [{ at: MONDAY_9AM - 30 * DAY, outcome: 'done' }] });
    expect(scheduleFirings({ s1: s }, {}, start, end)).toEqual([]);
  });

  it('flags a parked batch the firing is waiting on', () => {
    const s = makeSchedule({
      history: [{ at: MONDAY_9AM, outcome: 'launched', orchestrationId: 'o9' }],
    });
    const parked = makeOrchestration({
      id: 'o9',
      origin: { kind: 'schedule', scheduleId: 's1', scheduleName: 'Morning triage' },
      items: [{ candidate: { id: 'c1', title: 't' }, status: 'proposed' }],
    });
    expect(scheduleFirings({ s1: s }, { o9: parked }, start, end)[0].needsReview).toBe(true);
  });
});

describe('workerCalendar with schedules', () => {
  const base = {
    workers: { w1: makeWorker() },
    orchestrations: {},
    nextShiftAt: {},
    from: MONDAY_9AM,
    days: 7,
    now: MONDAY_9AM + HOUR,
  };

  it('projects schedules onto the same columns as shifts', () => {
    const days = workerCalendar({
      ...base,
      schedules: { s1: makeSchedule() },
      nextFireAt: {},
    });
    const tomorrow = days[1].entries;
    expect(tomorrow.map((e) => e.source)).toEqual(['schedule', 'worker']);
    // 07:00 before 09:00 — the grid is in clock order regardless of species.
    expect(tomorrow[0].subjectName).toBe('Morning triage');
  });

  it('leaves a paused schedule off, the way it leaves a paused worker off', () => {
    const days = workerCalendar({
      ...base,
      schedules: { s1: makeSchedule({ enabled: false }) },
      nextFireAt: {},
    });
    expect(days.flatMap((d) => d.entries).some((e) => e.source === 'schedule')).toBe(false);
  });

  it('draws workers alone when no schedules are handed in', () => {
    const days = workerCalendar(base);
    expect(days.flatMap((d) => d.entries).every((e) => e.source === 'worker')).toBe(true);
  });

  it('honours the engine seed for a schedule, as it does for a shift', () => {
    const seed = MONDAY_9AM + 3 * HOUR;
    const days = workerCalendar({
      ...base,
      workers: {},
      schedules: { s1: makeSchedule() },
      nextFireAt: { s1: seed },
    });
    expect(days[0].entries[0].at).toBe(seed);
  });
});

describe('isNextUp', () => {
  const planned: CalendarEntry = {
    source: 'worker',
    subjectId: 'w1',
    subjectName: 'Fielder',
    kind: 'planned',
    at: MONDAY_9AM,
  };

  it('rings the projection the strip is counting down to', () => {
    expect(isNextUp(planned, { source: 'worker', id: 'w1', at: MONDAY_9AM })).toBe(true);
  });

  it('does not ring the same worker at a different hour', () => {
    expect(isNextUp(planned, { source: 'worker', id: 'w1', at: MONDAY_9AM + HOUR })).toBe(false);
  });

  it('does not ring a schedule that shares an id with a worker', () => {
    expect(isNextUp(planned, { source: 'schedule', id: 'w1', at: MONDAY_9AM })).toBe(false);
  });

  it('never rings history — a countdown is about what has not happened', () => {
    expect(
      isNextUp({ ...planned, kind: 'worked' }, { source: 'worker', id: 'w1', at: MONDAY_9AM }),
    ).toBe(false);
  });

  it('rings nothing when nothing is next', () => {
    expect(isNextUp(planned, null)).toBe(false);
  });
});

describe('entryKey', () => {
  it('keeps a worker and a schedule at the same instant apart', () => {
    const at = MONDAY_9AM;
    const worker: CalendarEntry = {
      source: 'worker',
      subjectId: 'x',
      subjectName: 'x',
      kind: 'planned',
      at,
    };
    expect(entryKey(worker)).not.toBe(entryKey({ ...worker, source: 'schedule' }));
  });
});

describe('workerColorMap', () => {
  const at = (n: number) => ({ id: `w${n}`, createdAt: n } as unknown as Worker);

  it('gives every worker on the roster a distinct colour', () => {
    const map = workerColorMap([at(3), at(1), at(2)]);
    expect(new Set(Object.values(map)).size).toBe(3);
  });

  it('assigns by hire order, not by map order', () => {
    const first = workerColorMap([at(3), at(1), at(2)]);
    const second = workerColorMap([at(1), at(2), at(3)]);
    expect(first).toEqual(second);
    expect(first.w1).toBe(WORKER_PALETTE[0]);
    expect(first.w3).toBe(WORKER_PALETTE[2]);
  });

  it('wraps once the roster outgrows the palette', () => {
    const many = Array.from({ length: WORKER_PALETTE.length + 1 }, (_, i) => at(i));
    const map = workerColorMap(many);
    expect(map[`w${WORKER_PALETTE.length}`]).toBe(WORKER_PALETTE[0]);
  });

  it('falls back for a fired worker whose shifts are still on the grid', () => {
    expect(workerColorFor({}, 'gone')).toBe(WORKER_PALETTE[0]);
  });

  it('counts trust as rungs climbed', () => {
    expect([trustRungs('probation'), trustRungs('trusted'), trustRungs('autonomous')]).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('workerInitials', () => {
  it('takes first and last initials, so a middle name cannot crowd them out', () => {
    expect(workerInitials('Test Coverage Warden')).toBe('TW');
  });

  it('takes two letters from a single-word name', () => {
    expect(workerInitials('Compass')).toBe('CO');
  });

  it('never renders empty — a worker with no readable name still has a face', () => {
    expect(workerInitials('   ')).toBe('?');
  });
});
