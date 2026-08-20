import { describe, expect, it } from 'vitest';

import { matchOffsets, stepMatch } from './shiftFind';

describe('matchOffsets', () => {
  it('finds every match, case insensitively', () => {
    expect(matchOffsets('RED-6787 and red-6786 and RED-6787', 'red-6787')).toEqual([
      [0, 8],
      [26, 34],
    ]);
  });

  it('does not overlap matches', () => {
    expect(matchOffsets('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('treats the query literally, not as a regex', () => {
    expect(matchOffsets('previewEmailTemplate() returns', '()')).toEqual([[20, 22]]);
    expect(matchOffsets('nothing here', '.*')).toEqual([]);
  });

  it('finds nothing for an empty or whitespace query', () => {
    expect(matchOffsets('anything', '')).toEqual([]);
    expect(matchOffsets('anything', '   ')).toEqual([]);
  });
});

describe('stepMatch', () => {
  it('wraps at both ends', () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });

  it('stays at zero when there is nothing to step through', () => {
    expect(stepMatch(0, 0, 1)).toBe(0);
    expect(stepMatch(0, 0, -1)).toBe(0);
  });
});
