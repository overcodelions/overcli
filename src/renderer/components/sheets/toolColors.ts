// Colors for tool names in the timing tab.
//
// Two constraints, and they point at the same answer. First, nothing here
// may sit near the accent — the model's share of every bar is drawn in it,
// and a blue `Bash` slice beside a blue model slice hides the one split the
// bar exists to show. Second, the question being asked is "which tool ate
// the time", so color is spent on *cost* rather than on identity: tools are
// ranked slowest to fastest and laid on a red → amber → green ramp, which
// makes the expensive one findable without reading a single number.
//
// The ranking is computed once per view from the conversation-wide totals
// and handed to every row, so a tool keeps one color in the header bar and
// in all its turns. It is deliberately relative: on a conversation whose
// worst tool costs 300ms, that tool is still red. The ramp answers "which
// of these is worst", not "is this bad in absolute terms" — the seconds in
// the legend answer that.

/// Red at the slow end through amber to green at the fast end. Stops short
/// of 120° pure green so the fastest tool still reads as a color rather
/// than as a success state.
const HUE_SLOWEST = 0;
const HUE_FASTEST = 132;

/// Saturation and lightness are fixed across the ramp so slices differ only
/// in hue, and chosen to stay legible on both themes' card backgrounds.
function rampColor(position: number): string {
  const hue = HUE_SLOWEST + (HUE_FASTEST - HUE_SLOWEST) * position;
  return `hsl(${hue.toFixed(0)} 72% 55%)`;
}

/// Map tool names to ramp colors, in the order given — slowest first.
///
/// Callers pass the conversation-wide ranking, not a single turn's, so the
/// color of `Bash` doesn't change as you scroll through turns.
export function toolColorRamp(namesSlowestFirst: string[]): Map<string, string> {
  const colors = new Map<string, string>();
  const last = namesSlowestFirst.length - 1;
  namesSlowestFirst.forEach((name, i) => {
    // A lone tool is the whole cost of every turn it appears in, so it gets
    // the slow end rather than a meaningless midpoint.
    colors.set(name, rampColor(last <= 0 ? 0 : i / last));
  });
  return colors;
}

/// Fallback for a tool that isn't in the ramp — a turn can only ever hold
/// tools the totals already ranked, but a caller shouldn't have to prove it.
export const UNRANKED_TOOL_COLOR = 'hsl(220 8% 55%)';

/// `mcp__slack__slack_post_message` is 30 characters of prefix and one
/// useful word. Show the server and the leaf, drop the scaffolding.
export function shortToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const parts = name.split('__');
  if (parts.length < 3) return name.slice(5);
  return `${parts[1]}:${parts.slice(2).join('__')}`;
}
