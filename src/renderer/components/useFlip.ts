// Rows that change place slide there instead of jumping.
//
// FLIP: after each commit, every `[data-flip]` child is measured against where
// the same key sat last time; a row that moved is put back where it was with a
// transform and then let go, so it travels the distance. Keyed by the
// attribute, not the DOM node, so a row that moves between sections — Running
// down into Recent — still slides even though React built it a new node.
//
// Measured relative to the container, so scrolling the sidebar is not a move.

import { useLayoutEffect, useRef, type RefObject } from 'react';

const DURATION_MS = 280;

export function useFlip(container: RefObject<HTMLElement | null>): void {
  const last = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const origin = root.getBoundingClientRect().top;
    const rows = root.querySelectorAll<HTMLElement>('[data-flip]');
    const next = new Map<string, number>();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    for (const el of rows) {
      const key = el.dataset.flip!;
      // Measured mid-flight when a slide is still running, which is what makes
      // a second move start from where the row visibly is.
      const top = el.getBoundingClientRect().top - origin;
      next.set(key, top);
      const was = last.current.get(key);
      if (reduce || was === undefined) continue;
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
