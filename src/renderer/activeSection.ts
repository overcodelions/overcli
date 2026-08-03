// Who gets a slot in the top-of-sidebar "Active" section.
//
// Chats, agents and flow runs all compete for the same slots. An item earns
// one while it's live or waiting on the user (`active`), and independently
// for a while after the user last touched it (ACTIVE_USER_TOUCH_WINDOW_MS).
// Below both, a floor keeps the section from ever being empty.
//
// Recency here means what the USER did — never what the CLI did. A backend
// churning through steps or finishing a long run keeps its row visible (that's
// what `active` is for) but must not reorder the section or push out something
// the user touched more recently.
//
// The touch window matters as much as the ordering: a slot you earned by
// working on something has to outlast walking away from it, or the section
// empties out exactly when you tab between two runs.

export interface ActiveCandidate<T> {
  entry: T;
  /// True when the item earns its slot on merit — live, waiting on the user,
  /// or touched inside the recency window — rather than by backfill. This is
  /// the only place backend liveness is allowed in: it decides whether a row
  /// is worth a slot, never where the row sits or which row loses one.
  active: boolean;
  /// When the user last drove this item themselves — sent a turn, launched
  /// a run, clicked Continue. Never stamped by backend progress or
  /// completion, and never by merely opening something. The on-screen order,
  /// and only the order, keys off this.
  promptedAt: number;
  /// When the user last had this on screen. Opening something is a user
  /// action, so it holds the row's slot and protects it from eviction — but
  /// it deliberately has no say in where the row sits, because a row that
  /// moves the instant you click it slides out from under the pointer.
  /// Defaults to `promptedAt`.
  touchedAt?: number;
}

/// The most recent items always stay in Active, however long they've been
/// idle. Anything below this floor is only there because it's still active.
export const ACTIVE_SECTION_FLOOR = 3;

/// Upper bound so a burst of parallel work can't push the projects list off
/// the bottom of the sidebar.
export const ACTIVE_SECTION_CAP = 7;

/// How long something you touched keeps its slot after you move on.
///
/// The floor alone can't do this job: it only backfills when fewer than
/// `floor` items are active, so with five things going at once there were no
/// backfill slots at all, and a run dropped out of the section the moment you
/// switched away from it. A recent touch has to earn a slot in its own right.
///
/// Long enough to cover a session of juggling a handful of runs; the cap
/// keeps it honest, so in practice the section is "the last few things I
/// touched, plus anything still going".
export const ACTIVE_USER_TOUCH_WINDOW_MS = 60 * 60 * 1000;

/// Picks the rows to render, then orders every one of them by the user's own
/// turns.
///
/// A row qualifies two ways: it's still going (`active`), or the user touched
/// it inside `touchWindow`. Either earns a slot — leaving something doesn't
/// take its slot away, which is what made runs vanish the moment you switched
/// tabs. Below that, the floor backfills so the section is never empty.
///
/// Membership and order are deliberately separate, and they read different
/// clocks. Membership (and, at the cap, eviction) goes by `touchedAt`, so
/// liveness and opening both keep a row on screen. Order goes by `promptedAt`
/// alone, so nothing moves a row except the user typing in it: not a backend
/// starting, advancing a step or finishing, and not clicking the row — a list
/// that reshuffles under the pointer is worse than one that's slightly stale.
export function selectActiveEntries<T>(
  candidates: ActiveCandidate<T>[],
  {
    floor = ACTIVE_SECTION_FLOOR,
    cap = ACTIVE_SECTION_CAP,
    now = Date.now(),
    touchWindow = ACTIVE_USER_TOUCH_WINDOW_MS,
  } = {},
): ActiveCandidate<T>[] {
  const touchCutoff = now - touchWindow;
  const touchedAt = (c: ActiveCandidate<T>) => c.touchedAt ?? c.promptedAt;
  const qualifies = (c: ActiveCandidate<T>) => c.active || touchedAt(c) >= touchCutoff;
  const ranked = [...candidates].sort(
    (a, b) => Number(qualifies(b)) - Number(qualifies(a)) || touchedAt(b) - touchedAt(a),
  );
  const earned = ranked.filter(qualifies).length;
  const take = Math.min(Math.max(earned, floor), Math.max(cap, floor));
  return ranked.slice(0, take).sort((a, b) => b.promptedAt - a.promptedAt);
}
