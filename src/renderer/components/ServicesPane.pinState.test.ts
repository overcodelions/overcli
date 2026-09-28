import { describe, expect, it } from 'vitest';

import { pinState } from './ServicesPane';

describe('pinState', () => {
  it('tells an honest pin from one that disagrees with where the service runs', () => {
    expect(pinState(undefined, 'master')).toBe('none');
    expect(pinState('master', 'master')).toBe('pinned');
    expect(pinState('feature/acme-512', 'master')).toBe('mismatch');
    // No checkout to compare against: the pin is all there is.
    expect(pinState('feature/acme-512', undefined)).toBe('pinned');
  });
});
