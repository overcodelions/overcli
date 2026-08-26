// Who gets a slot in the top-of-sidebar section the UI calls "Working on".
// (This module kept its original name; "Active" below means that same section
// — see Sidebar.tsx's `label="Working on"`.)
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
  /// How hard the user is working this — turns per hour, decayed. See
  /// sidebarMomentum.ts.
  ///
  /// This buys MEMBERSHIP, never position. A thread you keep coming back to
  /// holds its slot well past the flat touch window, which is what "active by
  /// turns, and often" asks for; but it must not reorder the section, because
  /// momentum is a function of history and something you have only just
  /// started has none. Ordering on it meant a conversation you kicked off ten
  /// seconds ago could not reach the top — it sat below whatever you had been
  /// grinding at all morning, which is exactly backwards for a section
  /// answering "what am I doing right now".
  ///
  /// Defaults to 0: no history, no extended slot, no effect on order.
  momentum?: number;
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

/// Momentum that earns a slot on its own, past the touch window.
///
/// Three turns an hour is steady back-and-forth rather than a passing glance,
/// and because momentum decays it expires by itself: the same thread is under
/// the floor a day later without anything having to sweep it. This is the
/// whole of what momentum does here — it lengthens the window for things you
/// keep returning to, and never touches the order.
export const ACTIVE_MOMENTUM_FLOOR = 3;

/// Picks the rows to render, then orders every one of them by the user's own
/// turns.
///
/// A row qualifies three ways: it's still going (`active`), the user touched
/// it inside `touchWindow`, or it carries enough momentum to count as
/// something they keep coming back to. Any of them earns a slot — leaving
/// something doesn't take its slot away, which is what made runs vanish the
/// moment you switched tabs. Below that, the floor backfills so the section is
/// never empty.
///
/// Membership and order are deliberately separate, and they read different
/// clocks. Membership goes by `touchedAt` and `momentum`, so liveness,
/// opening, and coming back to something often all keep a row on screen.
/// Order goes by `promptedAt` alone, so nothing moves a row except the user
/// typing in it: not a backend starting, advancing a step or finishing, not
/// clicking the row, and not a score that decays — a list that reshuffles
/// under the pointer is worse than one that's slightly stale.
///
/// Momentum is deliberately confined to the membership half. It answers "is
/// this still one of the things I'm working on", which is a question about
/// history, and it is useless for "which of these did I touch last", which is
/// the question the eye asks of a list's first row.
export function selectActiveEntries<T>(
  candidates: ActiveCandidate<T>[],
  {
    floor = ACTIVE_SECTION_FLOOR,
    cap = ACTIVE_SECTION_CAP,
    now = Date.now(),
    touchWindow = ACTIVE_USER_TOUCH_WINDOW_MS,
    momentumFloor = ACTIVE_MOMENTUM_FLOOR,
  } = {},
): ActiveCandidate<T>[] {
  const touchCutoff = now - touchWindow;
  const touchedAt = (c: ActiveCandidate<T>) => c.touchedAt ?? c.promptedAt;
  const qualifies = (c: ActiveCandidate<T>) =>
    c.active || touchedAt(c) >= touchCutoff || (c.momentum ?? 0) >= momentumFloor;
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(qualifies(b)) - Number(qualifies(a)) ||
      touchedAt(b) - touchedAt(a) ||
      (b.momentum ?? 0) - (a.momentum ?? 0),
  );
  const earned = ranked.filter(qualifies).length;
  const take = Math.min(Math.max(earned, floor), Math.max(cap, floor));
  return ranked.slice(0, take).sort((a, b) => b.promptedAt - a.promptedAt);
}
