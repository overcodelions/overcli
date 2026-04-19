import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';

export function FileFinderSheet({ rootPath }: { rootPath: string }) {
  const openFile = useStore((s) => s.openFile);
  const openSheet = useStore((s) => s.openSheet);
  const pendingFinderQuery = useStore((s) => s.pendingFinderQuery);
  const [query, setQuery] = useState(pendingFinderQuery);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.overcli.invoke('fs:listFiles', rootPath).then((list) => {
      if (!cancelled) {
        setFiles(list);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rootPath]);

  const filtered = useMemo(() => rankMatches(files, query, rootPath).slice(0, 60), [files, query, rootPath]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  const commit = (path: string) => {
    openFile(path);
    openSheet(null);
  };

  return (
    <div className="flex flex-col max-h-[70vh]">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelected((s) => Math.min(filtered.length - 1, s + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelected((s) => Math.max(0, s - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = filtered[selected];
            if (pick) commit(pick);
          }
        }}
        placeholder={loading ? 'Indexing…' : 'Find file'}
        className="w-full bg-transparent px-5 py-3 text-sm border-b border-card outline-none"
      />
      <div className="overflow-y-auto min-h-[240px]">
        {filtered.map((p, i) => (
          <button
            key={p}
            onClick={() => commit(p)}
            onMouseEnter={() => setSelected(i)}
            className={
              'w-full text-left px-5 py-1.5 text-xs font-mono ' +
              (i === selected ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:bg-card-strong')
            }
          >
            <div className="truncate">{relative(p, rootPath)}</div>
          </button>
        ))}
        {!loading && filtered.length === 0 && (
          <div className="px-5 py-3 text-xs text-ink-faint">No matches.</div>
        )}
      </div>
    </div>
  );
}

function relative(full: string, root: string): string {
  if (full.startsWith(root + '/')) return full.slice(root.length + 1);
  if (full.startsWith(root)) return full.slice(root.length);
  return full;
}

function rankMatches(files: string[], query: string, root: string): string[] {
  if (!query.trim()) return files.slice(0, 60);
  const q = query.toLowerCase();
  const scored: Array<[string, number]> = [];
  for (const f of files) {
    const rel = relative(f, root).toLowerCase();
    const name = rel.split('/').pop() ?? '';
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q)) score = 500 - name.length;
    else if (name.includes(q)) score = 300 - name.length;
    else if (rel.includes(q)) score = 100 - rel.length;
    else continue;
    scored.push([f, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.map((x) => x[0]);
}
