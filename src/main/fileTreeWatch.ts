import fs from 'node:fs';
import path from 'node:path';
import { TREE_SKIP_DIRS } from './fileWalk';

/// Live watching for the explorer's file tree. The tree lists its root once
/// per mount, so a file an agent drops into the project only showed up after
/// the user closed and reopened the pane. A recursive watcher per root lets
/// the renderer relist itself instead.
///
/// One watcher per resolved root, refcounted: the tree can be mounted twice
/// at once (standalone explorer + a conversation's right pane), and a repo
/// only deserves one FSEvents/ReadDirectoryChanges subscription either way.

/// Editor scratch files that churn while someone types but never belong in
/// the tree.
const NOISE_FILE = /(^\.DS_Store$|~$|\.swp$|\.swx$|^\.#|^4913$)/;

/// Coalesce the burst a single agent write turns into (write, rename,
/// chmod, plus the parent directory's own change event) into one relist,
/// while keeping the tree's latency well under a second.
const DEBOUNCE_MS = 300;

/// Floor on the gap between two relists. A relist is a recursive walk of the
/// whole project, so an agent writing steadily for a minute must not put one
/// on every debounce window.
const MIN_GAP_MS = 1_500;

/// The gap scales with what the last relist actually cost, so a small repo
/// (single-digit ms) stays at the floor while a workspace root linking twenty
/// worktrees (~450ms) settles around four seconds. Cheap trees stay live;
/// expensive ones stop dominating.
const GAP_PER_COST = 8;
const MAX_GAP_MS = 30_000;

/// `filename` is the path of the changed entry relative to the watched root,
/// or null when the platform can't name it (in which case we can't rule the
/// change out and have to relist). `rootName` is the watched directory's own
/// basename: macOS reports a change to the root directory itself under that
/// name — including a stale one just after the watch arms — and it never
/// tells us anything a real content event doesn't.
export function isIgnoredTreeChange(filename: string | null, rootName?: string): boolean {
  if (!filename) return false;
  const parts = filename.split(/[/\\]/).filter(Boolean);
  if (parts.length === 0) return true;
  if (rootName && parts.length === 1 && parts[0] === rootName) return true;
  if (parts.some((part) => TREE_SKIP_DIRS.has(part))) return true;
  return NOISE_FILE.test(parts[parts.length - 1]);
}

/// Cap on the link targets a single root pulls in. A workspace links a
/// handful of projects; anything wilder than this doesn't get to open
/// watchers without bound.
const MAX_LINK_WATCHES = 32;

interface WatchEntry {
  watchers: fs.FSWatcher[];
  refs: number;
  timer: NodeJS.Timeout | null;
  lastFireAt: number;
  /// Milliseconds the last relist of this root took, reported by whoever
  /// serves the listing (see `noteRelistCost`). 0 until the first one lands.
  relistCostMs: number;
}

const watchers = new Map<string, WatchEntry>();

/// Report what listing `root` cost, so the watcher can pace itself to the
/// tree it's actually watching rather than to a fixed guess.
export function noteRelistCost(root: string, ms: number): void {
  const entry = watchers.get(path.resolve(root));
  if (entry) entry.relistCostMs = Math.max(0, ms);
}

function gapFor(entry: WatchEntry): number {
  return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, entry.relistCostMs * GAP_PER_COST));
}

/// Start (or join) watching `root`. Returns the resolved key the change
/// events carry, so the renderer can match events to the root it asked for
/// without re-implementing path resolution.
export function watchTree(
  root: string,
  onChange: (key: string) => void,
): { ok: boolean; key: string } {
  const key = path.resolve(root);
  const existing = watchers.get(key);
  if (existing) {
    existing.refs += 1;
    return { ok: true, key };
  }
  const entry: WatchEntry = {
    watchers: [],
    refs: 1,
    timer: null,
    lastFireAt: 0,
    relistCostMs: 0,
  };
  const schedule = () => {
    if (entry.timer) return;
    const wait = Math.max(DEBOUNCE_MS, entry.lastFireAt + gapFor(entry) - Date.now());
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.lastFireAt = Date.now();
      onChange(key);
    }, wait);
    entry.timer.unref?.();
  };
  const attach = (dir: string): boolean => {
    let watcher: fs.FSWatcher;
    try {
      // persistent: false — a watcher must never be the reason the process
      // stays alive at quit.
      watcher = fs.watch(dir, { recursive: true, persistent: false });
    } catch {
      // Recursive watching isn't available everywhere (old kernels, some
      // network mounts). The tree still has its manual refresh.
      return false;
    }
    const dirName = path.basename(dir);
    watcher.on('change', (_event, filename) => {
      const name = typeof filename === 'string' ? filename : filename?.toString() ?? null;
      if (isIgnoredTreeChange(name, dirName)) return;
      schedule();
    });
    // A watcher that errors out (directory deleted, descriptor limit) is
    // dead; drop the whole registration rather than leaving a silent no-op
    // behind. The next mount re-registers.
    watcher.on('error', () => {
      closeEntry(key);
    });
    entry.watchers.push(watcher);
    return true;
  };

  if (!attach(key)) return { ok: false, key };
  watchers.set(key, entry);
  // A recursive watch stops at symlinks, and a workspace root is nothing
  // but symlinks to the member projects — watching only the root would
  // report nothing the user cares about. Follow the links one level, which
  // is exactly how deep the workspace layout goes.
  for (const target of linkedDirs(key)) {
    if (entry.watchers.length >= MAX_LINK_WATCHES) break;
    attach(target);
  }
  return { ok: true, key };
}

/// Absolute targets of the directory symlinks directly under `dir`.
function linkedDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.isSymbolicLink() || TREE_SKIP_DIRS.has(e.name)) continue;
    try {
      const target = fs.realpathSync(path.join(dir, e.name));
      if (fs.statSync(target).isDirectory()) out.add(target);
    } catch {
      // Broken link — the walk skips it too.
    }
  }
  return [...out];
}

/// Release one reference. The watcher closes when the last mount lets go.
export function unwatchTree(root: string): void {
  const key = path.resolve(root);
  const entry = watchers.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  closeEntry(key);
}

export function closeAllTreeWatchers(): void {
  for (const key of [...watchers.keys()]) closeEntry(key);
}

/// Number of live watchers — for tests and diagnostics.
export function activeTreeWatchCount(): number {
  return watchers.size;
}

function closeEntry(key: string): void {
  const entry = watchers.get(key);
  if (!entry) return;
  watchers.delete(key);
  if (entry.timer) clearTimeout(entry.timer);
  for (const watcher of entry.watchers) {
    try {
      watcher.close();
    } catch {
      // Already closed by the platform — nothing to unwind.
    }
  }
  entry.watchers = [];
}
