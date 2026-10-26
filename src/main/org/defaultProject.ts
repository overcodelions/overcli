// A place for workers to work on a box nobody has set up yet.
//
// Every worker needs a project. On the desktop you have opened some; on a
// fresh server nobody has, and the first hire fails with "add a project
// first". So `serve` makes one folder on the state volume — a plain everyday
// project, a git repo so runs get worktrees and undo — and registers it. Code
// workers still need a real repo added with `overcli projects add`.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { initRepo } from '../git';
import { log } from '../diagnostics';
import { Store, flushStoreSync } from '../store';
import { writeEverydayMarker } from '../everydayProject';

export const DEFAULT_PROJECT_NAME = 'Workers';

export async function ensureDefaultProject(): Promise<string | null> {
  const store = Store.load();
  // Kept even once repos are connected: it's where a hire that isn't about
  // code lands, rather than in the first repo on the list.
  if (store.projects.some((p) => (p as { everyday?: boolean }).everyday)) return null;
  const dir = path.join(host().dataDir(), 'projects', DEFAULT_PROJECT_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const readme = path.join(dir, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, '# Workers\n\nWhere the org\'s workers keep what they make when no project of their own is set.\n', 'utf8');
    }
    writeEverydayMarker(dir);
    const repo = await initRepo({ projectPath: dir });
    if (!repo.ok && repo.reason !== 'already-tracked') log('warn', 'org', `Default project is not a git repo: ${repo.error}`);
  } catch (err) {
    log('warn', 'org', `Could not create the default project: ${String(err)}`);
    return null;
  }
  Store.saveProjects([
    ...Store.load().projects,
    { id: 'org-default-project', name: DEFAULT_PROJECT_NAME, path: dir, conversations: [], everyday: true },
  ]);
  flushStoreSync();
  return dir;
}

const NO_PLACE = 'This server has no project for workers to work in. An admin can add one with: overcli projects add <folder>';

/// Where an org worker may work: only a workspace or project an operator
/// registered. A path from a request is never trusted on its own — a worker
/// pointed at the state folder could rewrite org.json or read credentials.
/// `requested` must match exactly; `suggested` (a drafter's guess) falls back
/// to the default place when it does not.
export function resolveWorkPlace(store: { workspaces: Array<{ rootPath: string }>; projects: Array<{ path: string; everyday?: boolean }> }, requested?: string, suggested?: string): { ok: true; path: string } | { ok: false; error: string } {
  const known = [...store.workspaces.map((w) => w.rootPath), ...store.projects.map((p) => p.path)];
  if (requested !== undefined) {
    return known.includes(requested) ? { ok: true, path: requested } : { ok: false, error: 'Workers can only work in a project this server has. Pick one from the list.' };
  }
  if (suggested && known.includes(suggested)) return { ok: true, path: suggested };
  // Nobody picked one and the job named none: the everyday folder, not the
  // first repo on the list. A hire that isn't about code landed in the code
  // workspace and was handed every repo for every run.
  const everyday = store.projects.find((p) => p.everyday)?.path;
  const fallback = everyday ?? known[0];
  return fallback ? { ok: true, path: fallback } : { ok: false, error: NO_PLACE };
}
