// Working-tree diff viewer for standard project conversations — no
// branch ops (merge / rebase / push / PR). Mirrors the WorktreeDiffSheet
// layout (file list + unified diff body) and reuses its UnifiedDiffBody,
// but runs in the conversation's owning project path so it works for plain
// convs that aren't bound to a worktree.
//
// Two views. "Uncommitted" is `git diff HEAD`. When the project is on a
// branch other than the repo's default, "Branch" diffs from the fork point
// with that default: the branch's commits plus anything uncommitted, which
// is what a branch checked out from a flow or agent actually contains.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import {
  FileDiff,
  fileBaseName,
  findOwningProjectPath,
  parseUnifiedDiffByFile,
  resolveDefaultBranch,
} from '../../diff-utils';
import { UnifiedDiffBody } from './WorktreeDiffSheet';
import { useConversation } from '../../hooks';

type DiffMode = 'branch' | 'working';

async function git(args: string[], cwd: string) {
  return window.overcli.invoke('git:run', { args, cwd });
}


export function ProjectDiffSheet({ convId }: { convId: UUID }) {
  const projects = useStore((s) => s.projects);
  const conv = useConversation(convId);
  const openSheet = useStore((s) => s.openSheet);

  const cwd = useMemo(
    () => conv?.worktreePath ?? findOwningProjectPath(projects, convId) ?? null,
    [conv, projects, convId],
  );

  const [files, setFiles] = useState<FileDiff[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [branch, setBranch] = useState<string>('');
  // Null until known, and stays null on the default branch itself (or a
  // detached HEAD), where only the uncommitted view means anything.
  const [base, setBase] = useState<string | null>(null);
  const [mode, setMode] = useState<DiffMode | null>(null);

  const reload = async (requested: DiffMode | null = mode) => {
    if (!cwd) {
      setLoading(false);
      setFiles([]);
      return;
    }
    setLoading(true);
    const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const headName = head.exitCode === 0 ? head.stdout.trim() : '';
    const defaultBranch = await resolveDefaultBranch((args) => git(args, cwd));
    const onFeatureBranch =
      !!headName && headName !== 'HEAD' && !!defaultBranch && headName !== defaultBranch;
    // First open lands on Branch when there is one: committed work is
    // usually the point, and the uncommitted view is often empty.
    const effective: DiffMode = onFeatureBranch ? (requested ?? 'branch') : 'working';

    // Both views are "diff the working tree against a commit", so staged,
    // unstaged and (in Branch) committed changes all land in one view.
    // Untracked files don't show up here — they're listed in the commit
    // popover via `git status --porcelain`, which is the right place to
    // grab them since "new files" don't have a meaningful unified-diff body
    // anyway.
    let against = 'HEAD';
    if (effective === 'branch' && defaultBranch) {
      const mb = await git(['merge-base', defaultBranch, 'HEAD'], cwd);
      if (mb.exitCode === 0 && mb.stdout.trim()) against = mb.stdout.trim();
    }
    const diff = await git(['diff', against], cwd);
    let text = diff.stdout;
    if (diff.exitCode !== 0 && !text) text = diff.stderr;
    const parsed = parseUnifiedDiffByFile(text);
    setFiles(parsed);
    setBranch(headName);
    setBase(onFeatureBranch ? defaultBranch : null);
    setMode(effective);
    setLoading(false);
    setSelected((current) => {
      if (current && parsed.some((f) => f.path === current)) return current;
      return parsed[0]?.path ?? null;
    });
  };

  useEffect(() => {
    void reload(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, cwd]);

  if (!conv) return null;

  const totals = files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );
  const selectedFile = files.find((f) => f.path === selected) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div className="flex flex-col min-w-0">
          <div className="text-sm font-medium truncate">
            {mode === 'branch' && base ? `${branch} vs ${base}` : 'Working-tree diff'}
          </div>
          <div className="text-[11px] text-ink-faint truncate font-mono">
            {cwd ?? '(no project)'}
            {branch && <span className="ml-2">⎇ {branch}</span>}
          </div>
        </div>
        <div className="flex-1" />
        {base && (
          <div className="flex items-center rounded bg-white/5 p-0.5">
            {(['branch', 'working'] as const).map((m) => (
              <button
                key={m}
                onClick={() => void reload(m)}
                disabled={loading}
                title={
                  m === 'branch'
                    ? `Everything on ${branch} since it left ${base}, committed or not`
                    : 'Only changes not yet committed'
                }
                className={
                  'text-xs px-2 py-0.5 rounded disabled:opacity-50 ' +
                  (mode === m ? 'bg-white/10 text-ink' : 'text-ink-muted hover:text-ink')
                }
              >
                {m === 'branch' ? 'Branch' : 'Uncommitted'}
              </button>
            ))}
          </div>
        )}
        <div className="text-[11px] font-mono">
          <span className="diff-add-ink">+{totals.added}</span>
          <span className="diff-remove-ink ml-2">−{totals.removed}</span>
        </div>
        <button
          onClick={() => void reload()}
          disabled={loading}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5 disabled:opacity-50"
        >
          Refresh
        </button>
        <button
          onClick={() => openSheet(null)}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5"
        >
          Close
        </button>
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[260px] min-w-[220px] max-w-[360px] border-r border-white/5 flex flex-col">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint border-b border-white/5">
            Files ({files.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && files.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">Running git diff…</div>
            ) : files.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">
                {mode === 'branch' && base
                  ? `No tracked changes vs ${base}.`
                  : 'No tracked changes vs HEAD.'}{' '}
                (New / untracked files show in the commit popover.)
              </div>
            ) : (
              files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setSelected(f.path)}
                  className={
                    'w-full text-left px-3 py-1.5 border-b border-white/5 last:border-b-0 ' +
                    (selected === f.path
                      ? 'bg-white/10 text-ink'
                      : 'text-ink-muted hover:bg-white/5 hover:text-ink')
                  }
                  title={f.path}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] truncate flex-1">{fileBaseName(f.path)}</span>
                    {f.added > 0 && <span className="text-[10px] diff-add-ink">+{f.added}</span>}
                    {f.removed > 0 && (
                      <span className="text-[10px] diff-remove-ink">−{f.removed}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-faint truncate">{f.path}</div>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 overflow-auto">
          {selectedFile ? (
            <UnifiedDiffBody text={selectedFile.body} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-ink-faint">
              Select a file.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
