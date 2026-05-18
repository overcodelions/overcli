import { useRef } from 'react';

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
}: ResizableDividerProps) {
  // Props in a ref so the window listeners registered on pointerdown stay
  // valid across parent re-renders — parents typically pass inline
  // `onCommit` closures, which would otherwise churn handler identity
  // mid-drag and the state update on the first pointermove would tear the
  // listeners right back down.
  const propsRef = useRef({ onChange, onCommit, minWidth, maxWidth, side });
  propsRef.current = { onChange, onCommit, minWidth, maxWidth, side };

  const widthRef = useRef(width);
  widthRef.current = width;

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    document.body.classList.add('cursor-col-resize', 'select-none');

    const onMove = (ev: PointerEvent) => {
      const p = propsRef.current;
      const dx = ev.clientX - startX;
      const signed = p.side === 'left' ? dx : -dx;
      const next = Math.max(p.minWidth, Math.min(p.maxWidth, startWidth + signed));
      widthRef.current = next;
      p.onChange(next);
    };
    const onUp = () => {
      document.body.classList.remove('cursor-col-resize', 'select-none');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      propsRef.current.onCommit?.(widthRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
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
