import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SECTION_CAP,
  ACTIVE_SECTION_FLOOR,
  ACTIVE_USER_TOUCH_WINDOW_MS,
  type ActiveCandidate,
  selectActiveEntries,
} from './activeSection';

function candidate(
  name: string,
  { active = false, promptedAt = 0 }: Partial<Omit<ActiveCandidate<string>, 'entry'>> = {},
): ActiveCandidate<string> {
  return { entry: name, active, promptedAt };
}

const names = (entries: ActiveCandidate<string>[]) => entries.map((e) => e.entry);

describe('selectActiveEntries', () => {
  it('keeps the most recent items when nothing is active', () => {
    const picked = selectActiveEntries([
      candidate('oldest', { promptedAt: 1 }),
      candidate('newest', { promptedAt: 5 }),
      candidate('middle', { promptedAt: 3 }),
      candidate('ancient', { promptedAt: 0 }),
    ]);
    expect(names(picked)).toEqual(['newest', 'middle', 'oldest']);
    expect(picked).toHaveLength(ACTIVE_SECTION_FLOOR);
  });

  it('shows every active item, past the floor', () => {
    const picked = selectActiveEntries([
      candidate('a', { active: true, promptedAt: 4 }),
      candidate('b', { active: true, promptedAt: 3 }),
      candidate('c', { active: true, promptedAt: 2 }),
      candidate('d', { active: true, promptedAt: 1 }),
      candidate('idle', { promptedAt: 9 }),
    ]);
    expect(names(picked)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('backfills idle items to reach the floor', () => {
    const picked = selectActiveEntries([
      candidate('live', { active: true, promptedAt: 1 }),
      candidate('idle-new', { promptedAt: 9 }),
      candidate('idle-old', { promptedAt: 2 }),
      candidate('idle-oldest', { promptedAt: 0 }),
    ]);
    expect(names(picked)).toEqual(['idle-new', 'idle-old', 'live']);
  });

  it('orders every visible row by the user\'s own turns, not liveness', () => {
    const picked = selectActiveEntries([
      candidate('typed-last', { active: true, promptedAt: 9 }),
      candidate('paused', { active: true, promptedAt: 4 }),
      candidate('live-typed-first', { active: true, promptedAt: 1 }),
      candidate('live-typed-second', { active: true, promptedAt: 6 }),
    ]);
    expect(names(picked)).toEqual(['typed-last', 'live-typed-second', 'paused', 'live-typed-first']);
  });

  it('holds the order still while a backend works and finishes', () => {
    // A long run advances steps and completes. Nothing it does is a user
    // turn, so promptedAt never moves and neither does the section — the row
    // holds its place while running and after it goes quiet.
    const rows = (runStillActive: boolean) => [
      candidate('typed-recently', { active: true, promptedAt: 5 }),
      candidate('long-run', { active: runStillActive, promptedAt: 1 }),
      candidate('idle', { promptedAt: 0 }),
    ];
    expect(names(selectActiveEntries(rows(true)))).toEqual(['typed-recently', 'long-run', 'idle']);
    expect(names(selectActiveEntries(rows(false)))).toEqual(['typed-recently', 'long-run', 'idle']);
  });

  it('never evicts a freshly typed chat in favour of a busier backend', () => {
    const picked = selectActiveEntries(
      [
        candidate('just-typed', { active: true, promptedAt: 100 }),
        candidate('busy-old-run', { active: true, promptedAt: 1 }),
        candidate('other-old-run', { active: true, promptedAt: 2 }),
      ],
      { floor: 1, cap: 2 },
    );
    expect(names(picked)).toContain('just-typed');
    expect(names(picked)[0]).toBe('just-typed');
  });

  it('keeps something you just left, even with the section full of active work', () => {
    // The reported bug: five things going at once meant zero backfill slots,
    // so the run you'd just switched away from disappeared on the spot.
    const now = 10 * ACTIVE_USER_TOUCH_WINDOW_MS;
    const picked = selectActiveEntries(
      [
        candidate('just-left', { active: false, promptedAt: now - 1000 }),
        ...Array.from({ length: 5 }, (_, i) =>
          candidate(`busy-${i}`, { active: true, promptedAt: now - 60 * 60_000 - i }),
        ),
      ],
      { now },
    );
    expect(names(picked)[0]).toBe('just-left');
    expect(picked).toHaveLength(6);
  });

  it('lets go once the touch window has passed and nothing is active', () => {
    const now = 10 * ACTIVE_USER_TOUCH_WINDOW_MS;
    const picked = selectActiveEntries(
      [
        candidate('stale', { promptedAt: now - ACTIVE_USER_TOUCH_WINDOW_MS - 1 }),
        ...Array.from({ length: 5 }, (_, i) =>
          candidate(`busy-${i}`, { active: true, promptedAt: now - 1000 - i }),
        ),
      ],
      { now },
    );
    expect(names(picked)).not.toContain('stale');
  });

  it('caps the section so a burst of work cannot fill the sidebar', () => {
    const many = Array.from({ length: ACTIVE_SECTION_CAP + 4 }, (_, i) =>
      candidate(`run-${i}`, { active: true, promptedAt: i }),
    );
    expect(selectActiveEntries(many)).toHaveLength(ACTIVE_SECTION_CAP);
  });

  it('returns what it has when there are fewer items than the floor', () => {
    expect(names(selectActiveEntries([candidate('only', { promptedAt: 1 })]))).toEqual(['only']);
    expect(selectActiveEntries([])).toEqual([]);
  });

  it('does not mutate its input', () => {
    const input = [candidate('a', { promptedAt: 1 }), candidate('b', { promptedAt: 2 })];
    selectActiveEntries(input);
    expect(names(input)).toEqual(['a', 'b']);
  });
});
