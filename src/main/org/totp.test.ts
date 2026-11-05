import { describe, expect, it } from 'vitest';
import { base32Decode, totp } from './totp';

describe('authenticator codes', () => {
  it('match RFC 6238’s SHA-1 test vectors', () => {
    // The RFC’s secret: the ASCII digits 1 to 9 then 0, twice, in base32.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(totp(secret, 2_000_000_000_000)).toBe('279037');
  });

  it('reads secrets with spaces and lower case, and refuses anything else', () => {
    expect(base32Decode('gezd gnbv').toString()).toBe('12345');
    expect(() => base32Decode('not base32!')).toThrow();
  });
});
