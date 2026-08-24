// How hard something is being worked, rather than how recently it was touched.
//
// The Working-on section used to rank purely on `promptedAt` — the timestamp
// of your last turn. That makes a message you fired off five minutes ago and
// forgot outrank a thread you have been forty turns deep in all morning,
// which is the opposite of what the section is for.
//
// Momentum is turns-per-hour with an exponential decay on top: how *often*
// you drive something, faded by how long ago you last did. Both halves are
// needed. Frequency alone would keep last week's marathon at the top forever;
// recency alone is what we already have.

/// Half-life of the decay. Four hours is roughly "the other side of lunch":
/// something you were hammering this morning is still clearly warm after
/// lunch, and clearly cold tomorrow.
export const MOMENTUM_HALF_LIFE_MS = 4 * 60 * 60 * 1000;

/// Floor on the activity window, so a burst of turns inside one minute
/// doesn't divide by ~0 and produce an unreachable score. Also the natural
/// unit: momentum is quoted per hour.
export const MOMENTUM_WINDOW_FLOOR_MS = 60 * 60 * 1000;

export interface MomentumInput {
  /// How many turns the USER has driven here. Backend steps must not count —
  /// see the note in activeSection.ts about a flow walking itself through ten
  /// steps outranking a chat you just typed in.
  turns: number;
  /// When the run of activity started. Together with `lastAt` this gives the
  /// window the turns are spread across: 40 turns in an hour and 40 turns
  /// across a fortnight are very different things.
  firstAt: number;
  /// The most recent user turn. Drives the decay.
  lastAt: number;
}

/// Turns per hour, decayed by how long ago the last turn was.
///
/// The decay looks like it makes the order time-dependent — and so like it
/// would reshuffle the section on a timer, which the Active section
/// deliberately never does. It doesn't. For two items the ratio of scores is
///
///   (rateA / rateB) * 2 ^ ((lastB - lastA) / halfLife)
///
/// with `now` cancelling out entirely, so the *relative* order of any two
/// items is fixed the moment their last turns land. Time only ever scales
/// every score by the same factor. Rows therefore move when you take a turn
/// and at no other moment, which is the property the section is built on.
export function momentumScore(input: MomentumInput, now: number = Date.now()): number {
  const turns = Math.max(0, input.turns);
  if (turns === 0) return 0;
  // Clock skew and a stamp written a tick ahead both show up as a lastAt in
  // the future. Clamp it once, here, so it can't stretch the activity window
  // as well as the decay — a skewed row should read as "just now", not as a
  // conversation spread thinly over the next ten hours.
  const lastAt = Math.min(input.lastAt, now);
  const span = Math.max(MOMENTUM_WINDOW_FLOOR_MS, lastAt - input.firstAt);
  const ratePerHour = turns / (span / MOMENTUM_WINDOW_FLOOR_MS);
  const age = Math.max(0, now - lastAt);
  const decay = Math.pow(0.5, age / MOMENTUM_HALF_LIFE_MS);
  return ratePerHour * decay;
}

/// A single user action — launching a flow run, clicking Continue — expressed
/// as momentum, so runs and chats can be ranked against each other in one
/// list. A run has no turn count of its own that the user drove: the runtime
/// pushes attempts by itself, so counting those would let a long flow outrank
/// everything the user actually typed.
export function actionMomentum(actions: number, at: number, now: number = Date.now()): number {
  return momentumScore({ turns: actions, firstAt: at, lastAt: at }, now);
}

/// Bars in the row's momentum meter, 0–3. Zero renders nothing at all rather
/// than an empty meter — a glyph that is always present but usually blank is
/// just noise in a list this dense.
///
/// The thresholds are quoted in turns-per-hour so they can be reasoned about:
/// under one turn an hour is a conversation you are not really in, three is
/// steady back-and-forth, eight is heads-down.
export function momentumBars(score: number): 0 | 1 | 2 | 3 {
  if (score >= 8) return 3;
  if (score >= 3) return 2;
  if (score >= 1) return 1;
  return 0;
}
