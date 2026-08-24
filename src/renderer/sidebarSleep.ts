// Rolling cold rows up, in place, without archiving them.
//
// A mature sidebar is mostly things you are not working on: a workspace you
// have not opened in three weeks costs the same vertical space as the repo
// you are inside right now. The fix is neither hiding (people hunt for what
// vanished) nor a separate Snoozed section (one more place to check) nor
// archiving (a decision, and an undo to build). It is a count line where the
// rows were, that opens on click.
//
// Sleeping is presentation only. Nothing here writes to the store, so there
// is no state to migrate, nothing to un-sleep by hand, and search can ignore
// it entirely — a query always looks at every row.

/// How long something has to go untouched before it rolls up.
///
/// Three days rather than one: a Friday afternoon's work must still be awake
/// on Monday morning, or the sidebar forgets the week every weekend.
export const SLEEP_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/// Rows that stay awake however cold they are, so a group you open is never
/// just a count line. The newest few are the ones you would reach for.
export const SLEEP_FLOOR = 3;

/// Below this, rolling up costs more rows than it saves: one sleeping item
/// becomes one count line, which is the same height plus a click.
export const SLEEP_MIN_ROLLUP = 2;

export interface SleepFacts {
  /// When the user last had anything to do with this — prompted in it,
  /// launched it, opened it.
  touchedAt: number;
  /// Never sleeps, whatever its age: it is live, or it is the row the user
  /// is looking at. Putting the open conversation to sleep under a count
  /// line is the one thing this must never do.
  pinned?: boolean;
}

export interface SleepPartition<T> {
  awake: T[];
  sleeping: T[];
}

/// Split an ALREADY SORTED list into the rows that stay and the rows that
/// roll up. Input order is preserved in both halves — this decides presence,
/// never position, so the caller stays the only thing that sorts.
export function partitionSleeping<T>(
  items: readonly T[],
  facts: (item: T) => SleepFacts,
  {
    now = Date.now(),
    after = SLEEP_AFTER_MS,
    floor = SLEEP_FLOOR,
    minRollup = SLEEP_MIN_ROLLUP,
  } = {},
): SleepPartition<T> {
  const cutoff = now - after;
  const awake: T[] = [];
  const sleeping: T[] = [];
  for (const item of items) {
    const f = facts(item);
    if (f.pinned || f.touchedAt >= cutoff) {
      awake.push(item);
      continue;
    }
    // The floor is a minimum on what's SHOWN, not an extra allowance on top
    // of the warm rows: a group with five warm rows has already cleared it,
    // and everything cold below them sleeps.
    if (awake.length < floor) {
      awake.push(item);
      continue;
    }
    sleeping.push(item);
  }
  if (sleeping.length < minRollup) {
    return { awake: [...awake, ...sleeping], sleeping: [] };
  }
  return { awake, sleeping };
}
