import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { isEverydayProject } from '@shared/everydayProjects';

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
  // Nothing to come back to. The two doors are then the whole screen, and
  // they get room to explain themselves; with work already here they shrink
  // to a pair of buttons above it, because the recents are what you came for.
  const firstRun = total === 0;

  return (
    // Left-aligned, not centred: a scannable list wants a stable left edge,
    // and a centred column reflows every time the project count changes.
    <div className="flex-1 min-h-0 overflow-y-auto p-8">
      <div className="w-full max-w-[720px] flex flex-col gap-5">
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

        {/* The invitation. On a first run it says what an everyday project IS
            — the old copy named the feature and left the reader to guess what
            they'd get — and it carries both doors, because "point at a folder
            I already have" was a grey text link that read as a footnote. */}
        {firstRun ? (
          <div className="rounded-xl border border-dashed accent-invite px-7 py-7 flex flex-col gap-5">
            <div className="flex items-start gap-4">
              <span
                className="w-11 h-11 rounded-[11px] flex items-center justify-center shrink-0"
                style={{
                  background: 'color-mix(in srgb, var(--c-accent) 16%, transparent)',
                  color: 'var(--c-accent)',
                }}
              >
                <FolderGlyph size={22} />
              </span>
              <div className="min-w-0 flex flex-col gap-1.5">
                <div className="text-[17px] font-semibold text-ink tracking-[-0.01em]">
                  Somewhere to keep the work
                </div>
                <div className="text-[13px] text-ink-muted leading-relaxed max-w-[480px]">
                  An everyday project is a normal folder of documents — briefs, spreadsheets,
                  PDFs — that Overcli keeps a history of. Ask for a change and you get a new
                  version, never a lost file.
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2.5 pl-[60px]">
              <button
                onClick={() => openSheet({ type: 'newEverydayProject' })}
                className="accent-soft rounded-md border px-3.5 py-2 text-[13px] text-accent transition-colors"
              >
                Start an everyday project
              </button>
              <button
                onClick={pickProject}
                className="rounded-md border border-card bg-surface-elevated px-3.5 py-2 text-[13px] text-ink-muted hover:text-ink hover:bg-card-strong hover:border-card-strong transition-colors"
              >
                Point at a folder I already have
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={() => openSheet({ type: 'newEverydayProject' })}
              className="accent-soft rounded-md border px-3 py-1.5 text-xs text-accent transition-colors"
            >
              + New everyday project
            </button>
            <button
              onClick={pickProject}
              className="rounded-md border border-card bg-surface-elevated px-3 py-1.5 text-xs text-ink-muted hover:text-ink hover:bg-card-strong hover:border-card-strong transition-colors"
            >
              Add a folder
            </button>
          </div>
        )}

        {(recent.length > 0 || shownWorkspaces.length > 0) && (
          <div className="flex flex-col gap-2.5">
            <div className="text-xs text-ink-faint">
              {query.trim() ? 'Matching folders' : 'Or open something you already have here'}
            </div>
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
                      {isEverydayProject(p) ? 'Everyday project' : 'Code project'}
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
          </div>
        )}

        {/* A filter that matched nothing is not the same screen as a fresh
            install, and offering "start a project" as the answer to a typo
            would be answering a question nobody asked. */}
        {!firstRun && recent.length === 0 && shownWorkspaces.length === 0 && (
          <div className="text-xs text-ink-faint">Nothing here matches “{query.trim()}”.</div>
        )}

        {hiddenCount > 0 && !query.trim() && (
          <div className="text-[11px] text-ink-faint">
            {hiddenCount} more in the sidebar — or press <kbd className="text-ink">⌘K</kbd> to jump
            to one.
          </div>
        )}
      </div>
    </div>
  );
}

function FolderGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .78.37l.74.92h5.88a1 1 0 0 1 1 1v6.21a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z" strokeLinejoin="round" />
    </svg>
  );
}
