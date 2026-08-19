import { describe, expect, it } from 'vitest';
import { movingAverage, sliceRange } from './statsRange';

const day = (d: string, tokens: number) => ({
  day: d, turns: tokens > 0 ? 1 : 0, inputTokens: tokens, outputTokens: 0,
  linesAdded: 0, linesDeleted: 0, byBackend: {},
});

describe('sliceRange', () => {
  it('drops leading empty days', () => {
    const out = sliceRange([day('a', 0), day('b', 0), day('c', 5), day('d', 0)], 4);
    expect(out.map((d) => d.day)).toEqual(['c', 'd']);
  });
  it('keeps one day when everything is empty', () => {
    expect(sliceRange([day('a', 0), day('b', 0)], 2)).toHaveLength(1);
  });
});

describe('movingAverage', () => {
  it('averages the trailing window', () => {
    expect(movingAverage([0, 10, 20], 2)).toEqual([0, 5, 15]);
  });
});
