// Compact "what state is this row in" pip rendered to the left of a
// sidebar row's label. Three rest states share the same 10px box so the
// row's text never reflows when the marker swaps:
//   - active: pulsing ping + filled dot, theme-aware green
//   - completed (and not active): static checkmark in the same green
//   - idle: a small solid dot tinted to the backend's color
//
// Extracted to its own file so both Sidebar.tsx and the flows-specific
// row can import it without forming an import cycle.

import { useMemo } from 'react';

/// Theme-aware running pulse. Reads the CSS var so light mode uses a
/// darker green-600 while dark mode stays on green-400; the old
/// hardcoded #4ade80 washed to near-white against the light surface and
/// the pulse was barely visible.
export const RUNNING_MARKER_COLOR = 'var(--c-running-pulse)';

export function SidebarMarker({
  color,
  active,
  completed = false,
}: {
  color: string;
  active: boolean;
  completed?: boolean;
}) {
  const pingStyle = useMemo(() => synchronizedAnimationStyle(1200), []);
  const markerColor = active ? RUNNING_MARKER_COLOR : color;

  if (!active && completed) {
    return (
      <span
        className="flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center"
        style={{ color: RUNNING_MARKER_COLOR }}
        title="Finished"
        aria-label="Finished"
      >
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" aria-hidden="true">
          <path
            d="M2.5 6.5l2.5 2.5 4.5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (!active) {
    return <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: markerColor }} />;
  }

  return (
    <span className="relative flex h-2.5 w-2.5 flex-shrink-0 items-center justify-center pointer-events-none">
      <span
        className="absolute inline-flex h-full w-full rounded-full animate-ping"
        style={{ ...pingStyle, background: markerColor, opacity: 0.45 }}
      />
      <span
        className="absolute inline-flex h-full w-full rounded-full"
        style={{ background: markerColor, opacity: 0.22 }}
      />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: markerColor }} />
    </span>
  );
}

function synchronizedAnimationStyle(durationMs: number) {
  const phase = Date.now() % durationMs;
  return {
    animationDelay: `${-phase}ms`,
    animationDuration: `${durationMs}ms`,
  };
}
