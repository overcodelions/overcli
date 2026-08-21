import { describe, expect, it } from 'vitest';
import { nextComparePick } from './comparePick';

describe('nextComparePick', () => {
  it('arms on the first pick', () => {
    expect(nextComparePick(null, 'a.ts')).toEqual({ base: 'a.ts', pair: null });
  });

  it('fires on the second, in pick order', () => {
    expect(nextComparePick('a.ts', 'b.ts')).toEqual({
      base: null,
      pair: { a: 'a.ts', b: 'b.ts' },
    });
  });

  it('disarms when the armed file is picked again', () => {
    expect(nextComparePick('a.ts', 'a.ts')).toEqual({ base: null, pair: null });
  });
});
