import { describe, expect, it } from 'vitest';
import { awayLine, dateValueOf, morningAfter, morningOf, nextMondayMorning, returnLabel } from './awayMode';

// Wed 1 Oct 2025, 14:30 local.
const WED = new Date(2025, 9, 1, 14, 30).getTime();

describe('away return dates', () => {
  it('lands on 9am local', () => {
    const t = new Date(morningAfter(WED, 1));
    expect([t.getDate(), t.getHours(), t.getMinutes()]).toEqual([2, 9, 0]);
  });

  it('finds the next Monday, never today', () => {
    expect(new Date(nextMondayMorning(WED)).getDate()).toBe(6);
    const monday = new Date(2025, 9, 6, 8).getTime();
    expect(new Date(nextMondayMorning(monday)).getDate()).toBe(13);
    const sunday = new Date(2025, 9, 5, 20).getTime();
    expect(new Date(nextMondayMorning(sunday)).getDate()).toBe(6);
  });

  it('round-trips a date input value', () => {
    const ms = morningOf('2025-10-06')!;
    expect(dateValueOf(ms)).toBe('2025-10-06');
    expect(new Date(ms).getHours()).toBe(9);
    expect(morningOf('not a date')).toBeNull();
  });

  it('says tomorrow when it is', () => {
    expect(returnLabel(morningAfter(WED, 1), WED)).toBe('tomorrow');
    expect(returnLabel(morningAfter(WED, 5), WED)).not.toBe('tomorrow');
  });

  it('words an open-ended absence', () => {
    expect(awayLine({ since: WED }, WED)).toBe('Away until you’re back');
    expect(awayLine({ since: WED, until: morningAfter(WED, 1) }, WED)).toBe('Away · back tomorrow');
  });
});
