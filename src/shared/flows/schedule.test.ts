import { describe, expect, it } from 'vitest';

import {
  CHAIN_OUTPUT_MAX_CHARS,
  MAX_CHAIN_DEPTH,
  SCHEDULE_GRACE_MS,
  composeChainedPrompt,
  describeTrigger,
  latestArtifact,
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

  it('fires late when the tick woke a hair after the slot it came for', () => {
    // What the Triage worker hit: two workers due at 9:00 sharp, the timer
    // enters its callback 3ms past 9:00, and the first worker's planning turn
    // holds the loop for minutes. Judged against the raw tick start the second
    // worker's slot looks older than the wakeup and gets written off as missed
    // while closed — the exact starvation `awakeSince` exists to prevent.
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 3), {
      awakeSince: local(2026, 3, 2, 9, 0) + 3,
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

  it('fires a slot the host slept through, rather than writing it off', () => {
    // Vantage, 2026-08-31: a weekly Monday 1am shift, overcli open since the
    // night before, the Mac in maintenance sleep from 00:59:52 to 01:13:18.
    // The old rule compared the slot against the tick that noticed it and
    // journalled "missed while overcli was closed" about an app that had been
    // running for three hours. It is a thirteen-minute nap; run the shift.
    const s = makeSchedule({
      catchUp: 'skip',
      trigger: { kind: 'daily', time: '01:00', days: [1] },
      anchorAt: local(2026, 8, 30, 22, 13),
    });
    const due = local(2026, 8, 31, 1, 0);
    const d = evaluateSchedule(s, local(2026, 8, 31, 1, 13), {
      openSince: local(2026, 8, 30, 22, 13),
      hostResumedAt: local(2026, 8, 31, 1, 13),
    });
    expect(d).toMatchObject({ action: 'fire', dueAt: due, late: true });
  });

  it('still calls it closed when overcli started after the slot passed', () => {
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 20), {
      openSince: local(2026, 3, 2, 9, 5),
    });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/closed/i);
  });

  it('counts a slot the engine started milliseconds after as one it was there for', () => {
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 2, 9, 20), {
      openSince: local(2026, 3, 2, 9, 0) + 3,
    });
    expect(d).toMatchObject({ action: 'fire', late: true });
  });

  it('stops catching up once a later occurrence has come due', () => {
    // Open the whole time, but asleep from Monday morning to Wednesday
    // afternoon. Tuesday's and Wednesday's 9am slots have been and gone, so
    // Monday's is not the current one any more and firing it would mean two
    // runs for one slot. Skipped — but described as the sleep it was.
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 4, 14, 0), {
      openSince: local(2026, 3, 1, 12, 0),
      hostResumedAt: local(2026, 3, 4, 13, 59),
    });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/asleep/i);
  });

  it('names the next occurrence, not sleep, when the host never slept', () => {
    const s = makeSchedule({ catchUp: 'skip' });
    const d = evaluateSchedule(s, local(2026, 3, 4, 14, 0), {
      openSince: local(2026, 3, 1, 12, 0),
    });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/next occurrence/i);
  });

  it('forgives only minutes on a fast cadence and days on a slow one', () => {
    // The catch-up window is the trigger itself, so it scales without a
    // constant to tune. Same twenty-minute delay, opposite verdicts.
    const openSince = local(2026, 3, 1, 12, 0);
    const quarterly = makeSchedule({
      catchUp: 'skip',
      trigger: { kind: 'interval', everyMinutes: 15 },
      anchorAt: local(2026, 3, 2, 8, 45),
    });
    expect(evaluateSchedule(quarterly, local(2026, 3, 2, 9, 20), { openSince }).action).toBe('skip');

    const weekly = makeSchedule({
      catchUp: 'skip',
      trigger: { kind: 'daily', time: '09:00', days: [1] },
    });
    expect(evaluateSchedule(weekly, local(2026, 3, 2, 9, 20), { openSince })).toMatchObject({
      action: 'fire',
      late: true,
    });
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

describe('onFlowComplete trigger', () => {
  const chained: ScheduleTrigger = {
    kind: 'onFlowComplete',
    watchFlowId: 'scrape',
    onOutcome: 'success',
  };

  it('has no next occurrence', () => {
    // Infinity is load-bearing, not decorative: SchedulerEngine.arm bails on a
    // non-finite minimum and arms no timer at all. A far-future finite number
    // would wake the engine forever for a schedule no clock can satisfy.
    expect(nextOccurrenceAfter(chained, local(2026, 3, 2, 9, 0))).toBe(Number.POSITIVE_INFINITY);
  });

  it('never evaluates as due, however long ago it was anchored', () => {
    const s = makeSchedule({ trigger: chained, createdAt: local(2020, 1, 1) });
    const decision = evaluateSchedule(s, local(2026, 3, 2, 9, 0));
    expect(decision).toEqual({ action: 'wait', at: Number.POSITIVE_INFINITY });
  });

  it('is not resurrected by a queued pending firing', () => {
    // `pendingSince` is checked before the due-time arithmetic in the
    // time-based path; an event-driven trigger must short-circuit ahead of it.
    const s = makeSchedule({
      trigger: chained,
      onOverlap: 'queue',
      pendingSince: local(2026, 3, 2, 8, 0),
    });
    expect(evaluateSchedule(s, local(2026, 3, 2, 9, 0), { busy: false })).toEqual({
      action: 'wait',
      at: Number.POSITIVE_INFINITY,
    });
  });

  it('reads back in plain English', () => {
    expect(describeTrigger(chained)).toBe('When scrape succeeds');
    expect(describeTrigger({ ...chained, onOutcome: 'any' })).toBe('When scrape finishes');
  });

  it('validates without falling into the time-of-day branch', () => {
    // The regression this guards: before the dedicated branch, an
    // onFlowComplete trigger reached `parseTimeOfDay(trigger.time)` with
    // `time` undefined and was rejected with "Time must look like 09:30." —
    // a nonsense error that typechecked perfectly.
    expect(validateSchedule(makeSchedule({ trigger: chained }))).toBeNull();
  });

  it('needs a flow to watch', () => {
    expect(validateSchedule(makeSchedule({ trigger: { ...chained, watchFlowId: '  ' } }))).toBe(
      'Pick the flow to watch.',
    );
  });

  it('refuses a self-chain', () => {
    expect(
      validateSchedule(makeSchedule({ trigger: { ...chained, watchFlowId: 'fix-it' } })),
    ).toBe('A flow cannot be chained to itself.');
  });
});

describe('chain handoff', () => {
  it('caps the chain at a small, stated depth', () => {
    expect(MAX_CHAIN_DEPTH).toBe(5);
  });

  it('folds the upstream output into the downstream prompt', () => {
    const out = composeChainedPrompt('Triage the findings.', {
      flowName: 'Nightly scrape',
      artifactName: 'findings',
      body: '42 new rows',
    });
    expect(out).toContain('Triage the findings.');
    expect(out).toContain('Nightly scrape');
    expect(out).toContain('findings');
    expect(out).toContain('42 new rows');
  });

  it('truncates an upstream body that would blow the context window', () => {
    const huge = 'x'.repeat(CHAIN_OUTPUT_MAX_CHARS + 500);
    const out = composeChainedPrompt('base', {
      flowName: 'f',
      artifactName: 'diff',
      body: huge,
    });
    expect(out).toContain('…truncated');
    expect(out.length).toBeLessThan(huge.length);
  });

  it('leaves a body that fits completely alone', () => {
    const out = composeChainedPrompt('base', { flowName: 'f', artifactName: 'a', body: 'small' });
    expect(out).not.toContain('…truncated');
  });

  it('picks the newest artifact, not the first key', () => {
    const picked = latestArtifact({
      first: { name: 'first', body: 'older', producedAt: 10 },
      second: { name: 'second', body: 'newer', producedAt: 20 },
    });
    expect(picked).toEqual({ name: 'second', body: 'newer' });
  });

  it('skips empty bodies and reports nothing when there is nothing to pass', () => {
    expect(latestArtifact({ a: { name: 'a', body: '', producedAt: 99 } })).toBeNull();
    expect(latestArtifact({})).toBeNull();
    expect(latestArtifact(undefined)).toBeNull();
  });
});

describe('cron triggers', () => {
  it('finds the next occurrence in local time', () => {
    // Friday 2026-03-06, 10:00 → the following Monday.
    expect(nextOccurrenceAfter({ kind: 'cron', expr: '0 9 * * 1-5' }, local(2026, 3, 6, 10))).toBe(
      local(2026, 3, 9, 9),
    );
  });

  it('says the days a preset cannot', () => {
    expect(nextOccurrenceAfter({ kind: 'cron', expr: '0 7 1,15 * *' }, local(2026, 3, 2))).toBe(
      local(2026, 3, 15, 7),
    );
  });

  it('has no occurrence when the expression is broken, rather than a guessed one', () => {
    // A hand-edited file can carry one; the editor refuses to save it.
    expect(nextOccurrenceAfter({ kind: 'cron', expr: 'nonsense' }, local(2026, 3, 2))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('fires when due, through the same evaluation as every other trigger', () => {
    const s = makeSchedule({
      trigger: { kind: 'cron', expr: '0 9 * * *' },
      lastFiredAt: local(2026, 3, 2, 9),
    });
    const decision = evaluateSchedule(s, local(2026, 3, 3, 9) + 1_000);
    expect(decision.action).toBe('fire');
  });

  it('reads back as English for the shapes that have any', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('Weekdays at 9am');
    expect(describeTrigger({ kind: 'cron', expr: '30 14 * * *' })).toBe('Every day at 2:30pm');
    expect(describeTrigger({ kind: 'cron', expr: '*/15 * * * *' })).toBe('Every 15 minutes');
  });

  it('reads back as the expression itself when English would be longer', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 7 1,15 * *' })).toBe('Cron: 0 7 1,15 * *');
  });

  it('is saveable when it parses, and refused with the parser reason when it does not', () => {
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'cron', expr: '0 9 * * 1-5' } }))).toBeNull();
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'cron', expr: '0 9 * *' } }))).toContain(
      'five fields',
    );
    expect(validateSchedule(makeSchedule({ trigger: { kind: 'cron', expr: '0 0 31 2 *' } }))).toContain(
      'no next occurrence',
    );
  });
});
