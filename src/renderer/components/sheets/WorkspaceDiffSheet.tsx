// Working-tree diff viewer for plain workspace conversations — no
// worktree, no agent members, just a workspace whose member projects are
// being edited on their local branches. Mirrors ProjectDiffSheet but adds
// a project picker so each project's `git diff HEAD` is reachable from
// one place. Non-git project folders are listed but flagged.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { FileDiff, fileBaseName, parseUnifiedDiffByFile } from '../../diff-utils';
import { UnifiedDiffBody } from './WorktreeDiffSheet';

interface ProjectDiffEntry {
  projectId: UUID;
  name: string;
  path: string;
  branch: string;
  isRepo: boolean;
  files: FileDiff[];
  loading: boolean;
}

export function WorkspaceDiffSheet({ convId }: { convId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const openSheet = useStore((s) => s.openSheet);

  const workspaceProjects = useMemo(() => {
    const ws = workspaces.find((w) => (w.conversations ?? []).some((c) => c.id === convId));
    if (!ws) return [];
    return ws.projectIds
      .map((pid) => projects.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
      .map((p) => ({ id: p.id, name: p.name, path: p.path }));
  }, [workspaces, projects, convId]);

  const [entries, setEntries] = useState<ProjectDiffEntry[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<UUID | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const reload = async () => {
    const results = await Promise.all(
      workspaceProjects.map(async (p): Promise<ProjectDiffEntry> => {
        // commitStatus probes for a repo without raising; if it isn't one,
        // skip the diff invocation entirely so the sidebar can flag it.
        const status = await window.overcli.invoke('git:commitStatus', { cwd: p.path });
        if (!status.isRepo) {
          return {
            projectId: p.id,
            name: p.name,
            path: p.path,
            branch: '',
            isRepo: false,
            files: [],
            loading: false,
          };
        }
        const [diff, head] = await Promise.all([
          window.overcli.invoke('git:run', { args: ['diff', 'HEAD'], cwd: p.path }),
          window.overcli.invoke('git:run', {
            args: ['rev-parse', '--abbrev-ref', 'HEAD'],
            cwd: p.path,
          }),
        ]);
        let text = diff.stdout;
        if (diff.exitCode !== 0 && !text) text = diff.stderr;
        return {
          projectId: p.id,
          name: p.name,
          path: p.path,
          branch: head.stdout.trim(),
          isRepo: true,
          files: parseUnifiedDiffByFile(text),
          loading: false,
        };
      }),
    );
    setEntries(results);
    setSelectedProjectId((current) => {
      if (current && results.some((r) => r.projectId === current)) return current;
      const firstWithChanges = results.find((r) => r.files.length > 0);
      return firstWithChanges?.projectId ?? results[0]?.projectId ?? null;
    });
  };

  useEffect(() => {
    setEntries(
      workspaceProjects.map((p) => ({
        projectId: p.id,
        name: p.name,
        path: p.path,
        branch: '',
        isRepo: true,
        files: [],
        loading: true,
      })),
    );
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, workspaceProjects.map((p) => p.id).join('|')]);

  const selectedEntry = entries.find((e) => e.projectId === selectedProjectId) ?? null;
  const selectedFileEntry = selectedEntry?.files.find((f) => f.path === selectedFile) ?? null;

  useEffect(() => {
    if (!selectedEntry) {
      setSelectedFile(null);
      return;
    }
    setSelectedFile((current) => {
      if (current && selectedEntry.files.some((f) => f.path === current)) return current;
      return selectedEntry.files[0]?.path ?? null;
    });
  }, [selectedEntry]);

  const totals = (selectedEntry?.files ?? []).reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );
  const anyLoading = entries.some((e) => e.loading);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <div className="flex flex-col min-w-0">
          <div className="text-sm font-medium truncate">Workspace working-tree diff</div>
          <div className="text-[11px] text-ink-faint truncate font-mono">
            {selectedEntry ? selectedEntry.path : `${entries.length} project${entries.length === 1 ? '' : 's'}`}
            {selectedEntry?.branch && <span className="ml-2">⎇ {selectedEntry.branch}</span>}
          </div>
        </div>
        <div className="flex-1" />
        <div className="text-[11px] font-mono">
          <span className="diff-add-ink">+{totals.added}</span>
          <span className="diff-remove-ink ml-2">−{totals.removed}</span>
        </div>
        <button
          onClick={() => void reload()}
          disabled={anyLoading}
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
        <div className="w-[220px] min-w-[200px] max-w-[280px] border-r border-white/5 flex flex-col">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint border-b border-white/5">
            Projects
          </div>
          <div className="overflow-y-auto">
            {entries.map((e) => {
              const t = e.files.reduce(
                (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
                { added: 0, removed: 0 },
              );
              return (
                <button
                  key={e.projectId}
                  onClick={() => setSelectedProjectId(e.projectId)}
                  className={
                    'w-full text-left px-3 py-2 border-b border-white/5 last:border-b-0 ' +
                    (selectedProjectId === e.projectId
                      ? 'bg-white/10 text-ink'
                      : 'text-ink-muted hover:bg-white/5 hover:text-ink')
                  }
                  title={e.path}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] truncate flex-1">{e.name}</span>
                    {e.isRepo && t.added > 0 && (
                      <span className="text-[10px] diff-add-ink">+{t.added}</span>
                    )}
                    {e.isRepo && t.removed > 0 && (
                      <span className="text-[10px] diff-remove-ink">−{t.removed}</span>
                    )}
                  </div>
                  <div className="text-[10px] text-ink-faint truncate">
                    {e.loading
                      ? 'Loading…'
                      : !e.isRepo
                        ? 'Not a git repo'
                        : e.files.length === 0
                          ? 'No changes'
                          : `${e.files.length} file${e.files.length === 1 ? '' : 's'}`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        <div className="w-[260px] min-w-[220px] max-w-[360px] border-r border-white/5 flex flex-col">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint border-b border-white/5">
            Files {selectedEntry ? `(${selectedEntry.files.length})` : ''}
          </div>
          <div className="flex-1 overflow-y-auto">
            {!selectedEntry ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">Select a project.</div>
            ) : selectedEntry.loading ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">Running git diff…</div>
            ) : !selectedEntry.isRepo ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">
                This project folder isn't a git repository.
              </div>
            ) : selectedEntry.files.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-ink-faint">
                No tracked changes vs HEAD.
              </div>
            ) : (
              selectedEntry.files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setSelectedFile(f.path)}
                  className={
                    'w-full text-left px-3 py-1.5 border-b border-white/5 last:border-b-0 ' +
                    (selectedFile === f.path
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
          {selectedFileEntry ? (
            <UnifiedDiffBody text={selectedFileEntry.body} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-ink-faint">
              {selectedEntry && !selectedEntry.isRepo
                ? 'Pick a git-backed project.'
                : 'Select a file.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
