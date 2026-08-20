// Find-in-turn, for the shift reader. Two small pure pieces so the searching
// itself is testable without a DOM: where the matches are in a string, and
// which one is "current" as you step through them.

/// Every match of `query` in `haystack`, as [start, end) offsets, case
/// insensitive. Overlapping matches are not produced — a search for `aa` in
/// `aaaa` finds two, the way a reader would count them.
///
/// Deliberately literal rather than regex: this box is opened by someone
/// trying to find "RED-6787" in a wall of prose, and a stray `(` typed into a
/// regex search either throws or silently matches nothing.
export function matchOffsets(haystack: string, query: string): Array<[number, number]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hay = haystack.toLowerCase();
  const out: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return out;
    out.push([at, at + needle.length]);
    from = at + needle.length;
  }
}

/// Step the current match, wrapping at both ends. A find bar that stops dead
/// at the last match makes you believe there are no more; wrapping is what
/// every other find box in the world does.
export function stepMatch(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return (((current + delta) % total) + total) % total;
}
