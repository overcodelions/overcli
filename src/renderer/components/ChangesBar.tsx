import { useState } from 'react';
import { useStore } from '../store';
import { PLAIN } from '@shared/plainLanguage';

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

/// Label for the branch chip in the bar's header. A worktree run shows its
/// own branch bare; the main checkout is prefixed `local/` so the two read
/// differently at a glance — the whole point of the chip is knowing whether
/// the changes below are landing in an isolated tree or in the checkout the
/// user has open in their editor. Returns null when there's no branch to
/// show: a detached HEAD, a non-repo, or a workspace whose members disagree.
export function branchLabel(
  branch: string | null | undefined,
  worktree: boolean,
): { label: string; title: string } | null {
  const name = (branch ?? '').trim();
  if (!name) return null;
  return worktree
    ? { label: name, title: `Worktree on branch ${name} — isolated from your main checkout` }
    : { label: `local/${name}`, title: `Your main checkout, on branch ${name}` };
}

/// Collapsible bar above the composer. Numbers come straight from a
/// `git diff --numstat` pass (plus line counts for untracked files). The
/// main chat feeds it `HEAD`-relative counts (`git:commitStatus`, matching
/// the header commit badge — see `refreshGitStatus`); flow worktree runs
/// feed it fork-point-relative counts (`git:worktreeChanges`) so it matches
/// the review sheet's diff.
export function ChangesBar({
  files,
  baseRef,
  branch,
  worktree = false,
  plain = false,
}: {
  files: FileChangeSummary[];
  /// Ref the counts were measured against, e.g. `origin/master`. When it's
  /// set we render an explicit empty state instead of hiding: a run whose
  /// work has landed upstream legitimately has zero files, and silently
  /// showing nothing reads as a broken probe.
  baseRef?: string | null;
  /// Branch the changes below belong to, and whether they live in a worktree
  /// rather than the project's main checkout. Rendered as a chip in the
  /// header so a run's tree is identifiable without opening the review sheet.
  branch?: string | null;
  worktree?: boolean;
  /// Speak in document terms rather than git terms. Passed per render, NOT
  /// read from settings: this is a property of the project you are looking
  /// at, and a global flag meant that trying one everyday project silently
  /// relabelled the changes bar in every repo the user owns.
  plain?: boolean;
}) {
  const openFile = useStore((s) => s.openFile);
  const [expanded, setExpanded] = useState(false);
  // Everyday projects don't speak git, so the chip stays out of plain mode.
  const branchChip = plain ? null : branchLabel(branch, worktree);
  if (files.length === 0) {
    if (!baseRef) return null;
    return (
      <div className="rounded-xl border border-card bg-card px-3 py-2 text-xs text-ink-faint flex items-center gap-2">
        <span>
          No changes vs <code className="text-ink">{baseRef}</code> — nothing left to merge.
        </span>
        {branchChip && <BranchChip {...branchChip} />}
      </div>
    );
  }
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
        {branchChip && <BranchChip {...branchChip} />}
        {baseRef && <span className="ml-auto text-ink-faint">vs {baseRef}</span>}
      </button>
      {expanded && (
        // Runs that touch dozens of files would otherwise push the composer
        // off-screen, so the list scrolls once it outgrows ~14 rows.
        <div className="border-t border-card max-h-[45vh] overflow-y-auto">
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
              {f.commitState && (() => {
                const badge = (plain ? PLAIN : COMMIT_STATE_BADGE)[f.commitState];
                return (
                  <span
                    title={badge.title}
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${COMMIT_STATE_BADGE[f.commitState].className}`}
                  >
                    {badge.label}
                  </span>
                );
              })()}
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

/// Branch chip shared by the bar's populated and empty states. Mono, muted,
/// and truncating — long branch names must not push the +/- counts around.
function BranchChip({ label, title }: { label: string; title: string }) {
  return (
    <span
      title={title}
      className="shrink min-w-0 truncate rounded bg-card-strong px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
    >
      ⎇ {label}
    </span>
  );
}
