import { describe, expect, it } from 'vitest';
import { isOlder, parseSemver } from './semver';

describe('parseSemver', () => {
  it('extracts the first dotted triple from arbitrary text', () => {
    expect(parseSemver('Warning: client version is 0.24.0')).toEqual([0, 24, 0]);
  });

  it('returns null when no triple is present', () => {
    expect(parseSemver('not a version')).toBeNull();
  });
});

describe('isOlder', () => {
  it('compares the two-digit-minor case correctly, not as a string', () => {
    // '0.9.0' > '0.10.0' as a string but is older as a version — the whole
    // reason this isn't string comparison.
    expect(isOlder('0.9.0', '0.10.0')).toBe(true);
    expect(isOlder('0.10.0', '0.9.0')).toBe(false);
  });

  it('is false for equal versions', () => {
    expect(isOlder('0.32.14', '0.32.14')).toBe(false);
  });

  it('is false on unparseable input, never triggering an update on garbage', () => {
    expect(isOlder('nonsense', '1.0.0')).toBe(false);
    expect(isOlder('1.0.0', 'nonsense')).toBe(false);
  });
});
