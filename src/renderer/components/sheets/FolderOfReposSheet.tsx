import { useState } from 'react';
import { useStore } from '../../store';
import { pathBasename } from '@shared/workspaceNames';
import { SheetActionButton } from './settingsChrome';

/// Shown when a picked folder holds several repos instead of being one.
/// This is where most people first meet workspaces, so it leads with the
/// question they already have ("these belong together?") and explains the
/// word in one line rather than asking them to learn it first.
export function FolderOfReposSheet({
  parentPath,
  repoPaths,
}: {
  parentPath: string;
  repoPaths: string[];
}) {
  const addFolderOfRepos = useStore((s) => s.addFolderOfRepos);
  const openSheet = useStore((s) => s.openSheet);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(repoPaths));
  const [busy, setBusy] = useState(false);

  const chosen = repoPaths.filter((p) => picked.has(p));
  const folderName = pathBasename(parentPath) || parentPath;

  const finish = async (as: 'workspace' | 'projects' | 'folder') => {
    if (busy) return;
    setBusy(true);
    try {
      await addFolderOfRepos(parentPath, chosen, as);
      openSheet(null);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (p: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(p);
    else next.delete(p);
    setPicked(next);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-xs text-ink-faint truncate">Adding {parentPath}</div>
          <div className="text-lg font-semibold mt-0.5">
            These {repoPaths.length} repos look like one system. Work on them together?
          </div>
          <div className="text-xs text-ink-muted mt-1">
            Together, they become a workspace: one conversation can read and change all of them,
            and you review the changes side by side. Each repo stays its own git repo.
          </div>
        </div>
        <div className="border border-card rounded">
          {repoPaths.map((p) => (
            <label
              key={p}
              className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-strong cursor-pointer border-b border-card last:border-b-0"
            >
              <input
                type="checkbox"
                checked={picked.has(p)}
                onChange={(e) => toggle(p, e.target.checked)}
                className="accent-accent"
              />
              <span className="font-mono">{pathBasename(p)}</span>
            </label>
          ))}
        </div>
        <button
          onClick={() => void finish('folder')}
          disabled={busy}
          className="self-start text-xs text-ink-faint hover:text-ink-muted underline-offset-2 hover:underline disabled:opacity-40"
        >
          Add {folderName} as a single folder instead
        </button>
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          label={chosen.length === 1 ? 'Add 1 project' : `Add as ${chosen.length} projects`}
          disabled={busy || chosen.length === 0}
          onClick={() => void finish('projects')}
        />
        <SheetActionButton
          primary
          label="Work on them together"
          disabled={busy || chosen.length < 2}
          onClick={() => void finish('workspace')}
        />
      </div>
    </div>
  );
}
