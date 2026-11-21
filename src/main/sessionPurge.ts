// Delete an agent session's transcript by its id.
//
// Claude keeps a session under `~/.claude/projects/<cwd-slug>/<id>.jsonl`,
// with large tool outputs beside it in `<id>/tool-results/`, and per-session
// bits elsewhere under `~/.claude` (file history, todos, debug logs). The
// slug depends on the folder the session ran in, which for a worker could be
// a run's worktree, its coordinator folder, its project or the home folder —
// so rather than recompute it, every project folder is searched for the id.
//
// Only ids shaped like a session id are acted on: an id is a file name here,
// and one carrying `/` or `..` must never reach `rmSync`.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

function remove(target: string): boolean {
  try {
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function list(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/// Remove everything kept under `configDir` (default `~/.claude`) for these
/// sessions. Returns how many sessions had something to remove, and how many
/// ids were refused for not looking like one.
export function purgeAgentSessions(
  sessionIds: readonly string[],
  configDir: string = path.join(os.homedir(), '.claude'),
): { purged: number; refused: number } {
  const ids = [...new Set(sessionIds)];
  const good = ids.filter(isSessionId);
  const refused = ids.length - good.length;
  if (!good.length) return { purged: 0, refused };

  const projects = path.join(configDir, 'projects');
  const projectDirs = list(projects).filter((d) => d.isDirectory()).map((d) => path.join(projects, d.name));
  const todos = path.join(configDir, 'todos');
  const todoNames = list(todos).map((d) => d.name);
  const debug = path.join(configDir, 'debug');
  const debugNames = list(debug).map((d) => d.name);

  let purged = 0;
  for (const id of good) {
    let any = false;
    for (const dir of projectDirs) {
      if (remove(path.join(dir, `${id}.jsonl`))) any = true;
      if (remove(path.join(dir, id))) any = true;
    }
    if (remove(path.join(configDir, 'file-history', id))) any = true;
    for (const name of todoNames) if (name.startsWith(id) && remove(path.join(todos, name))) any = true;
    for (const name of debugNames) if (name.startsWith(id) && remove(path.join(debug, name))) any = true;
    if (any) purged++;
  }
  return { purged, refused };
}
