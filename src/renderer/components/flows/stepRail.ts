// Geometry and depth ramp for the flow-run step rail. Pure so the falloff
// and the centring math can be tested without a DOM: the rail's whole job
// is telling you WHERE you are in a flow, and an off-by-one there reads as
// the wrong step being "the one".

export interface RailDepth {
  opacity: number;
  scale: number;
  blurPx: number;
}

/// Distance-indexed falloff. Index = |idx - activeIdx|, clamped at 3.
/// The active pill never scales up — transform-scaled text goes soft; it
/// reads as "the one" through the accent ring and its neighbours receding.
const RAMP: RailDepth[] = [
  { opacity: 1, scale: 1, blurPx: 0 },
  { opacity: 0.62, scale: 0.94, blurPx: 0 },
  { opacity: 0.34, scale: 0.88, blurPx: 0.6 },
  { opacity: 0.16, scale: 0.84, blurPx: 1.2 },
];

export function railDepth(distance: number): RailDepth {
  const d = Math.max(0, Math.min(RAMP.length - 1, Math.round(distance)));
  return RAMP[d];
}

/// A connector belongs to both steps it joins, so it recedes with whichever
/// is further out, and sits under both so it never out-shouts a pill.
export function railArrowOpacity(leftDistance: number, rightDistance: number): number {
  return railDepth(Math.max(leftDistance, rightDistance)).opacity * 0.75;
}

/// scrollLeft that centres an item, clamped to the scrollable range — at
/// the ends of a long flow, flush beats a half-empty rail.
export function railScrollLeft(
  viewportWidth: number,
  contentWidth: number,
  itemLeft: number,
  itemWidth: number,
): number {
  const ideal = itemLeft - (viewportWidth - itemWidth) / 2;
  const max = Math.max(0, contentWidth - viewportWidth);
  return Math.max(0, Math.min(max, ideal));
}
