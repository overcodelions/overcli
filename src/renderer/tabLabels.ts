// Labels for the file editor's tab strip.

export function fileName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function parentName(p: string): string | null {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/// A tab shows just the file name, unless another open tab has the same
/// name — six tabs reading `index.ts` tell you nothing, whereas
/// `main/index.ts` and `preload/index.ts` do. Only one directory level is
/// added; past that the strip gets too wide to scan, and the full path is
/// on the tab's tooltip anyway.
export function tabLabels(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const name = fileName(p);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return paths.map((p) => {
    const name = fileName(p);
    if ((counts.get(name) ?? 0) < 2) return name;
    const parent = parentName(p);
    return parent ? `${parent}/${name}` : name;
  });
}
