import { describe, expect, it } from 'vitest';
import { reorderedKeys } from './useFlip';

describe('reorderedKeys', () => {
  it('does not move anything when a new row arrives on top', () => {
    // Starting a conversation: the new chat lands first and the oldest awake
    // row rolls up under the fold. Nobody changed order.
    expect(reorderedKeys(['a', 'b', 'c', 'd'], ['new', 'a', 'b', 'c'])).toEqual(new Set());
  });

  it('does not move anything when a row leaves', () => {
    expect(reorderedKeys(['a', 'b', 'c'], ['a', 'c'])).toEqual(new Set());
  });

  it('moves the row that rose and the rows it passed', () => {
    expect(reorderedKeys(['a', 'b', 'c', 'd'], ['c', 'a', 'b', 'd'])).toEqual(new Set(['c', 'a', 'b']));
  });

  it('sees a reorder through an insertion at the same time', () => {
    expect(reorderedKeys(['a', 'b', 'c'], ['new', 'c', 'a', 'b'])).toEqual(new Set(['c', 'a', 'b']));
  });

  it('treats the first render as no movement', () => {
    expect(reorderedKeys([], ['a', 'b'])).toEqual(new Set());
  });
});
