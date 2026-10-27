import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useTerminalStore } from '../terminalStore';
import { fileIconColor, folderIconColor, isTestFileName } from '../fileIcons';
import type { FileTreeEntry } from '@shared/types';

/// A path with one separator and no trailing one, so two can be compared
/// by prefix. Done once per path, not once per pair.
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}
function pathsIntersect(x: string, y: string): boolean {
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

/// Lazily-loaded file tree rooted at the current conversation's project
/// (or worktree) directory. Reuses the main-process `fs:listFiles` IPC
/// which already walks the tree skipping `node_modules`, `.git`, build
/// outputs, etc. Files are grouped into a nested shape and rendered as
/// an expandable tree; clicking a file opens it in the editor pane.
///
/// ⌥-clicking a file instead picks it for comparison (`onCompare`): the
/// first pick is held as the base (`compareBase`, highlighted), the second
/// opens a two-file diff. The compare wiring lives in ExplorerPane; the
/// tree just reports the gesture.
/// Memoized: a tree of a few thousand rows is the most expensive thing in
/// the explorer, and its parent re-renders on every pointermove while the
/// user drags the pane divider (and on every settings write). None of that
/// changes a single row. Callers must pass stable `onCompare`/`onBeforeOpen`
/// (see ExplorerPane's useCallback) or this memo does nothing.
export const FileTree = memo(function FileTree({
  rootPath,
  compareBase,
  onCompare,
  onBeforeOpen,
}: {
  rootPath: string;
  compareBase?: string | null;
  onCompare?: (path: string) => void;
  /// Vetoes a plain file-open (returns false to cancel) — used to confirm
  /// discarding unsaved comparison moves before navigating away.
  onBeforeOpen?: () => boolean;
}) {
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  /// The listing hit main's file cap, so it's only part of the folder — the
  /// filter then searches the disk (`diskMatches`) instead of trusting it.
  const [truncated, setTruncated] = useState(false);
  const [diskMatches, setDiskMatches] = useState<FileTreeEntry[]>([]);
  /// Folders the capped walk found but never opened, drawn so they can still
  /// be browsed. Expanding one lists it on its own (`subListings`, keyed by
  /// folder path), which may in turn hand back unopened folders of its own.
  const [unlistedDirs, setUnlistedDirs] = useState<string[]>([]);
  const [subListings, setSubListings] = useState<Map<string, SubListing>>(new Map());
  const subListingsRef = useRef(subListings);
  subListingsRef.current = subListings;
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  /// A relist running underneath the current listing — either the watcher
  /// firing or the refresh button. Only dims the button; the tree stays put.
  const [refreshing, setRefreshing] = useState(false);
  /// Last failure from a row action (open in Terminal). Shown in the footer
  /// and cleared on the next successful one — these fail rarely and never
  /// fatally, so a banner would be too loud.
  const [actionError, setActionError] = useState<string | null>(null);
  const openFile = useStore((s) => s.openFile);
  const openFilePath = useStore((s) => s.openFilePath);

  /// Relist the root. `initial` shows the indexing placeholder and unfolds
  /// the top level; `refresh` keeps the current listing (and the user's open
  /// folders, filter and selection) on screen until the new one lands, so a
  /// background relist isn't visible beyond the row that appeared.
  const seqRef = useRef(0);
  // Keep changes from superseded refreshes until the newest refresh finishes.
  // Otherwise a second event for B can cancel A's pending capped listing.
  const pendingRefreshPaths = useRef<Set<string> | null>(new Set());
  const loadDir = useCallback(async (dir: string, expectedSeq?: number) => {
    let listing: SubListing;
    try {
      const res = await window.overcli.invoke('fs:listFileEntries', dir);
      listing = { entries: res.entries, unlistedDirs: res.unlistedDirs };
    } catch {
      listing = { entries: [], unlistedDirs: [] };
    }
    if (expectedSeq === undefined || expectedSeq === seqRef.current) setSubListings((cur) => new Map(cur).set(dir, listing));
  }, []);
  const load = useCallback(
    async (mode: 'initial' | 'refresh', changedPaths?: string[]) => {
      if (mode === 'initial') pendingRefreshPaths.current = new Set();
      else if (!changedPaths) pendingRefreshPaths.current = null;
      else for (const changed of changedPaths) pendingRefreshPaths.current?.add(changed);
      const seq = ++seqRef.current;
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      try {
        const list = await window.overcli.invoke('fs:listFileEntries', rootPath);
        if (seq !== seqRef.current) return;
        setEntries(list.entries);
        setTruncated(list.truncated);
        setUnlistedDirs(list.unlistedDirs);
        // Folders already opened past the cap relist with the root, or a
        // file written into one would never appear.
        if (mode === 'refresh') {
          const affected = pendingRefreshPaths.current;
          const changed = affected ? [...affected].map(normalizePath) : null;
          const dirs = [...subListingsRef.current.keys()].filter((dir) => { if (!changed) return true; const d = normalizePath(dir); return changed.some((c) => pathsIntersect(c, d)); });
          for (const dir of dirs) {
            if (seq !== seqRef.current) return;
            await loadDir(dir, seq);
          }
          if (seq === seqRef.current) pendingRefreshPaths.current = new Set();
        } else {
          setSubListings(new Map());
        }
        // Auto-expand the top-level so the user sees immediate
        // structure without clicking to unfold the root.
        if (mode === 'initial') setExpanded(new Set(['']));
      } catch {
        // Keep the last good listing rather than blanking the tree.
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [rootPath, loadDir],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  // Watch the root so files an agent drops in show up on their own — the
  // tree used to list once per mount, which meant closing and reopening the
  // pane to see them. Main debounces and filters the events (see
  // fileTreeWatch.ts), so every one that arrives is worth a relist.
  useEffect(() => {
    let watchedKey: string | null = null;
    let disposed = false;
    void window.overcli.invoke('fs:watchTree', rootPath).then((res) => {
      if (!res.ok) return; // no recursive watch here — manual refresh only
      // The effect can be torn down before this resolves; release the
      // reference we just took rather than leaking a watcher.
      if (disposed) {
        void window.overcli.invoke('fs:unwatchTree', rootPath);
        return;
      }
      watchedKey = res.key;
    });
    const unsub = window.overcli.onMainEvent((e) => {
      if (e.type === 'fileTreeChanged' && watchedKey && e.root === watchedKey) {
        void load('refresh', e.changedPaths);
      }
    });
    return () => {
      disposed = true;
      unsub();
      if (watchedKey) void window.overcli.invoke('fs:unwatchTree', rootPath);
    };
  }, [rootPath, load]);

  // A capped listing can't answer a filter on its own: the file being looked
  // for may sit past the cap while a few other matches don't. Search the disk
  // too, debounced, and merge what it finds into the tree.
  const query = filter.trim();
  useEffect(() => {
    if (!truncated || !query) {
      setDiskMatches([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.overcli
        .invoke('fs:findFileEntries', rootPath, query, 'tree')
        .then((res) => {
          if (!cancelled) setDiskMatches(res.entries);
        })
        .catch(() => {
          if (!cancelled) setDiskMatches([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [truncated, query, rootPath]);

  const allEntries = useMemo(() => {
    if (diskMatches.length === 0 && subListings.size === 0) return entries;
    const merged = new Map(entries.map((entry) => [entry.path, entry]));
    for (const listing of subListings.values()) {
      for (const entry of listing.entries) merged.set(entry.path, entry);
    }
    for (const entry of diskMatches) merged.set(entry.path, entry);
    return [...merged.values()];
  }, [entries, diskMatches, subListings]);
  const pendingDirs = useMemo(() => {
    const dirs = new Set(unlistedDirs);
    for (const listing of subListings.values()) for (const dir of listing.unlistedDirs) dirs.add(dir);
    return dirs;
  }, [unlistedDirs, subListings]);
  const blockedCount = useMemo(() => allEntries.filter(isBlockedEntry).length, [allEntries]);
  const visibleEntries = useMemo(
    () => (showBlocked ? allEntries : allEntries.filter((entry) => !isBlockedEntry(entry))),
    [allEntries, showBlocked],
  );
  const tree = useMemo(
    () => buildTree(visibleEntries, rootPath, filter.trim().toLowerCase(), pendingDirs, subListings),
    [visibleEntries, rootPath, filter, pendingDirs, subListings],
  );
  // Stable identities so memoized rows survive a FileTree re-render (a
  // filter keystroke, a failed row action) without rebuilding every node.
  const toggle = useCallback((p: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);
  // An unopened folder lists itself the first time it's expanded.
  const expandUnlisted = useCallback(
    (dir: string) => {
      if (!subListingsRef.current.has(dir)) void loadDir(dir, seqRef.current);
    },
    [loadDir],
  );
  const pick = useCallback(
    (p: string) => {
      if (onBeforeOpen && !onBeforeOpen()) return;
      openFile(p);
    },
    [onBeforeOpen, openFile],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-card">
        <div className="text-xs text-ink-muted truncate flex-1">
          {shortenPath(rootPath)}
        </div>
        {/* Backstop for the watcher: platforms that refuse a recursive
            watch, and anything it filtered out that the user still wants
            picked up. */}
        <button
          type="button"
          onClick={() => void load('refresh')}
          disabled={refreshing}
          title="Refresh file list"
          aria-label="Refresh file list"
          className={
            'flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card ' +
            (refreshing ? 'opacity-40' : '')
          }
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={async (e) => setActionError(await openTerminalHere(rootPath, e.shiftKey))}
          title="Open a terminal in this folder (⇧-click for the system terminal)"
          aria-label="Open a terminal in this folder"
          className="flex h-5 shrink-0 items-center justify-center rounded px-1 font-mono text-[10px] text-ink-faint hover:text-ink hover:bg-card"
        >
          &gt;_
        </button>
        <button
          type="button"
          onClick={() => window.overcli.invoke('fs:openPath', rootPath)}
          title="Open folder in Finder/Explorer"
          aria-label="Open folder in Finder/Explorer"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
        >
          ⤢
        </button>
      </div>
      <div className="px-3 py-2 border-b border-card">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter"
          className="w-full px-2 py-1 text-xs bg-white/5 rounded outline-none focus:bg-white/10"
        />
        {blockedCount > 0 && (
          <button
            onClick={() => setShowBlocked((v) => !v)}
            className="mt-2 text-[10px] text-ink-faint hover:text-ink"
          >
            {showBlocked ? 'Hide' : 'Show'} {blockedCount} blocked file{blockedCount === 1 ? '' : 's'}
          </button>
        )}
        {truncated && (
          <div className="mt-2 text-[10px] text-amber-300/80 leading-relaxed">
            {searching
              ? 'Searching the whole folder…'
              : 'Too many files to list at once — some folders load when opened. Filter searches everything.'}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1 py-1">
        {loading ? (
          <div className="text-xs text-ink-faint px-3 py-2">Indexing…</div>
        ) : tree.children.length === 0 ? (
          <div className="text-xs text-ink-faint px-3 py-2">
            No files match{filter ? ` "${filter}"` : ''}.
          </div>
        ) : (
          tree.children.map((node) => (
            <TreeNode
              key={node.fullPath}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              selectedPath={openFilePath}
              onPick={pick}
              compareBase={compareBase ?? null}
              onCompare={onCompare}
              forceOpen={filter.length > 0}
              onActionError={setActionError}
              onExpandUnlisted={expandUnlisted}
            />
          ))
        )}
      </div>
      {actionError && (
        <div className="px-3 py-1.5 border-t border-card text-[10px] text-red-300 leading-relaxed">
          {actionError}
        </div>
      )}
      {onCompare && (
        <div className="px-3 py-1.5 border-t border-card text-[10px] text-ink-faint leading-relaxed">
          {compareBase ? (
            <span>
              Comparing{' '}
              <span className="font-mono text-amber-300/80">{baseName(compareBase)}</span> — ⌥-click
              another file to diff.
            </span>
          ) : (
            <span>
              <span className="text-ink-muted">Click</span> to open ·{' '}
              <span className="text-ink-muted">⌥-click</span> two files to compare
            </span>
          )}
        </div>
      )}
    </div>
  );
});

interface TreeNode {
  name: string;
  fullPath: string;
  sizeBytes: number;
  blocked: boolean;
  /// Key used in the expanded set — relative path from root so the state
  /// is stable across re-indexes.
  key: string;
  isDir: boolean;
  /// A folder the capped walk never opened — its children arrive on expand.
  unlisted: boolean;
  children: TreeNode[];
}

interface SubListing {
  entries: FileTreeEntry[];
  unlistedDirs: string[];
}

function buildTree(
  entries: FileTreeEntry[],
  root: string,
  filter: string,
  unlistedDirs: Set<string>,
  subListings: Map<string, SubListing>,
): TreeNode {
  const sep = root.includes('\\') ? '\\' : '/';
  const rootTrim = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  const rootNode: TreeNode = {
    name: '',
    fullPath: rootTrim,
    sizeBytes: 0,
    blocked: false,
    key: '',
    isDir: true,
    unlisted: false,
    children: [],
  };
  const relOf = (full: string) =>
    full.startsWith(rootTrim + sep) ? full.slice(rootTrim.length + sep.length) : full;
  // A filter has its own disk search, so unopened folders would only be noise.
  if (!filter) {
    for (const dir of unlistedDirs) {
      let cursor = rootNode;
      const parts = relOf(dir).split(sep);
      for (let i = 0; i < parts.length; i++) {
        let child = cursor.children.find((c) => c.name === parts[i]);
        if (!child) {
          child = {
            name: parts[i],
            fullPath: [cursor.fullPath, parts[i]].join(sep),
            sizeBytes: 0,
            blocked: false,
            key: parts.slice(0, i + 1).join('/'),
            isDir: true,
            unlisted: false,
            children: [],
          };
          cursor.children.push(child);
        }
        cursor = child;
      }
      // Kept once opened, so a folder that turned out empty doesn't vanish.
      cursor.unlisted = !subListings.has(dir);
    }
  }
  for (const entry of entries) {
    const rel = relOf(entry.path);
    if (filter && !rel.toLowerCase().includes(filter)) continue;
    const parts = rel.split(sep);
    let cursor = rootNode;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      let child = cursor.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          fullPath: [cursor.fullPath, part].join(sep),
          sizeBytes: isLeaf ? entry.sizeBytes : 0,
          blocked: isLeaf ? isBlockedEntry(entry) : false,
          key: parts.slice(0, i + 1).join('/'),
          isDir: !isLeaf,
          unlisted: false,
          children: [],
        };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  sortTreeInPlace(rootNode);
  return rootNode;
}

function sortTreeInPlace(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const c of node.children) sortTreeInPlace(c);
}

/// One row (file or folder). Memoized so an unrelated FileTree re-render
/// doesn't walk every node in the tree; `node` comes from a useMemo'd tree
/// and the callbacks are useCallback'd, so the props really are stable.
const TreeNode = memo(function TreeNodeRow({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  onPick,
  compareBase,
  onCompare,
  forceOpen,
  onActionError,
  onExpandUnlisted,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  selectedPath: string | null;
  onPick: (path: string) => void;
  compareBase: string | null;
  onCompare?: (path: string) => void;
  forceOpen: boolean;
  onActionError: (message: string | null) => void;
  onExpandUnlisted: (dir: string) => void;
}) {
  const isOpen = forceOpen || expanded.has(node.key);
  const onToggle = () => {
    if (node.unlisted && !isOpen) onExpandUnlisted(node.fullPath);
    toggle(node.key);
  };
  const selected = selectedPath === node.fullPath;
  const isCompareBase = compareBase === node.fullPath;
  if (!node.isDir) {
    return (
      <button
        // ⌥-click compares files; plain click opens in the editor.
        onClick={(e) => {
          if (onCompare && (e.altKey || (compareBase && compareBase !== node.fullPath))) {
            onCompare(node.fullPath);
          } else {
            onPick(node.fullPath);
          }
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={
          'w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs truncate ' +
          (isCompareBase
            ? 'bg-amber-400/20 text-ink ring-1 ring-amber-300/40'
            : selected
            ? 'bg-accent/20 text-ink'
            : 'text-ink-muted hover:bg-white/5 hover:text-ink')
        }
        title={onCompare ? node.fullPath + '\n(⌥-click to compare)' : node.fullPath}
      >
        <FileGlyph name={node.name} />
        <span className="truncate">{node.name}</span>
        <span className={'ml-auto shrink-0 text-[10px] ' + (node.blocked ? 'text-amber-300/70' : 'text-ink-faint')}>
          {node.blocked ? 'blocked' : formatBytes(node.sizeBytes)}
        </span>
      </button>
    );
  }
  return (
    <div>
      {/* A div, not a button: the row holds its own "open in Terminal"
          button and nested buttons are invalid HTML. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="group w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs text-ink-muted hover:bg-white/5 hover:text-ink cursor-default"
      >
        <span
          className={
            'text-[9px] text-ink-faint flex-shrink-0 ' +
            (isOpen ? 'rotate-90' : '') +
            ' transition-transform'
          }
        >
          ▸
        </span>
        <FolderGlyph name={node.name} open={isOpen} />
        <span className="truncate">{node.name}</span>
        <OpenInTerminalButton path={node.fullPath} onResult={onActionError} />
      </div>
      {isOpen && node.unlisted && node.children.length === 0 && (
        <div style={{ paddingLeft: 20 + (depth + 1) * 12 }} className="py-0.5 text-[10px] text-ink-faint">
          Listing…
        </div>
      )}
      {isOpen &&
        node.children.map((c) => (
          <TreeNode
            key={c.fullPath}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            selectedPath={selectedPath}
            onPick={onPick}
            compareBase={compareBase}
            onCompare={onCompare}
            forceOpen={forceOpen}
            onActionError={onActionError}
            onExpandUnlisted={onExpandUnlisted}
          />
        ))}
    </div>
  );
});

/// Folders carry a tint only when their name says what they're for (src,
/// test, dist, node_modules…). The tinted ones get a filled body so they
/// read as a block of colour at a glance; the rest stay as the old outline
/// in the tree's own ink, so a directory of ordinary folders isn't a
/// fruit salad.
function FolderGlyph({ name, open }: { name: string; open: boolean }) {
  const tint = folderIconColor(name);
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className="flex-shrink-0"
      style={tint ? { color: tint } : undefined}
    >
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill={tint ? 'currentColor' : 'none'}
        fillOpacity={tint ? (open ? 0.5 : 0.28) : 0}
      />
    </svg>
  );
}

/// A filled page in the type's colour, with the classic folded corner left
/// as a notch. Test files get a dot in the corner instead — same colour
/// family as their language, but distinguishable from the file they test.
function FileGlyph({ name }: { name: string }) {
  const color = fileIconColor(name);
  const test = isTestFileName(name);
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      className="flex-shrink-0"
      style={{ color }}
      aria-hidden
    >
      <path
        d="M3 2.5h6l3 3v8A1 1 0 0111 14.5H3A1 1 0 012 13.5V3.5A1 1 0 013 2.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="currentColor"
        fillOpacity={0.32}
      />
      <path d="M9 2.5V5.5H12" stroke="currentColor" strokeWidth="1.2" fill="none" />
      {test && <circle cx="5.5" cy="11" r="1.75" fill="currentColor" />}
    </svg>
  );
}

/// Hover-revealed action on a folder row. Kept out of the row's own
/// `<button>` (nested buttons are invalid HTML) by rendering the row as a
/// div with a button inside — see TreeNode.
function OpenInTerminalButton({
  path,
  onResult,
}: {
  path: string;
  onResult: (error: string | null) => void;
}) {
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        onResult(await openTerminalHere(path, e.shiftKey));
      }}
      title="Open a terminal in this folder (⇧-click for the system terminal)"
      aria-label="Open a terminal in this folder"
      className="ml-auto shrink-0 px-1 rounded font-mono text-[10px] text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink hover:bg-card-strong"
    >
      &gt;_
    </button>
  );
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, '~/');
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

const BLOCKED_EXTENSIONS = new Set([
  '7z',
  'app',
  'bin',
  'bz2',
  'dmg',
  'exe',
  'gz',
  'jar',
  'pkg',
  'rar',
  'tar',
  'tgz',
  'xz',
  'zip',
]);

function isBlockedEntry(entry: FileTreeEntry): boolean {
  return entry.sizeBytes > 5 * 1024 * 1024 || BLOCKED_EXTENSIONS.has(extension(entry.path));
}

function extension(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return name.includes('.') ? name.split('.').pop() ?? '' : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

/// The `>_` buttons: a shell in the app's own drawer, or with Shift the
/// system terminal, for anyone who wants a separate window. Returns the error
/// to show beside the tree, if any; the drawer shows its own.
async function openTerminalHere(path: string, external: boolean): Promise<string | null> {
  if (external) {
    const res = await window.overcli.invoke('terminal:openFolder', { path });
    return res.ok ? null : res.error;
  }
  await useTerminalStore.getState().openAt(path);
  return null;
}
