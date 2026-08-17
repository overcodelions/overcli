import { useEffect, useRef, type RefObject } from 'react';

export interface ResizableDividerProps {
  width: number;
  onChange: (width: number) => void;
  /// Called on pointer up / drag end with the final width. Used for
  /// persisting once rather than thrashing localStorage / UserDefaults
  /// on every pointer-move.
  onCommit?: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /// When true, dragging right makes the adjacent pane bigger (left pane
  /// being resized). When false, dragging left makes the adjacent pane
  /// bigger (right pane — e.g. editor pane — being resized). Drives the
  /// sign of the delta applied to width.
  side: 'left' | 'right';
  /// The element this handle sizes. When given, a drag writes the width
  /// straight onto it and `onChange` is called once, on release.
  ///
  /// Without it the drag is a state update per pointermove, so the frame rate
  /// of the resize is the render cost of whatever else the owner draws — fine
  /// beside a chat whose rows are memoised, visibly choppy beside the Workers
  /// tab, which re-renders a roster and a transcript full of rendered markdown
  /// forty times a second for a number only one `style.width` consumes.
  panel?: RefObject<HTMLElement | null>;
}

/// 4px-wide drag handle. Invisible at rest; the 8px-wide hover target
/// shows a subtle accent line while hovered/dragging so it's findable.
export function ResizableDivider({
  width,
  onChange,
  onCommit,
  minWidth,
  maxWidth,
  side,
  panel,
}: ResizableDividerProps) {
  // Props in a ref so the window listeners registered on pointerdown stay
  // valid across parent re-renders — parents typically pass inline
  // `onCommit` closures, which would otherwise churn handler identity
  // mid-drag and the state update on the first pointermove would tear the
  // listeners right back down.
  const propsRef = useRef({ onChange, onCommit, minWidth, maxWidth, side, panel });
  propsRef.current = { onChange, onCommit, minWidth, maxWidth, side, panel };

  const widthRef = useRef(width);
  const draggingRef = useRef(false);
  // Only re-sync from props BETWEEN gestures. Mid-drag the DOM is deliberately
  // ahead of React (see `panel`), so a parent re-render landing between the
  // last pointermove and pointerup would reset this to the pre-drag width and
  // the commit on release would snap the pane back to where it started.
  if (!draggingRef.current) widthRef.current = width;

  // A divider can unmount mid-drag (the pane it sizes closes). The gesture's
  // listeners go with its element, but the body classes would not — leaving a
  // stuck resize cursor and, worse, every iframe in the app inert.
  useEffect(
    () => () => {
      document.body.classList.remove('cursor-col-resize', 'select-none', 'dragging-divider');
    },
    [],
  );

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const handle = e.currentTarget;
    const pointerId = e.pointerId;
    draggingRef.current = true;
    document.body.classList.add('cursor-col-resize', 'select-none', 'dragging-divider');
    // Capture the pointer to the handle so every move for this gesture is
    // delivered here regardless of what it passes over. Without it the panes
    // that embed a sandboxed iframe (the file preview) swallow the drag the
    // instant the pointer crosses into the frame — which is exactly what
    // happens when you drag a right-hand pane's edge inward to narrow it.
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // Pointer already gone (a synthetic or cancelled gesture); the window
      // listeners below still carry the common case.
    }

    const onMove = (ev: PointerEvent) => {
      const p = propsRef.current;
      const dx = ev.clientX - startX;
      const signed = p.side === 'left' ? dx : -dx;
      const next = Math.max(p.minWidth, Math.min(p.maxWidth, startWidth + signed));
      widthRef.current = next;
      const el = p.panel?.current;
      if (el) el.style.width = `${next}px`;
      else p.onChange(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.classList.remove('cursor-col-resize', 'select-none', 'dragging-divider');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        // Capture already released (pointercancel, window blur) — nothing owed.
      }
      const p = propsRef.current;
      // The DOM has been ahead of React for the whole drag; this is where the
      // two are put back in step, at the one width that outlives the gesture.
      if (p.panel) p.onChange(widthRef.current);
      p.onCommit?.(widthRef.current);
    };
    // Listeners go on the capturing handle, not the window: with capture
    // active every event for this pointer is retargeted here, and a
    // pointercancel (window blur, gesture stolen by the OS) has to end the
    // drag too or the body keeps the resize cursor forever.
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      onPointerDown={startDrag}
      onDoubleClick={() => {
        const p = propsRef.current;
        const reset = p.side === 'left' ? 260 : 540;
        p.onChange(reset);
        p.onCommit?.(reset);
      }}
      className="group relative flex-shrink-0 w-[4px] cursor-col-resize select-none z-10"
      title="Drag to resize · double-click to reset"
    >
      {/* Hit target — extends past the 4px visible bar so grabbing
          forgives near-misses. Carries cursor-col-resize itself
          because the parent's 4px box is too narrow to land on
          reliably, and z-10 keeps it above neighbor panes that
          would otherwise eat the hover. */}
      <div className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize z-10" />
      {/* Visible line. Subtle at rest so it doesn't compete with
          conversation chrome, brighter on hover/drag so the user
          can see the grab zone. Always rendered (no bg-transparent)
          so the divider is findable without hover-discovery. */}
      <div className="absolute inset-y-0 left-[1px] w-[2px] bg-card group-hover:bg-accent transition-colors pointer-events-none" />
    </div>
  );
}
