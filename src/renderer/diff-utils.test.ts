import { describe, expect, it } from 'vitest';
import { findDiffMatches } from './diff-utils';

describe('findDiffMatches', () => {
  const lines = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,3 @@',
    '-import { Foo } from "./foo";',
    '+import { Bar } from "./bar";',
    ' const foo = new Foo(foo);',
  ];

  it('returns nothing for an empty query', () => {
    expect(findDiffMatches(lines, '')).toEqual([]);
  });

  it('matches case-insensitively across lines, in document order', () => {
    const hits = findDiffMatches(lines, 'foo');
    expect(hits).toEqual([
      // `Foo` and `./foo` on the removed line — the query is lowercase.
      { line: 3, start: 10, end: 13 },
      { line: 3, start: 24, end: 27 },
      { line: 5, start: 7, end: 10 },
      { line: 5, start: 17, end: 20 },
      { line: 5, start: 21, end: 24 },
    ]);
  });

  it('searches the raw line including the +/- sigil', () => {
    expect(findDiffMatches(lines, '-import')).toEqual([{ line: 3, start: 0, end: 7 }]);
    expect(findDiffMatches(lines, '+import')).toEqual([{ line: 4, start: 0, end: 7 }]);
  });

  it('does not return overlapping hits', () => {
    expect(findDiffMatches(['aaaa'], 'aa')).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 2, end: 4 },
    ]);
  });
});
