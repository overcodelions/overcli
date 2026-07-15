import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SECTION_CAP,
  ACTIVE_SECTION_FLOOR,
  type ActiveCandidate,
  type ActiveRank,
  selectActiveEntries,
} from './activeSection';

function candidate(
  name: string,
  { rank = 0, active = false, activityAt = 0 }: Partial<Omit<ActiveCandidate<string>, 'entry'>> = {},
): ActiveCandidate<string> {
  return { entry: name, rank: rank as ActiveRank, active, activityAt };
}

const names = (entries: ActiveCandidate<string>[]) => entries.map((e) => e.entry);

describe('selectActiveEntries', () => {
  it('keeps the most recent items when nothing is active', () => {
    const picked = selectActiveEntries([
      candidate('oldest', { activityAt: 1 }),
      candidate('newest', { activityAt: 5 }),
      candidate('middle', { activityAt: 3 }),
      candidate('ancient', { activityAt: 0 }),
    ]);
    expect(names(picked)).toEqual(['newest', 'middle', 'oldest']);
    expect(picked).toHaveLength(ACTIVE_SECTION_FLOOR);
  });

  it('shows every active item, past the floor', () => {
    const picked = selectActiveEntries([
      candidate('a', { active: true, activityAt: 4 }),
      candidate('b', { active: true, activityAt: 3 }),
      candidate('c', { active: true, activityAt: 2 }),
      candidate('d', { active: true, activityAt: 1 }),
      candidate('idle', { activityAt: 9 }),
    ]);
    expect(names(picked)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('backfills idle items to reach the floor', () => {
    const picked = selectActiveEntries([
      candidate('live', { rank: 2, active: true, activityAt: 1 }),
      candidate('idle-new', { activityAt: 9 }),
      candidate('idle-old', { activityAt: 2 }),
      candidate('idle-oldest', { activityAt: 1 }),
    ]);
    expect(names(picked)).toEqual(['live', 'idle-new', 'idle-old']);
  });

  it('ranks live above waiting above idle, then by recency', () => {
    const picked = selectActiveEntries([
      candidate('done-recent', { active: true, activityAt: 8 }),
      candidate('paused', { rank: 1, active: true, activityAt: 2 }),
      candidate('live-older', { rank: 2, active: true, activityAt: 1 }),
      candidate('live-newer', { rank: 2, active: true, activityAt: 7 }),
    ]);
    expect(names(picked)).toEqual(['live-newer', 'live-older', 'paused', 'done-recent']);
  });

  it('caps the section so a burst of work cannot fill the sidebar', () => {
    const many = Array.from({ length: ACTIVE_SECTION_CAP + 4 }, (_, i) =>
      candidate(`run-${i}`, { rank: 2, active: true, activityAt: i }),
    );
    expect(selectActiveEntries(many)).toHaveLength(ACTIVE_SECTION_CAP);
  });

  it('returns what it has when there are fewer items than the floor', () => {
    expect(names(selectActiveEntries([candidate('only', { activityAt: 1 })]))).toEqual(['only']);
    expect(selectActiveEntries([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [candidate('a', { activityAt: 1 }), candidate('b', { activityAt: 2 })];
    selectActiveEntries(input);
    expect(names(input)).toEqual(['a', 'b']);
  });
});
