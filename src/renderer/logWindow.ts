// How much of a long log is on the page at once.
//
// A busy service keeps ten thousand lines, and putting every one of them on
// the page made the pane expensive to show and, worse, to leave: switching
// tabs tore down tens of thousands of elements in one go and the window hung
// on it. Only the newest stretch is drawn; scrolling up to its top draws the
// stretch before it. Search and the level filters still run over every line —
// this changes what is drawn, never what can be found.

import type { LogItem } from './stackFrames';

/// Rows drawn while following the output.
export const LOG_WINDOW = 1500;
/// Rows added each time the reader reaches the top of what is drawn.
export const LOG_WINDOW_STEP = 1000;

/// The line a row starts at — what a window is anchored to, since a line index
/// survives a new filter and a row position does not.
export function firstLine(item: LogItem): number {
  return item.kind === 'line' ? item.index : item.indices[0];
}

/// Where the drawn rows begin. `from` is the line the reader's window starts
/// at, or null while following, when it is simply the newest `size` rows.
///
/// A window never holds fewer than `size` rows when the log has them: an
/// anchor past the end — the output was cleared, or its oldest lines dropped —
/// falls back to the tail rather than drawing an empty pane.
export function windowStart(items: readonly LogItem[], from: number | null, size = LOG_WINDOW): number {
  const tail = Math.max(0, items.length - size);
  if (from === null) return tail;
  // Rows are in line order, so the first at or past the anchor is a search.
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (firstLine(items[mid]) < from) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, tail);
}
