// Who gets a slot in the top-of-sidebar "Active" section.
//
// Chats, agents and flow runs all compete for the same slots. An item earns
// one on merit while it's live, waiting on the user, or was touched inside
// the recency window (see ACTIVE_CONVERSATION_WINDOW_MS). On top of that the
// section keeps a floor: the most recent items stay pinned there even once
// they've gone quiet, so stepping away for a coffee doesn't leave you staring
// at an empty Active section with no way back to what you were just doing.

/// 2 = live right now, 1 = waiting on the user or an ongoing commitment
/// (a paused or watching flow), 0 = idle.
export type ActiveRank = 0 | 1 | 2;

export interface ActiveCandidate<T> {
  entry: T;
  rank: ActiveRank;
  /// True when the item earns its slot on merit rather than by backfill.
  active: boolean;
  activityAt: number;
}

/// The most recent items always stay in Active, however long they've been
/// idle. Anything below this floor is only there because it's still active.
export const ACTIVE_SECTION_FLOOR = 3;

/// Upper bound so a burst of parallel work can't push the projects list off
/// the bottom of the sidebar.
export const ACTIVE_SECTION_CAP = 7;

/// Ranks candidates and returns the ones to render, most important first:
/// every active item (up to `cap`), backfilled with the most recent idle
/// items until `floor` rows are on screen.
export function selectActiveEntries<T>(
  candidates: ActiveCandidate<T>[],
  { floor = ACTIVE_SECTION_FLOOR, cap = ACTIVE_SECTION_CAP } = {},
): ActiveCandidate<T>[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      b.rank - a.rank ||
      b.activityAt - a.activityAt,
  );
  const activeCount = ranked.filter((c) => c.active).length;
  const take = Math.min(Math.max(activeCount, floor), Math.max(cap, floor));
  return ranked.slice(0, take);
}
