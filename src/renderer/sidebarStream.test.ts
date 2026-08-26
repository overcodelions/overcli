import { describe, expect, it } from 'vitest';

import { buildStream, bucketFor, groupIntoLanes } from './sidebarStream';
import { ownerPathFor } from './components/SidebarStream';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/// A fixed local-noon so the calendar-day maths is unambiguous under any TZ
/// the suite happens to run in.
const NOON = new Date(2026, 7, 24, 12, 0, 0, 0).getTime();

describe('bucketFor', () => {
  it('files this morning under today', () => {
    expect(bucketFor(NOON - 5 * HOUR, NOON)).toBe('today');
  });

  it('files yesterday afternoon under this week, not today', () => {
    // A rolling 24h window would call yesterday afternoon "today" when read
    // in the morning, and the section label would be a lie.
    const morning = new Date(2026, 7, 24, 9, 0, 0, 0).getTime();
    const yesterdayAfternoon = new Date(2026, 7, 23, 15, 0, 0, 0).getTime();
    expect(bucketFor(yesterdayAfternoon, morning)).toBe('week');
  });

  it('covers the last seven calendar days as this week', () => {
    expect(bucketFor(NOON - 6 * DAY, NOON)).toBe('week');
    expect(bucketFor(NOON - 8 * DAY, NOON)).toBe('earlier');
  });

  it('counts midnight this morning as today', () => {
    const midnight = new Date(2026, 7, 24, 0, 0, 0, 0).getTime();
    expect(bucketFor(midnight, NOON)).toBe('today');
  });
});

interface Row {
  id: string;
  at: number;
  owner: string;
}

const owner = (r: Row) => ({ id: r.owner, name: r.owner, kind: 'project' as const });

describe('groupIntoLanes', () => {
  it('prints an owner once for a run of consecutive rows', () => {
    const rows: Row[] = [
      { id: 'a', at: 5, owner: 'overcli' },
      { id: 'b', at: 4, owner: 'overcli' },
      { id: 'c', at: 3, owner: 'overcli' },
    ];
    const lanes = groupIntoLanes(rows, owner);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].ownerName).toBe('overcli');
    expect(lanes[0].items.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('opens a second lane when the owner comes back later', () => {
    // Run-length, not group-by: collecting every overcli row into one lane
    // would silently re-sort the timeline, which is what Stream exists not
    // to do.
    const rows: Row[] = [
      { id: 'a', at: 5, owner: 'overcli' },
      { id: 'b', at: 4, owner: 'unifyr' },
      { id: 'c', at: 3, owner: 'overcli' },
    ];
    const lanes = groupIntoLanes(rows, owner);
    expect(lanes.map((l) => l.ownerId)).toEqual(['overcli', 'unifyr', 'overcli']);
    expect(lanes.flatMap((l) => l.items.map((r) => r.id))).toEqual(['a', 'b', 'c']);
  });

  it('never reorders the rows it is handed', () => {
    const rows: Row[] = [
      { id: 'a', at: 9, owner: 'x' },
      { id: 'b', at: 8, owner: 'y' },
      { id: 'c', at: 7, owner: 'x' },
      { id: 'd', at: 6, owner: 'y' },
    ];
    expect(groupIntoLanes(rows, owner).flatMap((l) => l.items.map((r) => r.id))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('handles an empty list', () => {
    expect(groupIntoLanes([], owner)).toEqual([]);
  });
});

describe('buildStream', () => {
  const read = (r: Row) => ({ at: r.at, owner: owner(r) });

  it('splits into buckets and lanes each one independently', () => {
    const rows: Row[] = [
      { id: 'now', at: NOON - HOUR, owner: 'overcli' },
      { id: 'today2', at: NOON - 3 * HOUR, owner: 'overcli' },
      { id: 'wk', at: NOON - 2 * DAY, owner: 'unifyr' },
      { id: 'old', at: NOON - 30 * DAY, owner: 'overcli' },
    ];
    const sections = buildStream(rows, read, NOON);
    expect(sections.map((s) => s.bucket)).toEqual(['today', 'week', 'earlier']);
    expect(sections[0].lanes).toHaveLength(1);
    expect(sections[0].lanes[0].items.map((r) => r.id)).toEqual(['now', 'today2']);
    expect(sections[0].count).toBe(2);
    expect(sections[1].lanes[0].ownerName).toBe('unifyr');
  });

  it('drops empty buckets rather than heading an absence', () => {
    const rows: Row[] = [{ id: 'old', at: NOON - 40 * DAY, owner: 'x' }];
    expect(buildStream(rows, read, NOON).map((s) => s.bucket)).toEqual(['earlier']);
  });

  it('keeps buckets in newest-first order however the input arrived', () => {
    const rows: Row[] = [
      { id: 'old', at: NOON - 30 * DAY, owner: 'a' },
      { id: 'now', at: NOON - HOUR, owner: 'a' },
    ];
    expect(buildStream(rows, read, NOON).map((s) => s.bucket)).toEqual(['today', 'earlier']);
  });

  it('handles an empty list', () => {
    expect(buildStream([], read, NOON)).toEqual([]);
  });
});

describe('ownerPathFor', () => {
  const projects = [{ id: 'p1', path: '/home/me/Overcli Projects/Marketing' }];
  const workspaces = [{ id: 'w1', rootPath: '/home/me/work' }];

  it('opens a project lane at the project folder', () => {
    expect(ownerPathFor('p1', projects, workspaces)).toBe(
      '/home/me/Overcli Projects/Marketing',
    );
  });

  it('opens a workspace lane at its root', () => {
    expect(ownerPathFor('w1', projects, workspaces)).toBe('/home/me/work');
  });

  it('opens a path-keyed lane at that path', () => {
    expect(ownerPathFor('path:/tmp/loose-repo', projects, workspaces)).toBe('/tmp/loose-repo');
  });

  // A worker's runs live in its own scratch directory, which is not somewhere
  // the user put anything — so the label stays plain text.
  it('gives a worker lane nowhere to go', () => {
    expect(ownerPathFor('worker:abc', projects, workspaces)).toBeUndefined();
    expect(ownerPathFor('gone', projects, workspaces)).toBeUndefined();
  });
});
