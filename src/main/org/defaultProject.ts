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
  if (store.projects.length > 0 || store.workspaces.length > 0) return null;
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
