import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import type { FileTreeEntry } from '@shared/types';

/// Lazily-loaded file tree rooted at the current conversation's project
/// (or worktree) directory. Reuses the main-process `fs:listFiles` IPC
/// which already walks the tree skipping `node_modules`, `.git`, build
/// outputs, etc. Files are grouped into a nested shape and rendered as
/// an expandable tree; clicking a file opens it in the editor pane.
export function FileTree({ rootPath }: { rootPath: string }) {
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  const openFile = useStore((s) => s.openFile);
  const openFilePath = useStore((s) => s.openFilePath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.overcli
      .invoke('fs:listFileEntries', rootPath)
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setLoading(false);
          // Auto-expand the top-level so the user sees immediate
          // structure without clicking to unfold the root.
          setExpanded(new Set(['']));
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const blockedCount = useMemo(() => entries.filter(isBlockedEntry).length, [entries]);
  const visibleEntries = useMemo(
    () => (showBlocked ? entries : entries.filter((entry) => !isBlockedEntry(entry))),
    [entries, showBlocked],
  );
  const tree = useMemo(
    () => buildTree(visibleEntries, rootPath, filter.trim().toLowerCase()),
    [visibleEntries, rootPath, filter],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-card">
        <div className="text-xs text-ink-muted truncate flex-1">
          {shortenPath(rootPath)}
        </div>
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
              toggle={(p) =>
                setExpanded((cur) => {
                  const next = new Set(cur);
                  if (next.has(p)) next.delete(p);
                  else next.add(p);
                  return next;
                })
              }
              selectedPath={openFilePath}
              onPick={(p) => openFile(p)}
              forceOpen={filter.length > 0}
            />
          ))
        )}
      </div>
    </div>
  );
}

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

function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  selectedPath,
  onPick,
  forceOpen,
}: {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  toggle: (key: string) => void;
  selectedPath: string | null;
  onPick: (path: string) => void;
  forceOpen: boolean;
}) {
  const isOpen = forceOpen || expanded.has(node.key);
  const selected = selectedPath === node.fullPath;
  if (!node.isDir) {
    return (
      <button
        onClick={() => onPick(node.fullPath)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={
          'w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs truncate ' +
          (selected
            ? 'bg-accent/20 text-ink'
            : 'text-ink-muted hover:bg-white/5 hover:text-ink')
        }
        title={node.fullPath}
      >
        <FileGlyph />
        <span className="truncate">{node.name}</span>
        <span className={'ml-auto shrink-0 text-[10px] ' + (node.blocked ? 'text-amber-300/70' : 'text-ink-faint')}>
          {node.blocked ? 'blocked' : formatBytes(node.sizeBytes)}
        </span>
      </button>
    );
  }
  return (
    <div>
      <button
        onClick={() => toggle(node.key)}
        style={{ paddingLeft: 8 + depth * 12 }}
        className="w-full text-left flex items-center gap-1.5 py-0.5 rounded text-xs text-ink-muted hover:bg-white/5 hover:text-ink"
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
        <FolderGlyph />
        <span className="truncate">{node.name}</span>
      </button>
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
            forceOpen={forceOpen}
          />
        ))}
    </div>
  );
}

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M1.5 4.5A1 1 0 012.5 3.5h3.2l1.1 1.3h5.7A1 1 0 0113.5 5.8v5.9A1 1 0 0112.5 12.7h-10A1 1 0 011.5 11.7V4.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
      <path
        d="M3 2.5h6l3 3v8A1 1 0 0111 14.5H3A1 1 0 012 13.5V3.5A1 1 0 013 2.5z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9 2.5V5.5H12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, '~/');
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
