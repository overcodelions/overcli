// "@Name do this" — sending to a worker by name, skipping the router.
//
// Names can be several words ("Chief of Staff"), so the longest name the text
// starts with wins: "@Chief of Staff move my 3pm" goes to Chief of Staff, not
// to a worker called "Chief". Case is ignored; the rest of the text, minus
// any separating punctuation, is the errand.

export function directTarget(
  text: string,
  workers: Array<{ id: string; name: string; enabled?: boolean }>,
): { workerId: string; ask: string } | null {
  const t = text.trim();
  if (!t.startsWith('@')) return null;
  const body = t.slice(1);
  const lower = body.toLowerCase();
  const hit = workers
    .filter((w) => w.enabled !== false && w.name.trim())
    .sort((a, b) => b.name.length - a.name.length)
    .find((w) => {
      const name = w.name.trim().toLowerCase();
      return lower.startsWith(name) && (lower.length === name.length || /[\s,:;—-]/.test(lower[name.length]));
    });
  if (!hit) return null;
  const ask = body.slice(hit.name.trim().length).replace(/^[\s,:;—-]+/, '').trim();
  return { workerId: hit.id, ask };
}
