import { describe, expect, it } from 'vitest';

import { cronError, cronIntervalMinutes, nextCronOccurrence, parseCron } from './cron';

/// Local-time helper, so expectations read as wall-clock and don't silently
/// depend on the machine's timezone.
function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

function next(expr: string, after: number): number {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return nextCronOccurrence(parsed.fields, after);
}

describe('parseCron', () => {
  it('reads the ordinary shapes', () => {
    const parsed = parseCron('*/15 9-17 * * 1-5');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.fields.minutes]).toEqual([0, 15, 30, 45]);
    expect([...parsed.fields.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...parsed.fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.fields.domRestricted).toBe(false);
    expect(parsed.fields.dowRestricted).toBe(true);
  });

  it('takes month and weekday names', () => {
    const parsed = parseCron('0 6 * jan-mar mon,fri');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect([...parsed.fields.months]).toEqual([1, 2, 3]);
    expect([...parsed.fields.daysOfWeek].sort()).toEqual([1, 5]);
  });

  it('folds day 7 onto Sunday, so both spellings mean the same day', () => {
    const seven = parseCron('0 0 * * 7');
    const zero = parseCron('0 0 * * 0');
    expect(seven.ok && zero.ok).toBe(true);
    if (!seven.ok || !zero.ok) return;
    expect([...seven.fields.daysOfWeek]).toEqual([...zero.fields.daysOfWeek]);
  });

  it('expands the macros people type without thinking', () => {
    expect(next('@daily', local(2026, 3, 2, 5))).toBe(local(2026, 3, 3, 0, 0));
    expect(next('@hourly', local(2026, 3, 2, 5, 30))).toBe(local(2026, 3, 2, 6, 0));
  });

  it('rejects prototype keys and non-space whitespace without throwing', () => {
    expect(parseCron('constructor').ok).toBe(false);
    expect(parseCron('__proto__').ok).toBe(false);
    expect(parseCron('0\t9 * * *').ok).toBe(false);
    expect(parseCron('0 9 *\n* *').ok).toBe(false);
  });

  it('finds a one-minute minimum gap at a fixed time', () => {
    const parsed = parseCron('0,1 * * * *');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(cronIntervalMinutes(parsed.fields, local(2026, 3, 2, 0, 30))).toBe(1);
  });

  it('treats ? as *, the way a pasted Quartz expression means it', () => {
    expect(next('0 9 ? * 1', local(2026, 3, 2, 10))).toBe(local(2026, 3, 9, 9));
  });

  it('rejects a 6-field expression by name rather than mis-reading the fields', () => {
    const parsed = parseCron('0 0 9 * * 1-5');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('seconds');
  });

  it('names the field it could not read', () => {
    const parsed = parseCron('0 25 * * *');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('hour');
  });

  it('refuses a backwards range, and says how to write it instead', () => {
    const parsed = parseCron('0 22-2 * * *');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('22-23,0-2');
  });
});

describe('nextCronOccurrence', () => {
  it('is strictly after the anchor, so the firing that just happened is not found again', () => {
    const nine = local(2026, 3, 2, 9);
    expect(next('0 9 * * *', nine)).toBe(local(2026, 3, 3, 9));
  });

  it('walks to the next allowed weekday', () => {
    // Friday 2026-03-06, 10:00 → Monday.
    expect(next('30 8 * * 1-5', local(2026, 3, 6, 10))).toBe(local(2026, 3, 9, 8, 30));
  });

  it('handles specific dates across a month boundary', () => {
    expect(next('0 7 1,15 * *', local(2026, 3, 16))).toBe(local(2026, 4, 1, 7));
  });

  it('ORs the day fields when both are restricted, as standard cron does', () => {
    // The 1st (a Sunday) is matched by day-of-month; the 2nd by day-of-week.
    expect(next('0 0 1 3 1', local(2026, 2, 28))).toBe(local(2026, 3, 1));
    expect(next('0 0 1 3 1', local(2026, 3, 1))).toBe(local(2026, 3, 2));
  });

  it('crosses a year to find a February date', () => {
    expect(next('0 0 29 2 *', local(2026, 3, 1))).toBe(local(2028, 2, 29));
  });

  it('is Infinity for an expression that can never match, rather than a guess', () => {
    expect(next('0 0 31 2 *', local(2026, 3, 1))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('cronError', () => {
  it('passes a usable expression', () => {
    expect(cronError('0 9 * * 1-5')).toBeNull();
  });

  it('rejects one with no occurrence, which would look armed and never fire', () => {
    expect(cronError('0 0 31 2 *')).toContain('no next occurrence');
  });

  it('rejects an empty box with a worked example', () => {
    expect(cronError('  ')).toContain('0 9 * * 1-5');
  });
});

describe('cronIntervalMinutes', () => {
  it('measures the gap between the next two firings', () => {
    const parsed = parseCron('*/30 * * * *');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(cronIntervalMinutes(parsed.fields, local(2026, 3, 2, 9, 5))).toBe(30);
  });

  it('is a day for a daily expression', () => {
    const parsed = parseCron('0 9 * * *');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(cronIntervalMinutes(parsed.fields, local(2026, 3, 2, 10))).toBe(1440);
  });
});
