import { describe, expect, it } from 'vitest';

import { SLEEP_AFTER_MS, partitionSleeping } from './sidebarSleep';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

interface Row {
  id: string;
  touchedAt: number;
  pinned?: boolean;
}

const row = (id: string, daysAgo: number, pinned = false): Row => ({
  id,
  touchedAt: NOW - daysAgo * DAY,
  pinned,
});

const split = (rows: Row[], opts = {}) =>
  partitionSleeping(rows, (r) => ({ touchedAt: r.touchedAt, pinned: r.pinned }), {
    now: NOW,
    ...opts,
  });

describe('partitionSleeping', () => {
  it('keeps everything awake when nothing is cold', () => {
    const rows = [row('a', 0), row('b', 1), row('c', 2)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sleeping).toEqual([]);
  });

  it('sleeps rows untouched past the threshold', () => {
    const rows = [row('a', 0), row('b', 1), row('c', 2), row('d', 9), row('e', 20), row('f', 30)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sleeping.map((r) => r.id)).toEqual(['d', 'e', 'f']);
  });

  it('never sleeps a pinned row, however cold', () => {
    // The open conversation and anything still running. Rolling the row the
    // user is looking at under a count line is the one unacceptable outcome.
    const rows = [row('a', 0), row('b', 40), row('c', 50), row('d', 60, true), row('e', 70)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toContain('d');
    expect(sleeping.map((r) => r.id)).not.toContain('d');
  });

  it('holds a floor of rows so an opened group is never just a count line', () => {
    const rows = [row('a', 40), row('b', 41), row('c', 42), row('d', 43), row('e', 44)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sleeping.map((r) => r.id)).toEqual(['d', 'e']);
  });

  it('spends no floor on cold rows once warm rows already fill it', () => {
    // The floor is a minimum on what is shown, not an allowance on top of
    // the warm rows — otherwise a busy group shows eight rows and still
    // claims to have rolled up.
    const rows = [row('a', 0), row('b', 0), row('c', 1), row('d', 40), row('e', 41), row('f', 42)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(sleeping.map((r) => r.id)).toEqual(['d', 'e', 'f']);
  });

  it('does not roll up a single row — a count line costs the same height', () => {
    const rows = [row('a', 0), row('b', 0), row('c', 0), row('d', 40)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sleeping).toEqual([]);
  });

  it('preserves the caller ordering in both halves', () => {
    // Sleeping decides presence, never position: the caller stays the only
    // thing that sorts.
    const rows = [row('z', 40), row('a', 41), row('m', 0), row('b', 42), row('c', 43)];
    const { awake, sleeping } = split(rows);
    expect(awake.map((r) => r.id)).toEqual(['z', 'a', 'm']);
    expect(sleeping.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it("keeps Friday's work awake on Monday morning", () => {
    // Three days rather than one, or the sidebar forgets the week every
    // weekend.
    const fridayAfternoon = NOW - (SLEEP_AFTER_MS - 60 * 60 * 1000);
    const { sleeping } = split([{ id: 'fri', touchedAt: fridayAfternoon }]);
    expect(sleeping).toEqual([]);
  });

  it('handles an empty list', () => {
    expect(split([])).toEqual({ awake: [], sleeping: [] });
  });
});
