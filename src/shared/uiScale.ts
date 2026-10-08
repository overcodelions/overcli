/// Interface size: one zoom factor for the whole window, applied by main
/// through `webContents.setZoomFactor`. Zoom rather than a root font-size
/// because the UI is sized in arbitrary px (`text-[11px]` and friends), which
/// a root font-size never reaches — zoom scales text, controls and spacing
/// together, the way the browser's own Cmd+= does.

/// The sizes Settings offers and Cmd/Ctrl +/− steps through, smallest first.
export const UI_SCALE_STEPS = [0.85, 1, 1.1, 1.25, 1.5] as const;

export const DEFAULT_UI_SCALE = 1;

/// Bounds on what is accepted from disk. Wider than the steps on purpose: a
/// hand-edited 1.75 is a choice, not a mistake, and is kept. Outside this it
/// is unreadable either way.
const MIN_UI_SCALE = 0.75;
const MAX_UI_SCALE = 2;

/// A stored value made safe to hand to `setZoomFactor`. Anything that is not
/// a finite number — a settings file from before this existed included —
/// is the default.
export function clampUiScale(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_UI_SCALE;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, raw));
}

/// The next step up (+1) or down (−1) from `current`. A value between steps
/// moves to the nearest step in that direction rather than skipping one; at
/// either end it stays put.
export function stepUiScale(current: number, direction: 1 | -1): number {
  const value = clampUiScale(current);
  if (direction > 0) {
    return UI_SCALE_STEPS.find((s) => s > value + 1e-6) ?? Math.max(value, UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1]);
  }
  return [...UI_SCALE_STEPS].reverse().find((s) => s < value - 1e-6) ?? Math.min(value, UI_SCALE_STEPS[0]);
}
