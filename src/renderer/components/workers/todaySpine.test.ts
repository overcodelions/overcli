import { describe, expect, it } from 'vitest';

import {
  barHours,
  buildTodaySpine,
  trimUpcoming,
  clockStamp,
  dayTicks,
  describeGap,
  hourLabel,
  type SpineItem,
} from './todaySpine';

import type { QueueRow, UpcomingRow, WorkQueue } from './workQueue';

const NOON = new Date('2026-08-24T12:14:00').getTime();
const HOUR = 3_600_000;
const MIN = 60_000;

function at(h: number, m = 0): number {
  return new Date('2026-08-24T00:00:00').getTime() + h * HOUR + m * MIN;
}

function row(key: string, when: number, over: Partial<QueueRow> = {}): QueueRow {
  return {
    key,
    workerId: 'w1',
    workerName: 'Triage',
    task: 'shift',
    status: 'done',
    title: key,
    steps: [],
    at: when,
    ...over,
  } as QueueRow;
}

function queue(over: Partial<WorkQueue> = {}): WorkQueue {
  return { running: [], needsYou: [], finished: [], ...over };
}

const soon = (id: string, when: number): UpcomingRow => ({
  workerId: id,
  workerName: id,
  at: when,
  cadence: 'Every day at 9am',
  imminent: when - NOON <= HOUR,
  overdue: when <= NOON,
});

const jobs = (items: SpineItem[]) => items.filter((i) => i.kind === 'job').map((i) => i.key);
const kinds = (items: SpineItem[]) => items.map((i) => i.kind);

describe('buildTodaySpine', () => {
  it('reads down the page: furthest future first, then the day backwards', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('a', at(10, 26)), row('b', at(10, 14))] }),
      [soon('near', NOON + 9 * MIN), soon('far', NOON + 3 * HOUR)],
      NOON,
    );
    // `upcomingShifts` hands them over soonest-first; up the page is further
    // into the future, so the soonest sits closest to the now-line.
    expect(s.upcoming.map((u) => u.workerId)).toEqual(['far', 'near']);
    expect(jobs(s.below)).toEqual(['a', 'b']);
  });

  it('marks the hour when it changes, once', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('a', at(10, 26)), row('b', at(10, 14)), row('c', at(9, 40))] }),
      [],
      NOON,
    );
    expect(kinds(s.below)).toEqual(['hour', 'job', 'job', 'hour', 'job']);
    expect(s.below.filter((i) => i.kind === 'hour').map((i) => (i as { label: string }).label))
      .toEqual(['10 AM', '9 AM']);
  });

  it('names a gap worth naming and ignores the rest', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('a', at(6, 40)), row('b', at(4, 1)), row('c', at(3, 50))] }),
      [],
      NOON,
    );
    const quiet = s.below.filter((i) => i.kind === 'quiet') as Array<{ label: string }>;
    // 2h39m earns a marker; the 11 minutes between b and c does not.
    expect(quiet.map((q) => q.label)).toEqual(['2h 39m quiet']);
    // The gap is drawn ABOVE the hour it leads into, so reading down the
    // page you cross the silence before arriving at 4 AM.
    expect(kinds(s.below)).toEqual(['hour', 'job', 'quiet', 'hour', 'job', 'hour', 'job']);
  });

  // Both of these are drawn out of time order on purpose, and both keep
  // their own stamp so the page never pretends otherwise.
  it('pins decisions and holds live work at the now-line', () => {
    const paused = row('decide', at(11, 52), { status: 'paused', pausedReason: 'riskyStep' });
    const running = row('live', at(6, 0), { status: 'running' });
    const s = buildTodaySpine(
      queue({ needsYou: [paused], running: [running], finished: [row('a', at(10, 26))] }),
      [],
      NOON,
    );
    expect(s.pinned.map((r) => r.key)).toEqual(['decide']);
    expect(s.live.map((r) => r.key)).toEqual(['live']);
    // Neither is duplicated into the day behind the now-line.
    expect(jobs(s.below)).toEqual(['a']);
    // A job six hours in still says it started at 06:00.
    expect(clockStamp(s.live[0].at)).toBe('06:00');
  });

  it('keeps yesterday out of today', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('today', at(10, 0)), row('yesterday', at(10, 0) - 24 * HOUR)] }),
      [],
      NOON,
    );
    expect(jobs(s.below)).toEqual(['today']);
    expect(s.done).toBe(1);
  });

  it('counts failures separately — the one finished row you may have to act on', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('a', at(10, 0)), row('b', at(9, 0), { status: 'failed' })] }),
      [],
      NOON,
    );
    expect(s.done).toBe(2);
    expect(s.failed).toBe(1);
  });

  it('draws nothing at all on an empty day', () => {
    const s = buildTodaySpine(queue(), [], NOON);
    expect(s.below).toEqual([]);
    expect(s.done).toBe(0);
  });
});

// Reported from the running app: "on the Today page I don't see upcoming —
// perhaps I need a restart?". The data was fine and the shift was simply
// further out than the horizon. Above a now-line that is indistinguishable
// from a page that failed to load, so the soonest shift is now always drawn.
describe('trimUpcoming', () => {
  it('draws everything inside the horizon', () => {
    const rows = [soon('a', NOON + 20 * MIN), soon('b', NOON + 3 * HOUR), soon('c', NOON + 9 * HOUR)];
    expect(trimUpcoming(rows, NOON).map((r) => r.workerId)).toEqual(['a', 'b']);
  });

  it('still answers when the next shift is tomorrow', () => {
    const rows = [soon('a', NOON + 21 * HOUR), soon('b', NOON + 30 * HOUR)];
    // One line, not none: silence reads as breakage, not as "nothing soon".
    expect(trimUpcoming(rows, NOON).map((r) => r.workerId)).toEqual(['a']);
  });

  it('has nothing to say only when no worker has a cadence at all', () => {
    expect(trimUpcoming([], NOON)).toEqual([]);
  });

  it('reaches the spine in reading order, furthest first', () => {
    const s = buildTodaySpine(queue(), [soon('a', NOON + 21 * HOUR)], NOON);
    expect(s.upcoming.map((u) => u.workerId)).toEqual(['a']);
  });
});

describe('dayTicks', () => {
  it('spans the work, not the calendar day', () => {
    const s = buildTodaySpine(
      queue({ finished: [row('a', at(12, 14)), row('b', at(7, 14)), row('c', at(2, 14))] }),
      [],
      NOON,
    );
    const { ticks, from } = dayTicks(s, NOON);
    expect(from).toBe(at(2, 14));
    // First tick at the left edge, last at now, the middle one halfway.
    expect(ticks.map((t) => Math.round(t.pct))).toEqual([100, 50, 0]);
  });

  it('has nothing to draw before the crew has done anything', () => {
    expect(dayTicks(buildTodaySpine(queue(), [], NOON), NOON).ticks).toEqual([]);
  });
});

describe('barHours', () => {
  it('labels on the hour, at a gradation a person can read', () => {
    const marks = barHours(at(2, 14), NOON);
    expect(marks.map((m) => m.label)).toEqual(['3 AM', '6 AM', '9 AM', '12 PM']);
    expect(marks.every((m) => m.pct >= 0 && m.pct <= 100)).toBe(true);
  });

  it('tightens the step for a short morning rather than inventing minutes', () => {
    expect(barHours(at(10, 5), NOON).map((m) => m.label)).toEqual(['11 AM', '12 PM']);
  });
});

describe('the small print', () => {
  it('says the gap the way a person would', () => {
    expect(describeGap(44 * MIN)).toBe('44m');
    expect(describeGap(2 * HOUR)).toBe('2h');
    expect(describeGap(2 * HOUR + 39 * MIN)).toBe('2h 39m');
  });

  it('labels noon and midnight as 12, not 0', () => {
    expect(hourLabel(at(12))).toBe('12 PM');
    expect(hourLabel(at(0))).toBe('12 AM');
    expect(clockStamp(at(0, 5))).toBe('12:05');
  });
});
