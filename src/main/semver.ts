// Dotted-triple version parsing/comparison, shared by backendUpdater and
// ollamaSecurity. Kept dependency-free (no Store, no Electron) so anything
// that only needs version comparison — like ollamaSecurity's unit tests —
// doesn't drag in the app store / Electron import chain to get it.

/// Parse the first dotted version triple out of arbitrary CLI/registry text.
export function parseSemver(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/// True iff `a` is strictly older than `b`. Unparseable inputs → false, so we
/// never trigger an update on garbage.
export function isOlder(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}
