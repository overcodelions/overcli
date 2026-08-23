import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { looksLikeEverydayProjectPath } from '@shared/everydayProjects';

/// What the explorer shows with nothing picked yet.
///
/// It used to say "Pick a project or workspace from the sidebar to explore."
/// — an instruction where an action should be, which is the same shape as the
/// `git init` dead-end this feature started by removing. An empty state that
/// names an action should contain that action.

/// Cards shown before the list stops being scannable. Past this it is a
/// filter's job, not a grid's.
const RECENT_LIMIT = 6;
const FILTER_THRESHOLD = 8;

export function ExplorerLanding() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const openExplorer = useStore((s) => s.openExplorer);
  const openSheet = useStore((s) => s.openSheet);
  const pickProject = useStore((s) => s.pickProject);

  const [query, setQuery] = useState('');
  const total = projects.length + workspaces.length;

  const match = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());

  // Most recently opened first: the folder you were last in is the one you
  // are most likely coming back to. Unfiltered, the list is capped — this is
  // a way back into recent work, not a project manager. The sidebar and ⌘K
  // are where you go to find one of fifty.
  const recent = useMemo(() => {
    const sorted = [...projects]
      .filter((p) => match(p.name))
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
    return query.trim() ? sorted : sorted.slice(0, RECENT_LIMIT);
  }, [projects, query]);

  const shownWorkspaces = workspaces.filter((w) => match(w.name));
  const hiddenCount = projects.length - recent.length;

  return (
    // Left-aligned, not centred: a scannable list wants a stable left edge,
    // and a centred column reflows every time the project count changes.
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <div className="w-full max-w-[720px] flex flex-col gap-4">
        <div className="flex items-end gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-lg font-semibold text-ink">Your files</div>
            <div className="text-xs text-ink-faint mt-0.5">
              Open a project to browse, edit and add documents.
            </div>
          </div>
          {/* Only worth a filter once the grid stops being scannable. Below
              that it is chrome asking to be ignored. */}
          {total > FILTER_THRESHOLD && (
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="field w-[180px] px-2.5 py-1 text-xs"
            />
          )}
        </div>

        {recent.length === 0 && shownWorkspaces.length === 0 ? (
          <div className="rounded-lg border accent-invite border-dashed px-4 py-6 text-center">
            <div className="text-sm font-medium text-ink">Nothing to explore yet</div>
            <div className="text-xs text-ink-muted leading-relaxed max-w-[380px] mx-auto mt-1">
              Start an everyday project and Overcli will make you a folder, or point it at one
              you already have.
            </div>
          </div>
        ) : (
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {recent.map((p) => (
              <button
                key={p.id}
                onClick={() => openExplorer(p.path)}
                className="rounded-lg border border-card bg-surface-elevated p-3 text-left hover:border-card-strong hover:bg-card-strong transition-colors flex items-center gap-2.5"
                style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
              >
                <span
                  className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
                  style={{
                    background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)',
                    color: 'var(--c-accent)',
                  }}
                >
                  <FolderGlyph />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-ink truncate">{p.name}</span>
                  <span className="block text-[11px] text-ink-faint truncate">
                    {looksLikeEverydayProjectPath(p.path) || p.everyday
                      ? 'Everyday project'
                      : 'Code project'}
                  </span>
                </span>
              </button>
            ))}
            {shownWorkspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => openExplorer(w.rootPath)}
                className="rounded-lg border border-card bg-surface-elevated p-3 text-left hover:border-card-strong hover:bg-card-strong transition-colors flex items-center gap-2.5"
                style={{ boxShadow: '0 1px 0 var(--c-card-border) inset' }}
              >
                <span className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 bg-card-strong text-ink-faint">
                  <FolderGlyph />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-ink truncate">{w.name}</span>
                  <span className="block text-[11px] text-ink-faint truncate">Workspace</span>
                </span>
              </button>
            ))}
          </div>
        )}

        {hiddenCount > 0 && !query.trim() && (
          <div className="text-[11px] text-ink-faint">
            {hiddenCount} more in the sidebar — or press <kbd className="text-ink">⌘K</kbd> to jump
            to one.
          </div>
        )}

        <div className="flex items-center gap-4 text-[11px]">
          <button
            onClick={() => openSheet({ type: 'newEverydayProject' })}
            className="text-accent hover:underline"
          >
            + New everyday project
          </button>
          <button onClick={pickProject} className="text-ink-faint hover:text-ink-muted">
            Add a folder
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v6.21a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}
