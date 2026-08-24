import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_GRACE_MS,
  describeTrigger,
  evaluateSchedule,
  nextOccurrenceAfter,
  parseTimeOfDay,
  scheduledRunTitle,
  untilLabel,
  validateSchedule,
  SCHEDULE_AUTO_APPROVE_MAX,
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

  it('fires late, not skipped, when the occurrence came due after we woke', () => {
    // The engine was awake at 8:55 and has been busy ever since — the 9am slot
    // was not missed while overcli was closed, just queued behind a long turn.
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 20), {
      awakeSince: local(2026, 3, 2, 8, 55),
    });
    expect(d).toMatchObject({ action: 'fire', dueAt: local(2026, 3, 2, 9, 0), late: true });
  });

  it('still skips a slot that predates the moment we woke', () => {
    // Same lateness, but the 9am slot passed before the engine started
    // looking: this one really was missed while the app was closed.
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 20), {
      awakeSince: local(2026, 3, 2, 9, 5),
    });
    expect(d.action).toBe('skip');
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
      'Weekends at 8am',
    );
    // Anything that isn't a named set falls back to listing the days.
    expect(describeTrigger({ kind: 'daily', time: '08:00', days: [1, 3, 5] })).toBe(
      'Mon, Wed, Fri at 8am',
    );
  });

  it('renders midnight and noon without a zero hour', () => {
    expect(describeTrigger({ kind: 'daily', time: '00:00' })).toBe('Every day at 12am');
    expect(describeTrigger({ kind: 'daily', time: '12:00' })).toBe('Every day at 12pm');
  });
});

describe('untilLabel', () => {
  const now = local(2026, 3, 2, 9, 0);

  it('counts down in the coarsest useful unit', () => {
    expect(untilLabel(now + 45 * 60_000, now)).toBe('in 45m');
    expect(untilLabel(now + 3 * 3_600_000, now)).toBe('in 3h');
    expect(untilLabel(now + 2 * 86_400_000, now)).toBe('in 2d');
  });

  it('has a word for the moments either side of firing', () => {
    expect(untilLabel(now + 20_000, now)).toBe('in under a minute');
    expect(untilLabel(now, now)).toBe('due now');
    // Past due reads as due, never as a negative countdown.
    expect(untilLabel(now - 60_000, now)).toBe('due now');
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

  it('bounds the auto-launch cap on an orchestrate target', () => {
    const withCap = (maxItems: number) =>
      validateSchedule(
        makeSchedule({
          target: {
            kind: 'orchestrate',
            flowId: 'fix-it',
            prompt: 'triage the queue',
            runIn: 'worktree',
            maxConcurrent: 2,
            autoApprove: { maxItems },
          },
        }),
      );
    expect(withCap(3)).toBeNull();
    expect(withCap(SCHEDULE_AUTO_APPROVE_MAX)).toBeNull();
    expect(withCap(0)).toMatch(/at least one item/i);
    expect(withCap(SCHEDULE_AUTO_APPROVE_MAX + 1)).toMatch(/capped at/i);
  });

  it('leaves a plain orchestrate target alone — parking is still the default', () => {
    expect(
      validateSchedule(
        makeSchedule({
          target: {
            kind: 'orchestrate',
            flowId: 'fix-it',
            prompt: 'triage the queue',
            runIn: 'worktree',
            maxConcurrent: 2,
          },
        }),
      ),
    ).toBeNull();
  });

  it('rejects a sub-minute interval and a malformed time', () => {
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'interval', everyMinutes: 0 } })))
      .toMatch(/at least one minute/i);
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'daily', time: '9am' } })))
      .toMatch(/09:30/);
  });
});

describe('scheduledRunTitle', () => {
  it('prefixes the prompt’s first line with the sequence', () => {
    expect(scheduledRunTitle(12, 'Update the changelog\nand tag it')).toBe(
      '[SR-12] Update the changelog',
    );
  });

  it('skips leading blank lines rather than tagging an empty string', () => {
    expect(scheduledRunTitle(1, '\n\n  Pull the numbers  ')).toBe('[SR-1] Pull the numbers');
  });

  it('is still a usable title when the prompt is empty', () => {
    expect(scheduledRunTitle(3, '   ')).toBe('[SR-3]');
  });
});

describe('interval triggers with days and an active window', () => {
  // "Every hour, Mon–Fri, 8am–5pm" — the shape this exists for.
  const workHours: ScheduleTrigger = {
    kind: 'interval',
    everyMinutes: 60,
    days: [1, 2, 3, 4, 5],
    window: { start: '08:00', end: '17:00' },
  };

  it('steps normally inside the window', () => {
    // 2026-03-02 is a Monday.
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 2, 9, 0))).toBe(
      local(2026, 3, 2, 10, 0),
    );
  });

  it('fires at the closing edge, inclusive', () => {
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 2, 16, 0))).toBe(
      local(2026, 3, 2, 17, 0),
    );
  });

  it('jumps to tomorrow morning instead of stepping through the evening', () => {
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 2, 17, 0))).toBe(
      local(2026, 3, 3, 8, 0),
    );
  });

  it('waits for opening time rather than firing before the window', () => {
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 2, 3, 0))).toBe(
      local(2026, 3, 2, 8, 0),
    );
  });

  it('skips the weekend', () => {
    // Friday 2026-03-06 at 17:00 → Monday 2026-03-09 at 08:00.
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 6, 17, 0))).toBe(
      local(2026, 3, 9, 8, 0),
    );
  });

  it('re-phases to the window start each day', () => {
    // Armed at 8:37: today runs on the half hour, tomorrow starts at 8 sharp
    // rather than inheriting the odd offset forever.
    const at837 = nextOccurrenceAfter(workHours, local(2026, 3, 2, 8, 37));
    expect(at837).toBe(local(2026, 3, 2, 9, 37));
    expect(nextOccurrenceAfter(workHours, local(2026, 3, 2, 16, 37))).toBe(
      local(2026, 3, 3, 8, 0),
    );
  });

  it('honours a day set with no window', () => {
    const t: ScheduleTrigger = { kind: 'interval', everyMinutes: 60, days: [1] };
    // Monday 23:30 + 1h = Tuesday 00:30, which isn't Monday — next Monday 00:00.
    expect(nextOccurrenceAfter(t, local(2026, 3, 2, 23, 30))).toBe(local(2026, 3, 9, 0, 0));
  });

  it('honours a window with no day restriction', () => {
    const t: ScheduleTrigger = {
      kind: 'interval',
      everyMinutes: 120,
      window: { start: '09:00', end: '15:00' },
    };
    // Saturday counts when no days are named.
    expect(nextOccurrenceAfter(t, local(2026, 3, 7, 15, 0))).toBe(local(2026, 3, 8, 9, 0));
  });

  it('handles a window that wraps midnight', () => {
    // Every 2h, 22:00–02:00. Both halves are live.
    const overnight: ScheduleTrigger = {
      kind: 'interval',
      everyMinutes: 120,
      window: { start: '22:00', end: '02:00' },
    };
    expect(nextOccurrenceAfter(overnight, local(2026, 3, 2, 22, 0))).toBe(
      local(2026, 3, 3, 0, 0),
    );
    // 02:00 is the close; the next tick would be 04:00, so wait for 22:00.
    expect(nextOccurrenceAfter(overnight, local(2026, 3, 3, 2, 0))).toBe(
      local(2026, 3, 3, 22, 0),
    );
  });

  it('attributes a wrapped window to the day it opened on', () => {
    // Friday-only, 22:00–02:00: Saturday 01:00 belongs to Friday's window,
    // Saturday 23:00 does not belong to anything.
    const fridayNight: ScheduleTrigger = {
      kind: 'interval',
      everyMinutes: 60,
      days: [5],
      window: { start: '22:00', end: '02:00' },
    };
    // Fri 2026-03-06 23:00 → Sat 00:00, still inside Friday's window.
    expect(nextOccurrenceAfter(fridayNight, local(2026, 3, 6, 23, 0))).toBe(
      local(2026, 3, 7, 0, 0),
    );
    // Sat 02:00 is the close → next opening is Friday the 13th at 22:00.
    expect(nextOccurrenceAfter(fridayNight, local(2026, 3, 7, 2, 0))).toBe(
      local(2026, 3, 13, 22, 0),
    );
  });

  it('treats an unparseable window as no window rather than never firing', () => {
    const t = {
      kind: 'interval',
      everyMinutes: 60,
      window: { start: 'lunchtime', end: '17:00' },
    } as ScheduleTrigger;
    expect(nextOccurrenceAfter(t, local(2026, 3, 2, 9, 0))).toBe(local(2026, 3, 2, 10, 0));
  });
});

describe('describeTrigger for windowed intervals', () => {
  it('reads as a sentence with either qualifier, both, or neither', () => {
    expect(describeTrigger({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
    expect(
      describeTrigger({ kind: 'interval', everyMinutes: 60, days: [1, 2, 3, 4, 5] }),
    ).toBe('Every hour, weekdays');
    expect(
      describeTrigger({
        kind: 'interval',
        everyMinutes: 60,
        window: { start: '08:00', end: '17:00' },
      }),
    ).toBe('Every hour, 8am–5pm');
    expect(
      describeTrigger({
        kind: 'interval',
        everyMinutes: 60,
        days: [1, 2, 3, 4, 5],
        window: { start: '08:00', end: '17:00' },
      }),
    ).toBe('Every hour, weekdays 8am–5pm');
    expect(describeTrigger({ kind: 'interval', everyMinutes: 30, days: [0, 6] })).toBe(
      'Every 30 minutes, weekends',
    );
  });
});

describe('validateSchedule for windowed intervals', () => {
  const withTrigger = (trigger: ScheduleTrigger) => validateSchedule(makeSchedule({ trigger }));

  it('accepts a well-formed working-hours interval', () => {
    expect(
      withTrigger({
        kind: 'interval',
        everyMinutes: 60,
        days: [1, 2, 3, 4, 5],
        window: { start: '08:00', end: '17:00' },
      }),
    ).toBeNull();
  });

  it('rejects an interval that cannot fit inside its own window', () => {
    expect(
      withTrigger({
        kind: 'interval',
        everyMinutes: 240,
        window: { start: '09:00', end: '10:00' },
      }),
    ).toMatch(/only fire once a day/i);
  });

  it('rejects an empty day set and a malformed or zero-length window', () => {
    expect(withTrigger({ kind: 'interval', everyMinutes: 60, days: [] })).toMatch(/at least one day/i);
    expect(
      withTrigger({ kind: 'interval', everyMinutes: 60, window: { start: '8', end: '17:00' } }),
    ).toMatch(/08:00/);
    expect(
      withTrigger({
        kind: 'interval',
        everyMinutes: 60,
        window: { start: '09:00', end: '09:00' },
      }),
    ).toMatch(/differ/i);
  });
});
