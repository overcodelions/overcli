// Who gets a slot in the top-of-sidebar "Active" section.
//
// Chats, agents and flow runs all compete for the same slots. An item earns
// one on merit while it's live, waiting on the user, or was touched inside
// the recency window (see ACTIVE_CONVERSATION_WINDOW_MS). On top of that the
// section keeps a floor: the most recent items stay pinned there even once
// they've gone quiet, so stepping away for a coffee doesn't leave you staring
// at an empty Active section with no way back to what you were just doing.
//
// Recency here means the USER's turns, never the CLI's. A backend churning
// through steps or finishing a long run keeps its row visible (that's what
// `active` is for) but must not reorder the section or push out something
// the user typed in more recently.

export interface ActiveCandidate<T> {
  entry: T;
  /// True when the item earns its slot on merit — live, waiting on the user,
  /// or touched inside the recency window — rather than by backfill. This is
  /// the only place backend liveness is allowed in: it decides whether a row
  /// is worth a slot, never where the row sits or which row loses one.
  active: boolean;
  /// When the user last drove this item themselves — sent a turn, launched
  /// a run, clicked Continue. Never stamped by backend progress or
  /// completion. Both the backfill and the on-screen order key off this.
  promptedAt: number;
}

/// The most recent items always stay in Active, however long they've been
/// idle. Anything below this floor is only there because it's still active.
export const ACTIVE_SECTION_FLOOR = 3;

/// Upper bound so a burst of parallel work can't push the projects list off
/// the bottom of the sidebar.
export const ACTIVE_SECTION_CAP = 7;

/// Picks the rows to render — every active item (up to `cap`), backfilled
/// with the items the user drove most recently until `floor` rows are on
/// screen — then orders every row by that same user recency.
///
/// Membership and order are deliberately separate. Liveness earns a slot, so
/// a long run stays visible while it works; but once a row is on screen it
/// sits where the user last left it. Ordering the visible rows by liveness
/// would make the list jump every time a backend starts, advances a step or
/// finishes — and when the section is over `cap`, letting liveness break the
/// tie would evict the chat the user just typed in to keep a busy run.
export function selectActiveEntries<T>(
  candidates: ActiveCandidate<T>[],
  { floor = ACTIVE_SECTION_FLOOR, cap = ACTIVE_SECTION_CAP } = {},
): ActiveCandidate<T>[] {
  const byUserRecency = (a: ActiveCandidate<T>, b: ActiveCandidate<T>) =>
    b.promptedAt - a.promptedAt;
  const ranked = [...candidates].sort(
    (a, b) => Number(b.active) - Number(a.active) || byUserRecency(a, b),
  );
  const activeCount = ranked.filter((c) => c.active).length;
  const take = Math.min(Math.max(activeCount, floor), Math.max(cap, floor));
  return ranked.slice(0, take).sort(byUserRecency);
}
