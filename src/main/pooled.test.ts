import { describe, expect, it } from 'vitest';
import { pooled } from './pooled';

describe('pooled', () => {
  it('never exceeds the limit and keeps the order of the tasks', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20 - i));
      inFlight--;
      return i;
    });
    expect(await pooled(tasks, 4)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBe(4);
  });
});
