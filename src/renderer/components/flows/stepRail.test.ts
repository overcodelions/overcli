import { describe, expect, it } from 'vitest';

import { railArrowOpacity, railDepth, railScrollLeft } from './stepRail';

describe('railDepth', () => {
  it('is fully opaque and unscaled at the active step', () => {
    expect(railDepth(0)).toEqual({ opacity: 1, scale: 1 });
  });
  it('recedes monotonically with distance', () => {
    expect(railDepth(1).opacity).toBeGreaterThan(railDepth(2).opacity);
    expect(railDepth(2).scale).toBeGreaterThan(railDepth(3).scale);
  });
  it('clamps far distances to the last rung', () => {
    expect(railDepth(9)).toEqual(railDepth(3));
  });
  it('keeps even the furthest step readable', () => {
    expect(railDepth(3).opacity).toBeGreaterThanOrEqual(0.35);
    expect(railDepth(3).scale).toBeGreaterThanOrEqual(0.9);
  });
});

describe('railArrowOpacity', () => {
  it('takes the further of the two steps it joins, dimmed', () => {
    expect(railArrowOpacity(0, 2)).toBeCloseTo(railDepth(2).opacity * 0.75);
  });
});

describe('railScrollLeft', () => {
  it('centres an item in a scrollable rail', () => {
    expect(railScrollLeft(400, 1000, 500, 100)).toBe(350);
  });
  it('never scrolls past the start', () => {
    expect(railScrollLeft(400, 1000, 0, 100)).toBe(0);
  });
  it('never scrolls past the end', () => {
    expect(railScrollLeft(400, 1000, 900, 100)).toBe(600);
  });
  it('stays at 0 when the row fits', () => {
    expect(railScrollLeft(400, 300, 100, 100)).toBe(0);
  });
});
