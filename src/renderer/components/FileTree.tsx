import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { fileIconColor, folderIconColor, isTestFileName } from '../fileIcons';
import type { FileTreeEntry } from '@shared/types';

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
  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      const seq = ++seqRef.current;
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      try {
        const list = await window.overcli.invoke('fs:listFileEntries', rootPath);
        if (seq !== seqRef.current) return;
        setEntries(list);
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
    [rootPath],
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
        void load('refresh');
      }
    });
    return () => {
      disposed = true;
      unsub();
      if (watchedKey) void window.overcli.invoke('fs:unwatchTree', rootPath);
    };
  }, [rootPath, load]);

  const blockedCount = useMemo(() => entries.filter(isBlockedEntry).length, [entries]);
  const visibleEntries = useMemo(
    () => (showBlocked ? entries : entries.filter((entry) => !isBlockedEntry(entry))),
    [entries, showBlocked],
  );
  const tree = useMemo(
    () => buildTree(visibleEntries, rootPath, filter.trim().toLowerCase()),
    [visibleEntries, rootPath, filter],
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
          onClick={async () => {
            const res = await window.overcli.invoke('terminal:openFolder', { path: rootPath });
            setActionError(res.ok ? null : res.error);
          }}
          title="Open this folder in Terminal"
          aria-label="Open this folder in Terminal"
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
  children: TreeNode[];
}

function buildTree(entries: FileTreeEntry[], root: string, filter: string): TreeNode {
  const sep = root.includes('\\') ? '\\' : '/';
  const rootTrim = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  const rootNode: TreeNode = {
    name: '',
    fullPath: rootTrim,
    sizeBytes: 0,
    blocked: false,
    key: '',
    isDir: true,
    children: [],
  };
  for (const entry of entries) {
    const full = entry.path;
    const rel = full.startsWith(rootTrim + sep)
      ? full.slice(rootTrim.length + sep.length)
      : full;
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
}) {
  const isOpen = forceOpen || expanded.has(node.key);
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
        onClick={() => toggle(node.key)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle(node.key);
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
        const res = await window.overcli.invoke('terminal:openFolder', { path });
        onResult(res.ok ? null : res.error);
      }}
      title="Open this folder in Terminal"
      aria-label="Open this folder in Terminal"
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
