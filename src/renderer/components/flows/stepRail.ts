// Geometry and depth ramp for the flow-run step rail. Pure so the falloff
// and the centring math can be tested without a DOM: the rail's whole job
// is telling you WHERE you are in a flow, and an off-by-one there reads as
// the wrong step being "the one".

export interface RailDepth {
  opacity: number;
  scale: number;
}

/// Distance-indexed falloff. Index = |idx - activeIdx|, clamped at 3.
/// The active pill never scales up — transform-scaled text goes soft; it
/// reads as "the one" through the accent ring and its neighbours receding.
///
/// The tail stays legible on purpose. An earlier ramp bottomed out at 0.16
/// opacity with a 1.2px blur, which read as broken rendering rather than
/// depth and cost you the at-a-glance shape of the whole flow — the one
/// thing the old cluttered bar was actually good at. Recession is carried
/// by opacity and a gentle scale; the viewport's edge mask does the rest.
const RAMP: RailDepth[] = [
  { opacity: 1, scale: 1 },
  { opacity: 0.72, scale: 0.96 },
  { opacity: 0.52, scale: 0.93 },
  { opacity: 0.38, scale: 0.9 },
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
