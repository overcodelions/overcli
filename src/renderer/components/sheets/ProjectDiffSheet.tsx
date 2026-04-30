// Working-tree diff viewer for standard project conversations — no
// branch ops (merge / rebase / push / PR). Mirrors the WorktreeDiffSheet
// layout (file list + unified diff body) and reuses its UnifiedDiffBody,
// but runs against `git diff HEAD` in the conversation's owning project
// path so it works for plain convs that aren't bound to a worktree.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import {
  FileDiff,
  fileBaseName,
  findOwningProjectPath,
  parseUnifiedDiffByFile,
} from '../../diff-utils';
import { UnifiedDiffBody } from './WorktreeDiffSheet';
import { useConversation } from '../../hooks';

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

  const reload = async () => {
    if (!cwd) {
      setLoading(false);
      setFiles([]);
      return;
    }
    setLoading(true);
    // `git diff HEAD` rolls staged + unstaged tracked changes into one
    // view. Untracked files don't show up here — they're listed in the
    // commit popover via `git status --porcelain`, which is the right
    // place to grab them since "new files" don't have a meaningful
    // unified-diff body anyway.
    const [diff, head] = await Promise.all([
      window.overcli.invoke('git:run', { args: ['diff', 'HEAD'], cwd }),
      window.overcli.invoke('git:run', {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd,
      }),
    ]);
    let text = diff.stdout;
    if (diff.exitCode !== 0 && !text) text = diff.stderr;
    const parsed = parseUnifiedDiffByFile(text);
    setFiles(parsed);
    setBranch(head.stdout.trim());
    setLoading(false);
    setSelected((current) => {
      if (current && parsed.some((f) => f.path === current)) return current;
      return parsed[0]?.path ?? null;
    });
  };

  useEffect(() => {
    void reload();
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
          <div className="text-sm font-medium truncate">Working-tree diff</div>
          <div className="text-[11px] text-ink-faint truncate font-mono">
            {cwd ?? '(no project)'}
            {branch && <span className="ml-2">⎇ {branch}</span>}
          </div>
        </div>
        <div className="flex-1" />
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
                No tracked changes vs HEAD. (New / untracked files show in the commit popover.)
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
