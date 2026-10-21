import { describe, expect, it } from 'vitest';
import { nudgeAllowed } from './OrgNudge';

describe('org nudges', () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  it('show one a week at most, and never once dismissed', () => {
    expect(nudgeAllowed({ dismissed: [] }, 'missed-shift', now)).toBe(true);
    // Another showed two days ago: wait.
    expect(nudgeAllowed({ dismissed: [], shownId: 'share-worker', shownAt: now - 2 * 86_400_000 }, 'missed-shift', now)).toBe(false);
    // The same one keeps showing that week.
    expect(nudgeAllowed({ dismissed: [], shownId: 'missed-shift', shownAt: now - 2 * 86_400_000 }, 'missed-shift', now)).toBe(true);
    expect(nudgeAllowed({ dismissed: [], shownId: 'share-worker', shownAt: now - 8 * 86_400_000 }, 'missed-shift', now)).toBe(true);
    expect(nudgeAllowed({ dismissed: ['missed-shift'] }, 'missed-shift', now)).toBe(false);
  });
});
