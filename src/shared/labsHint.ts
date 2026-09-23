/// When the one-time Labs card on the start page should show. Pure so the
/// timing rules can be tested without a store.

/// Days with a conversation started before the card appears. Coming back on
/// a third day is the signal that someone has chosen Overcli, which is when
/// "there's more" is news rather than noise — three conversations can all
/// happen in the first ten minutes.
export const DAYS_BEFORE_LABS_HINT = 3;
export const LABS_HINT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export function distinctDays(timestamps: readonly number[]): number {
  const days = new Set<string>();
  for (const t of timestamps) {
    if (!t) continue;
    const d = new Date(t);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  return days.size;
}

export function shouldShowLabsHint(args: {
  anyLabOff: boolean;
  seen: boolean | undefined;
  snoozedUntil: number | undefined;
  conversationTimestamps: readonly number[];
  now: number;
}): boolean {
  if (!args.anyLabOff || args.seen) return false;
  if (args.snoozedUntil && args.now < args.snoozedUntil) return false;
  return distinctDays(args.conversationTimestamps) >= DAYS_BEFORE_LABS_HINT;
}
