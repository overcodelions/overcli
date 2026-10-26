import { describe, expect, it } from 'vitest';
import { digestDue } from './orgService';

describe('the Monday digest', () => {
  // Monday 26 Oct 2026, 13:30 UTC = 09:30 in New York.
  const monday930 = Date.UTC(2026, 9, 26, 13, 30);
  it('is due from 9 on a Monday in the org’s time zone, once a week', () => {
    expect(digestDue(monday930, 'America/New_York', null)).toBe('2026-10-26');
    expect(digestDue(monday930, 'America/New_York', '2026-10-26')).toBeNull();
    expect(digestDue(monday930 - 60 * 60_000, 'America/New_York', null)).toBeNull();
    expect(digestDue(monday930 + 86_400_000, 'America/New_York', null)).toBeNull();
  });
});
