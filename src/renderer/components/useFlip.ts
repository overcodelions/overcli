// Rows that change place slide there instead of jumping.
//
// FLIP: after each commit, every `[data-flip]` child is measured against where
// the same key sat last time; a row that moved is put back where it was with a
// transform and then let go, so it travels the distance. Keyed by the
// attribute, not the DOM node, so a row that moves between sections — Running
// down into Recent — still slides even though React built it a new node.
//
// Measured relative to the container, so scrolling the sidebar is not a move.
//
// Only a change of ORDER slides. A row that sits lower only because a new row
// arrived above it (or higher because one left) has not moved anywhere the
// eye needs to follow — and sliding it made it start out on top of the row
// that just appeared, so starting a conversation sent every row in the place
// gliding down over the new one, which read as the whole list flashing.
// Those rows snap; the new row simply appears.

import { useLayoutEffect, useRef, type RefObject } from 'react';

const DURATION_MS = 280;

/// The keys whose order changed relative to the rows that were there both
/// times. Rows only added or removed never count, and neither do the rows
/// whose neighbours they were: that is a shift, not a move.
export function reorderedKeys(prev: readonly string[], next: readonly string[]): Set<string> {
  const before = new Set(prev);
  const after = new Set(next);
  const prevKept = prev.filter((k) => after.has(k));
  const nextKept = next.filter((k) => before.has(k));
  const moved = new Set<string>();
  nextKept.forEach((k, i) => {
    if (prevKept[i] !== k) moved.add(k);
  });
  return moved;
}

export function useFlip(container: RefObject<HTMLElement | null>): void {
  const last = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect().top;
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-flip]'));
    const next = new Map<string, number>();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const moved = reorderedKeys(
      [...last.current.keys()],
      rows.map((el) => el.dataset.flip!),
    );

    for (const el of rows) {
      const key = el.dataset.flip!;
      // Measured mid-flight when a slide is still running, which is what makes
      // a second move start from where the row visibly is.
      const top = el.getBoundingClientRect().top - origin;
      next.set(key, top);
      const was = last.current.get(key);
      if (reduce || was === undefined || !moved.has(key)) continue;
      const delta = was - top;
      if (Math.abs(delta) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      // Commit the offset before letting go, or the browser merges the two.
      void el.offsetHeight;
      el.style.transition = `transform ${DURATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
      el.style.transform = '';
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = '';
        },
        { once: true },
      );
    }
    last.current = next;
  });
}
