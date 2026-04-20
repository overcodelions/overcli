/// Symlink-name mapping for a workspace's member projects. Naming is
/// project basename, deduplicated with a numeric suffix on collision so
/// two projects sharing a folder name (e.g. "frontend") both get a
/// usable link. Lives in `shared/` because both the main process (which
/// creates the symlinks and runs git-status aggregation) and the
/// renderer (which maps ChangesBar paths back to their real project)
/// must agree on the exact same names.

interface ProjectRef {
  name: string;
  path: string;
}

export function workspaceSymlinkNames(
  projects: ProjectRef[],
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const used = new Set<string>();
  for (const p of projects) {
    if (!p.path) continue;
    const base = pathBasename(p.path) || slugify(p.name) || 'project';
    let name = base;
    let i = 2;
    while (used.has(name)) {
      name = `${base}-${i}`;
      i += 1;
    }
    used.add(name);
    out.push({ name, path: p.path });
  }
  return out;
}

function pathBasename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
