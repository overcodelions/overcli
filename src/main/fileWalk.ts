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
  return (await walkAsync(root, MAX_FILES, MAX_DIRS)).entries;
}

/// The explorer's listing, plus whether a cap cut it short. A coordinator
/// root linking thirty worktrees blows through 20k files, and the tree used
/// to show the partial listing as if it were the whole folder.
export async function listFileTreeAsync(root: string, maxFiles = MAX_FILES): Promise<WalkResult> {
  return walkAsync(root, maxFiles, MAX_DIRS);
}

/// Directory budget for a name search. Far above the listing's, because a
/// search keeps only matches — the walk is what it costs, not the result.
const SEARCH_MAX_DIRS = 200_000;

/// Files under `root` whose path relative to it contains `query`
/// (case-insensitive) — the tree filter's rule, applied to the whole folder
/// rather than to a listing the cap already truncated.
export async function findFileEntriesAsync(root: string, query: string, limit = 500, signal?: AbortSignal): Promise<WalkResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) return { entries: [], truncated: false, unlistedDirs: [] };
  // The same normalisation the walk's path.join gives every entry.
  const prefix = path.join(root, path.sep);
  return walkAsync(
    root,
    limit,
    SEARCH_MAX_DIRS,
    (full) => (full.startsWith(prefix) ? full.slice(prefix.length) : full).toLowerCase().includes(needle),
    signal,
  );
}

export interface WalkResult {
  entries: WalkEntry[];
  /// A file or directory cap stopped the walk before it saw everything.
  truncated: boolean;
  /// Directories found but never opened because the walk stopped first. The
  /// tree only draws a folder that holds a listed file, so without these a
  /// truncated walk made whole projects vanish rather than show unexpanded.
  unlistedDirs: string[];
}

async function walkAsync(
  root: string,
  maxFiles: number,
  maxDirs: number,
  keep?: (full: string) => boolean,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const out: WalkEntry[] = [];
  const stack: string[] = [root];
  let dirsVisited = 0;
  let full = false;
  const stopped = (): WalkResult => ({ entries: out, truncated: true, unlistedDirs: keep ? [] : stack });
  while (stack.length) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (++dirsVisited > maxDirs) return stopped();
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // One stat per non-directory entry, issued together rather than as a
    // serial chain of awaits — this is what keeps the async walk's
    // wall-clock in the same range as the sync one.
    const pending: Array<Promise<{ full: string; stat: fs.Stats } | null>> = [];
    for (const entry of entries) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (TREE_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue; // sockets, fifos
      // A search skips the stat for files it won't keep. Symlinks still need
      // one: a linked project directory has to be walked, whatever its name.
      if (keep && entry.isFile() && !keep(full)) continue;
      pending.push(
        fs.promises
          .stat(full)
          .then((stat) => ({ full, stat }))
          .catch(() => null),
      );
    }
    const stats = await Promise.all(pending);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    for (const settled of stats) {
      if (!settled) continue;
      // A symlink to a directory (a workspace member) resolves here and gets
      // walked; a symlink to a file lands in the listing like any file.
      if (settled.stat.isDirectory()) {
        stack.push(settled.full);
        continue;
      }
      if (settled.stat.isFile() && !full) {
        if (keep && !keep(settled.full)) continue;
        out.push({ path: settled.full, sizeBytes: settled.stat.size });
        if (out.length > maxFiles) full = true;
      }
    }
    // Finish the batch before stopping, so linked directories later in it
    // (a workspace root is nothing else) still land in `unlistedDirs`.
    if (full) return stopped();
  }
  return { entries: out, truncated: false, unlistedDirs: [] };
}
