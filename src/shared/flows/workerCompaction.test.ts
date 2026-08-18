import { describe, expect, it } from 'vitest';
import { isCompactionDue, lastCompactionSlot } from './workerCompaction';

function local(y: number, mo: number, d: number, h = 0, min = 0): number {
  return new Date(y, mo - 1, d, h, min, 0, 0).getTime();
}

describe('lastCompactionSlot', () => {
  it('returns that week’s Sunday at 03:00 local for a Wednesday', () => {
    const now = local(2026, 8, 19, 15, 0); // a Wednesday
    const slot = new Date(lastCompactionSlot(now));
    expect(slot.getDay()).toBe(0);
    expect(slot.getHours()).toBe(3);
  });
});

describe('isCompactionDue', () => {
  it('is true when the worker has never compacted', () => {
    const now = local(2026, 8, 19, 15, 0);
    expect(isCompactionDue(undefined, now)).toBe(true);
  });

  it('is false just after the slot and true just before it', () => {
    const now = local(2026, 8, 19, 15, 0);
    const slot = lastCompactionSlot(now);
    expect(isCompactionDue(slot + 1000, now)).toBe(false);
    expect(isCompactionDue(slot - 1000, now)).toBe(true);
  });
});
