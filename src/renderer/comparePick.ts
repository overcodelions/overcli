/// The ⌥-click state machine behind a two-file comparison.
///
/// One pick arms the comparison, a second fires it, and re-picking the armed
/// file disarms. Kept out of the components because two of them drive it —
/// the standalone explorer and the flow run's file tree — and a comparison
/// that behaves differently depending on which tree you opened it from is a
/// worse bug than not having it.
export function nextComparePick(
  base: string | null,
  path: string,
): { base: string | null; pair: { a: string; b: string } | null } {
  if (!base) return { base: path, pair: null };
  // ⌥-click the armed file again to cancel, rather than diffing it with
  // itself — the only thing that gesture could otherwise mean.
  if (base === path) return { base: null, pair: null };
  return { base: null, pair: { a: base, b: path } };
}
