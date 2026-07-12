import { useState } from 'react';
import { useStore } from '../store';

/// Per-file summary, shared shape with `git:commitStatus`. `status` is
/// the porcelain v1 code (e.g. ` M`, `??`, `A `); the two chars matter
/// for the left-column indicator. `commitState` flags whether the change
/// is already committed on the branch (vs the fork point), still an
/// uncommitted working-tree edit, or both — see `FileChange` in `git.ts`.
/// Optional so older/other status payloads still render.
export type CommitState = 'committed' | 'uncommitted' | 'both';
export interface FileChangeSummary {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  commitState?: CommitState;
}

const COMMIT_STATE_BADGE: Record<CommitState, { label: string; title: string; className: string }> = {
  committed: {
    label: 'committed',
    title: 'Committed on this branch (differs from the fork point)',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200',
  },
  uncommitted: {
    label: 'uncommitted',
    title: 'Uncommitted working-tree change — not in any commit yet',
    className: 'bg-amber-500/15 text-amber-700 dark:text-amber-200',
  },
  both: {
    label: 'committed · edits',
    title: 'Committed on this branch, with further uncommitted edits on top',
    className: 'bg-sky-500/15 text-sky-700 dark:text-sky-200',
  },
};

/// Porcelain v1 puts the index code first and the worktree code second, so a
/// deletion shows up as `D `, ` D` or `AD` depending on what's staged. Any `D`
/// in either column means the file is gone from disk — clicking it can only
/// ever show the diff, never file contents.
/// `DU`/`UD` are merge-conflict states, not deletions — the file is still
/// there with conflict markers, so they're excluded.
function isDeletedStatus(status: string): boolean {
  const code = status.trim();
  return code.includes('D') && !code.includes('U');
}

/// Collapsible bar above the composer. Numbers come straight from a
/// `git diff --numstat` pass (plus line counts for untracked files). The
/// main chat feeds it `HEAD`-relative counts (`git:commitStatus`, matching
/// the header commit badge — see `refreshGitStatus`); flow worktree runs
/// feed it fork-point-relative counts (`git:worktreeChanges`) so it matches
/// the review sheet's diff.
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
        <span className="diff-add-ink">+{totals.additions}</span>
        <span className="diff-remove-ink">-{totals.deletions}</span>
      </button>
      {expanded && (
        <div className="border-t border-card">
          {files.map((f) => {
            const deleted = isDeletedStatus(f.status);
            return (
            <button
              key={f.path}
              onClick={() => openFile(f.path, undefined, 'diff')}
              title={deleted ? 'File deleted — opens the diff of what it contained' : f.path}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-card-strong border-t border-card first:border-t-0"
            >
              <span className="text-ink-faint text-[10px] font-mono w-6 shrink-0">
                {f.status.trim() || '??'}
              </span>
              <code
                className={
                  'flex-1 truncate ' +
                  (deleted ? 'text-ink-faint line-through decoration-ink-faint/60' : 'text-ink')
                }
              >
                {f.path}
              </code>
              {f.commitState && (
                <span
                  title={COMMIT_STATE_BADGE[f.commitState].title}
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${COMMIT_STATE_BADGE[f.commitState].className}`}
                >
                  {COMMIT_STATE_BADGE[f.commitState].label}
                </span>
              )}
              <span className="diff-add-ink text-[11px]">+{Number(f.additions) || 0}</span>
              <span className="diff-remove-ink text-[11px]">-{Number(f.deletions) || 0}</span>
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
