import { useState } from 'react';
import { useStore } from '../store';

/// Per-file summary, shared shape with `git:commitStatus`. `status` is
/// the porcelain v1 code (e.g. ` M`, `??`, `A `); the two chars matter
/// for the left-column indicator.
export interface FileChangeSummary {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/// Collapsible bar above the composer. Numbers come straight from
/// `git diff HEAD --numstat` (plus line counts for untracked files) so
/// they match the header commit badge — see `refreshGitStatus` in the
/// store.
export function ChangesBar({ files }: { files: FileChangeSummary[] }) {
  const openFile = useStore((s) => s.openFile);
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const totals = files.reduce(
    (acc, f) => {
      acc.additions += Number(f.additions) || 0;
      acc.deletions += Number(f.deletions) || 0;
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
  return (
    <div className="rounded-xl border border-card bg-card text-xs overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-card-strong"
      >
        <span className="text-ink-faint">{expanded ? '▾' : '▸'}</span>
        <span className="text-ink font-medium">
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        <span className="text-green-400">+{totals.additions}</span>
        <span className="text-red-400">-{totals.deletions}</span>
      </button>
      {expanded && (
        <div className="border-t border-card">
          {files.map((f) => (
            <button
              key={f.path}
              onClick={() => openFile(f.path, undefined, 'diff')}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-card-strong border-t border-card first:border-t-0"
            >
              <span className="text-ink-faint text-[10px] font-mono w-6 shrink-0">
                {f.status.trim() || '??'}
              </span>
              <code className="text-ink flex-1 truncate">{f.path}</code>
              <span className="text-green-400 text-[11px]">+{Number(f.additions) || 0}</span>
              <span className="text-red-400 text-[11px]">-{Number(f.deletions) || 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
