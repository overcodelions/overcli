import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_GRACE_MS,
  describeTrigger,
  evaluateSchedule,
  nextOccurrenceAfter,
  parseTimeOfDay,
  validateSchedule,
  type Schedule,
  type ScheduleTrigger,
} from './schedule';

/// Local-time helper so the daily expectations read as wall-clock and don't
/// silently depend on the machine's timezone.
function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

function makeSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sched-1',
    name: 'Morning triage',
    enabled: true,
    projectPath: '/repo',
    target: { kind: 'flow', flowId: 'fix-it', prompt: 'do the thing', runIn: 'worktree' },
    trigger: { kind: 'daily', time: '09:00' },
    onOverlap: 'skip',
    catchUp: 'skip',
    createdAt: local(2026, 3, 2, 8, 0),
    history: [],
    ...over,
  };
}

describe('nextOccurrenceAfter', () => {
  it('spaces interval triggers off the point given', () => {
    const t: ScheduleTrigger = { kind: 'interval', everyMinutes: 90 };
    expect(nextOccurrenceAfter(t, 1_000)).toBe(1_000 + 90 * 60_000);
  });

  it('finds today for a daily trigger still ahead of the anchor', () => {
    const t: ScheduleTrigger = { kind: 'daily', time: '09:00' };
    expect(nextOccurrenceAfter(t, local(2026, 3, 2, 7, 30))).toBe(local(2026, 3, 2, 9, 0));
  });

  it('rolls to tomorrow once today has passed', () => {
    const t: ScheduleTrigger = { kind: 'daily', time: '09:00' };
    expect(nextOccurrenceAfter(t, local(2026, 3, 2, 9, 0))).toBe(local(2026, 3, 3, 9, 0));
  });

  it('skips days outside the weekday set', () => {
    // 2026-03-06 is a Friday; weekdays-only should jump the weekend to Monday.
    const t: ScheduleTrigger = { kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] };
    expect(nextOccurrenceAfter(t, local(2026, 3, 6, 9, 0))).toBe(local(2026, 3, 9, 8, 30));
  });

  it('finds the same weekday next week for a once-a-week schedule', () => {
    // Sunday-only, evaluated just after Sunday's slot.
    const t: ScheduleTrigger = { kind: 'daily', time: '10:00', days: [0] };
    expect(nextOccurrenceAfter(t, local(2026, 3, 8, 10, 0))).toBe(local(2026, 3, 15, 10, 0));
  });

  it('treats an empty day list as every day', () => {
    const t: ScheduleTrigger = { kind: 'daily', time: '09:00', days: [] };
    expect(nextOccurrenceAfter(t, local(2026, 3, 7, 12, 0))).toBe(local(2026, 3, 8, 9, 0));
  });

  it('never returns a time in the past, even for a nonsense trigger', () => {
    const t = { kind: 'daily', time: 'not-a-time' } as ScheduleTrigger;
    const after = local(2026, 3, 2, 12, 0);
    expect(nextOccurrenceAfter(t, after)).toBeGreaterThan(after);
  });
});

describe('evaluateSchedule', () => {
  it('waits while the next occurrence is ahead', () => {
    const s = makeSchedule();
    const d = evaluateSchedule(s, local(2026, 3, 2, 8, 30));
    expect(d).toEqual({ action: 'wait', at: local(2026, 3, 2, 9, 0) });
  });

  it('never fires while disabled', () => {
    const s = makeSchedule({ enabled: false });
    expect(evaluateSchedule(s, local(2026, 3, 5, 9, 0)).action).toBe('wait');
  });

  it('fires on time', () => {
    const s = makeSchedule();
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 0) + 10);
    expect(d).toMatchObject({ action: 'fire', late: false });
  });

  it('still fires inside the grace window rather than calling it late', () => {
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 0) + SCHEDULE_GRACE_MS - 1);
    expect(d).toMatchObject({ action: 'fire', late: false });
  });

  it('skips an occurrence missed while closed when catchUp is skip', () => {
    const s = makeSchedule({ catchUp: 'skip' });
    // Two days later — the 9am slots came and went with the app shut.
    const d = evaluateSchedule(s, local(2026, 3, 4, 14, 0));
    expect(d.action).toBe('skip');
    if (d.action === 'skip') {
      expect(d.nextAt).toBe(local(2026, 3, 5, 9, 0));
      expect(d.reason).toMatch(/closed/i);
    }
  });

  it('coalesces every missed occurrence into a single catch-up firing', () => {
    const s = makeSchedule({ catchUp: 'once' });
    const d = evaluateSchedule(s, local(2026, 3, 4, 14, 0));
    expect(d).toMatchObject({ action: 'fire', late: true });
    // The decision names ONE due time; the engine stamps lastFiredAt from it,
    // so the three missed mornings can't each produce a run.
    if (d.action === 'fire') expect(d.dueAt).toBe(local(2026, 3, 2, 9, 0));
  });

  it('skips when the previous run is still going and overlap is skip', () => {
    const s = makeSchedule({ onOverlap: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 0) + 10, { busy: true });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/still going/i);
  });

  it('fires through a busy run when overlap is replace', () => {
    const s = makeSchedule({ onOverlap: 'replace' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 0) + 10, { busy: true });
    expect(d.action).toBe('fire');
  });

  it('fires a queued firing as soon as the tree is free', () => {
    const s = makeSchedule({
      onOverlap: 'queue',
      pendingSince: local(2026, 3, 2, 9, 0),
      // Anchor moved past today's slot, so only `pendingSince` can explain a fire.
      lastFiredAt: local(2026, 3, 2, 9, 30),
    });
    const d = evaluateSchedule(s, local(2026, 3, 2, 10, 0));
    expect(d).toMatchObject({ action: 'fire', late: true });
  });

  it('holds a queued firing while the run is still going', () => {
    const s = makeSchedule({
      onOverlap: 'queue',
      pendingSince: local(2026, 3, 2, 9, 0),
      lastFiredAt: local(2026, 3, 2, 9, 30),
    });
    const d = evaluateSchedule(s, local(2026, 3, 2, 10, 0), { busy: true });
    expect(d.action).not.toBe('fire');
  });

  it('measures the interval from the last fire, not from creation', () => {
    const s = makeSchedule({
      trigger: { kind: 'interval', everyMinutes: 60 },
      createdAt: local(2026, 3, 2, 1, 0),
      lastFiredAt: local(2026, 3, 2, 9, 0),
    });
    expect(evaluateSchedule(s, local(2026, 3, 2, 9, 30))).toEqual({
      action: 'wait',
      at: local(2026, 3, 2, 10, 0),
    });
  });

  it('restarts an interval from anchorAt after an edit', () => {
    const s = makeSchedule({
      trigger: { kind: 'interval', everyMinutes: 60 },
      createdAt: local(2026, 3, 1, 0, 0),
      anchorAt: local(2026, 3, 2, 9, 0),
    });
    expect(evaluateSchedule(s, local(2026, 3, 2, 9, 30))).toEqual({
      action: 'wait',
      at: local(2026, 3, 2, 10, 0),
    });
  });
});

describe('describeTrigger', () => {
  it('renders intervals in whole hours when they divide', () => {
    expect(describeTrigger({ kind: 'interval', everyMinutes: 240 })).toBe('Every 4 hours');
    expect(describeTrigger({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(describeTrigger({ kind: 'interval', everyMinutes: 30 })).toBe('Every 30 minutes');
  });

  it('names the weekday set', () => {
    expect(describeTrigger({ kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] })).toBe(
      'Weekdays at 9am',
    );
    expect(describeTrigger({ kind: 'daily', time: '17:30' })).toBe('Every day at 5:30pm');
    expect(describeTrigger({ kind: 'daily', time: '08:00', days: [0, 6] })).toBe(
      'Sun, Sat at 8am',
    );
  });

  it('renders midnight and noon without a zero hour', () => {
    expect(describeTrigger({ kind: 'daily', time: '00:00' })).toBe('Every day at 12am');
    expect(describeTrigger({ kind: 'daily', time: '12:00' })).toBe('Every day at 12pm');
  });
});

describe('parseTimeOfDay', () => {
  it('accepts HH:MM and rejects out-of-range values', () => {
    expect(parseTimeOfDay('09:05')).toEqual({ hours: 9, minutes: 5 });
    expect(parseTimeOfDay('9:05')).toEqual({ hours: 9, minutes: 5 });
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('09:60')).toBeNull();
    expect(parseTimeOfDay('nope')).toBeNull();
  });
});

describe('validateSchedule', () => {
  it('accepts a complete schedule', () => {
    expect(validateSchedule(makeSchedule())).toBeNull();
  });

  it('insists on a prompt, because nobody is there to type one', () => {
    const s = makeSchedule({
      target: { kind: 'flow', flowId: 'fix-it', prompt: '   ', runIn: 'cwd' },
    });
    expect(validateSchedule(s)).toMatch(/prompt/i);
  });

  it('rejects a sub-minute interval and a malformed time', () => {
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'interval', everyMinutes: 0 } })))
      .toMatch(/at least one minute/i);
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'daily', time: '9am' } })))
      .toMatch(/09:30/);
  });
});
