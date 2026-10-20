// Ids for projects registered by path, headless: `overcli projects add`, and
// repos connected on the org server.
//
// They used to be the path's first twelve characters, hex-encoded — so every
// repo under /data/repos/ (twelve characters exactly) got the same id, and a
// workspace of them resolved to one repo several times over. Hash the whole
// path instead, and repair stores that already hold collisions.

import { createHash } from 'node:crypto';
import type { Project, Workspace } from '../shared/types';

export function projectIdFor(prefix: string, projectPath: string): string {
  return `${prefix}-${createHash('sha256').update(projectPath).digest('hex').slice(0, 20)}`;
}

/// Give every project but the first of each shared id one of its own, and
/// point workspaces at the projects they meant (by path). Null: nothing to fix.
export function repairProjectIds(store: { projects: Project[]; workspaces: Workspace[] }): { projects: Project[]; workspaces: Workspace[] } | null {
  const seen = new Set<string>();
  let changed = false;
  const projects = store.projects.map((p) => {
    if (typeof p.id !== 'string' || typeof p.path !== 'string') return p;
    if (!seen.has(p.id)) {
      seen.add(p.id);
      return p;
    }
    changed = true;
    const id = projectIdFor(p.id.split('-')[0] || 'project', p.path);
    seen.add(id);
    return { ...p, id };
  });
  if (!changed) return null;
  // A workspace listed its members by id; with the ids shared, the paths its
  // links point at are what it meant. Rebuild its list from those.
  const byPath = new Map(projects.map((p) => [p.path, p.id]));
  const workspaces = store.workspaces.map((w) => {
    const oldIds = new Set(w.projectIds);
    const members = store.projects.filter((p) => oldIds.has(p.id)).map((p) => byPath.get(p.path)!);
    return { ...w, projectIds: [...new Set(members)] };
  });
  return { projects, workspaces };
}
