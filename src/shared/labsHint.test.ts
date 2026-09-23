import { describe, expect, it } from 'vitest';
import { LABS_HINT_SNOOZE_MS, distinctDays, shouldShowLabsHint } from './labsHint';

const day = (d: number, h = 10) => new Date(2026, 8, d, h).getTime();
const base = {
  anyLabOff: true,
  seen: false,
  snoozedUntil: undefined,
  conversationTimestamps: [day(1), day(1, 15), day(2), day(4)],
  now: day(4, 18),
};

describe('distinctDays', () => {
  it('counts calendar days, not conversations', () => {
    expect(distinctDays([day(1, 9), day(1, 23), day(2)])).toBe(2);
    expect(distinctDays([0, day(3)])).toBe(1);
  });
});

describe('shouldShowLabsHint', () => {
  it('shows on the third day of use', () => {
    expect(shouldShowLabsHint(base)).toBe(true);
  });

  it('waits while every conversation is from fewer than three days', () => {
    expect(
      shouldShowLabsHint({ ...base, conversationTimestamps: [day(1), day(1, 11), day(1, 12), day(2)] }),
    ).toBe(false);
  });

  it('never shows once seen, or when every lab is already on', () => {
    expect(shouldShowLabsHint({ ...base, seen: true })).toBe(false);
    expect(shouldShowLabsHint({ ...base, anyLabOff: false })).toBe(false);
  });

  it('stays away while snoozed and returns after', () => {
    const snoozedUntil = base.now + LABS_HINT_SNOOZE_MS;
    expect(shouldShowLabsHint({ ...base, snoozedUntil })).toBe(false);
    expect(shouldShowLabsHint({ ...base, snoozedUntil, now: snoozedUntil + 1 })).toBe(true);
  });
});
