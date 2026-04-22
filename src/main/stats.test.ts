import { describe, expect, it } from 'vitest';
import { dayKey, fillDays, intVal, isSameDay, maxNum, minNum, unslug } from './stats';

describe('intVal', () => {
  it('returns finite numbers truncated toward zero', () => {
    expect(intVal(42)).toBe(42);
    expect(intVal(42.9)).toBe(42);
    expect(intVal(-3.7)).toBe(-3);
  });

  it('parses integer strings', () => {
    expect(intVal('123')).toBe(123);
    expect(intVal('-5')).toBe(-5);
  });

  it('returns 0 for non-number non-integer-string inputs', () => {
    expect(intVal(null)).toBe(0);
    expect(intVal(undefined)).toBe(0);
    expect(intVal('abc')).toBe(0);
    expect(intVal({})).toBe(0);
    expect(intVal(NaN)).toBe(0);
    expect(intVal(Infinity)).toBe(0);
  });
});

describe('minNum / maxNum', () => {
  it('returns the non-null argument when the other is null', () => {
    expect(minNum(5, null)).toBe(5);
    expect(minNum(null, 7)).toBe(7);
    expect(maxNum(5, null)).toBe(5);
    expect(maxNum(null, 7)).toBe(7);
  });

  it('returns null when both are null', () => {
    expect(minNum(null, null)).toBeNull();
    expect(maxNum(null, null)).toBeNull();
  });

  it('picks the smaller / larger when both are numbers', () => {
    expect(minNum(3, 7)).toBe(3);
    expect(minNum(9, 2)).toBe(2);
    expect(maxNum(3, 7)).toBe(7);
    expect(maxNum(9, 2)).toBe(9);
  });

  it('handles zero as a valid non-null value (not falsy)', () => {
    expect(minNum(0, 5)).toBe(0);
    expect(maxNum(0, -5)).toBe(0);
  });
});

describe('isSameDay', () => {
  it('returns true for two timestamps in the same local calendar day', () => {
    const a = new Date(2026, 3, 21, 1, 0, 0).getTime(); // Apr 21 01:00 local
    const b = new Date(2026, 3, 21, 23, 59, 0).getTime(); // Apr 21 23:59 local
    expect(isSameDay(a, b)).toBe(true);
  });

  it('returns false when a timestamp crosses midnight', () => {
    const a = new Date(2026, 3, 21, 23, 59, 0).getTime();
    const b = new Date(2026, 3, 22, 0, 1, 0).getTime();
    expect(isSameDay(a, b)).toBe(false);
  });

  it('returns false when only the year differs', () => {
    const a = new Date(2026, 3, 21, 12, 0, 0).getTime();
    const b = new Date(2027, 3, 21, 12, 0, 0).getTime();
    expect(isSameDay(a, b)).toBe(false);
  });
});

describe('dayKey', () => {
  it('formats a local-time timestamp as YYYY-MM-DD', () => {
    const ts = new Date(2026, 0, 5, 12, 0, 0).getTime(); // Jan 5 2026 local
    expect(dayKey(ts)).toBe('2026-01-05');
  });

  it('zero-pads months and days', () => {
    const ts = new Date(2026, 8, 9, 12, 0, 0).getTime(); // Sep 9 2026
    expect(dayKey(ts)).toBe('2026-09-09');
  });
});

describe('unslug', () => {
  it('restores a leading slash when the slug starts with a dash', () => {
    expect(unslug('-Users-lionel-project')).toBe('/Users/lionel/project');
  });

  it('turns interior dashes into slashes for relative-looking slugs', () => {
    expect(unslug('Users-lionel-project')).toBe('Users/lionel/project');
  });

  it('handles empty and single-segment slugs', () => {
    expect(unslug('')).toBe('');
    expect(unslug('project')).toBe('project');
    expect(unslug('-')).toBe('/');
  });
});

describe('fillDays', () => {
  it('produces `count` consecutive day buckets ending at `now`', () => {
    const now = new Date(2026, 3, 21, 12, 0, 0).getTime(); // Apr 21 local
    const out = fillDays(new Map(), 3, now);
    expect(out.map((d) => d.day)).toEqual(['2026-04-19', '2026-04-20', '2026-04-21']);
    expect(out.every((d) => d.turns === 0 && d.inputTokens === 0 && d.outputTokens === 0)).toBe(true);
  });

  it('preserves existing bucket values when the key matches', () => {
    const now = new Date(2026, 3, 21, 12, 0, 0).getTime();
    const daily = new Map([
      [
        '2026-04-20',
        { day: '2026-04-20', turns: 2, inputTokens: 10, outputTokens: 5, byBackend: {} },
      ],
    ]);
    const out = fillDays(daily, 2, now);
    expect(out).toEqual([
      { day: '2026-04-20', turns: 2, inputTokens: 10, outputTokens: 5, byBackend: {} },
      { day: '2026-04-21', turns: 0, inputTokens: 0, outputTokens: 0, byBackend: {} },
    ]);
  });

  it('returns [] for count 0', () => {
    const out = fillDays(new Map(), 0, Date.now());
    expect(out).toEqual([]);
  });
});
