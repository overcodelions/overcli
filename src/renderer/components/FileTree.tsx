import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';

/// Lazily-loaded file tree rooted at the current conversation's project
/// (or worktree) directory. Reuses the main-process `fs:listFiles` IPC
/// which already walks the tree skipping `node_modules`, `.git`, build
/// outputs, etc. Files are grouped into a nested shape and rendered as
/// an expandable tree; clicking a file opens it in the editor pane.
export function FileTree({ rootPath }: { rootPath: string }) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const openFile = useStore((s) => s.openFile);
  const openFilePath = useStore((s) => s.openFilePath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.overcli
      .invoke('fs:listFiles', rootPath)
      .then((list) => {
        if (!cancelled) {
          setFiles(list);
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

  const tree = useMemo(() => buildTree(files, rootPath, filter.trim().toLowerCase()), [
    files,
    rootPath,
    filter,
  ]);

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
  /// Key used in the expanded set — relative path from root so the state
  /// is stable across re-indexes.
  key: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildTree(files: string[], root: string, filter: string): TreeNode {
  const sep = root.includes('\\') ? '\\' : '/';
  const rootTrim = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  const rootNode: TreeNode = {
    name: '',
    fullPath: rootTrim,
    key: '',
    isDir: true,
    children: [],
  };
  for (const full of files) {
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
