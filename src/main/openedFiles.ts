// Files the person opened in overcli from outside it — Finder's "Open With",
// a drop on the Dock icon, `open -a Overcli <file>`.
//
// Reads and writes are otherwise held to registered projects, workspaces and
// worktrees. A file opened this way usually lives in none of them (Downloads,
// the Desktop), and the person choosing overcli to open it is the consent to
// read and save it. So exactly those files are allowed — never their folder:
// the file might sit in the home folder, and a grant on its parent would
// open everything beside it.
//
// For this session only. Opening it again after a restart grants it again.

import * as fs from 'fs';
import * as path from 'path';

/// More than anyone opens by hand in a session; keeps the set bounded.
const MAX_OPENED = 500;

const opened = new Set<string>();

function canonical(target: string): string | null {
  if (!target || !path.isAbsolute(target)) return null;
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/// Note a file the person opened. Returns its canonical path, or null for
/// anything that is not an existing regular file (a folder, a missing path).
export function noteOpenedFile(target: string): string | null {
  const key = canonical(target);
  if (!key) return null;
  try {
    if (!fs.statSync(key).isFile()) return null;
  } catch {
    return null;
  }
  opened.delete(key);
  opened.add(key);
  if (opened.size > MAX_OPENED) {
    const oldest = opened.values().next();
    if (!oldest.done) opened.delete(oldest.value);
  }
  return key;
}

/// Whether this exact file was opened by the person. Compared after
/// resolving symlinks, so a link planted later can't alias an allowed path
/// onto a different file.
export function isOpenedFile(target: string): boolean {
  const key = canonical(target);
  return !!key && opened.has(key);
}

/// Test seam.
export function clearOpenedFiles(): void {
  opened.clear();
}
