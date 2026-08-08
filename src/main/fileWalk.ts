import fs from 'node:fs';
import path from 'node:path';

/// The recursive project walk behind the file finder and the explorer tree,
/// in two forms: a sync one for callers already on a blocking path (the
/// path resolvers), and an async one for the tree, which relists on every
/// agent write and must not stall the main process to do it.

export interface WalkEntry {
  path: string;
  sizeBytes: number;
}

/// Directories the walk never descends into. The tree watcher filters change
/// events through the same list — a directory we never list must not be a
/// directory whose churn triggers a relist.
export const TREE_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.build',
  'build',
  'bin',
  'dist',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.DS_Store',
  'DerivedData',
  '.swiftpm',
  // IDE + JVM build output: on large multi-project checkouts these dwarf
  // the actual source and used to push the walk past its 20k cap, leaving
  // the tree both slow and silently truncated.
  'out',
  'target',
  '.gradle',
  '.idea',
  '.metadata',
  '.settings',
  '.angular',
  'coverage',
]);

/// Safety cap on the listing a single walk returns.
const MAX_FILES = 20_000;

/// Cap on directories visited. The walk follows symlinked directories (a
/// workspace root is nothing but links to its members), so a link cycle would
/// otherwise spin until the file cap happened to catch it.
const MAX_DIRS = 20_000;

export function listFileEntriesSync(root: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack: string[] = [root];
  let dirsVisited = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    if (++dirsVisited > MAX_DIRS) break;
    let entries: fs.Dirent[];
    try {
      // withFileTypes lets us classify dirs from the readdir result alone,
      // so we only pay a per-entry statSync on files (for size) instead of
      // on every node in the tree — roughly halving syscalls on a big repo.
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (TREE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Symlinks (e.g. workspace roots that symlink several projects)
        // need a follow-stat to resolve their real type and size.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          stack.push(full);
        } else if (stat.isFile()) {
          out.push({ path: full, sizeBytes: stat.size });
          if (out.length > MAX_FILES) return out;
        }
        continue;
      }
      if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        out.push({ path: full, sizeBytes: size });
        if (out.length > MAX_FILES) return out;
      }
    }
  }
  return out;
}

/// Same listing as `listFileEntriesSync`, without holding the thread.
///
/// The sync walk blocks for as long as it runs — measured at ~450ms warm
/// (1.3s cold) on a workspace root linking twenty worktrees. On the main
/// process that's a stall the whole app feels, and the explorer now relists
/// whenever an agent writes. The same syscalls through fs.promises cost about
/// the same wall-clock but leave the event loop free (measured max lag: 2ms),
/// so IPC and streaming keep flowing underneath.
export async function listFileEntriesAsync(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  const stack: string[] = [root];
  let dirsVisited = 0;
  while (stack.length) {
    const cur = stack.pop()!;
    if (++dirsVisited > MAX_DIRS) break;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    // One stat per non-directory entry, issued together rather than as a
    // serial chain of awaits — this is what keeps the async walk's
    // wall-clock in the same range as the sync one.
    const pending: Array<Promise<{ full: string; stat: fs.Stats } | null>> = [];
    for (const entry of entries) {
      if (TREE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, fifos
      pending.push(
        fs.promises
          .stat(full)
          .then((stat) => ({ full, stat }))
          .catch(() => null),
      );
    }
    for (const settled of await Promise.all(pending)) {
      if (!settled) continue;
      // A symlink to a directory (a workspace member) resolves here and gets
      // walked; a symlink to a file lands in the listing like any file.
      if (settled.stat.isDirectory()) {
        stack.push(settled.full);
        continue;
      }
      if (settled.stat.isFile()) {
        out.push({ path: settled.full, sizeBytes: settled.stat.size });
        if (out.length > MAX_FILES) return out;
      }
    }
  }
  return out;
}
