// Read-only overview drawer for a flow — opens on a row click so a person
// can see what a flow does (pipeline, tags, run history) before committing
// to the editor. `Edit flow` is the deliberate second click into it.

import { useEffect, useState } from 'react';

import { type Flow } from '@shared/flows/schema';
import { flowSpineSummary } from './flowSpine';
import { FlowPipelineDiagram } from './FlowPipelineDiagram';
import { FlowRunLauncher } from './FlowLaunch';
import { FlowDeployCard } from './FlowDeployCard';

export function FlowOverviewPanel({
  flow,
  usage,
  onClose,
  onEdit,
  onTagClick,
  projects = [],
}: {
  flow: Flow;
  usage?: { count: number; lastAt: number };
  onClose: () => void;
  onEdit: () => void;
  onTagClick?: (tag: string) => void;
  /// Where a deploy could write. Empty (the default) hides the deploy card
  /// rather than offering a button with nowhere to put its output.
  projects?: Array<{ name: string; path: string }>;
}) {
  const [running, setRunning] = useState(false);

  // Escape closes the drawer from anywhere — a `fixed` overlay with only a
  // `×` to dismiss it otherwise traps the keyboard.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    // `top-[38px]` clears the custom title bar (TitleBar.tsx's `h-[38px]`)
    // instead of covering it — `top-0` would sit the drawer over the window
    // controls and the schedule/usage indicators.
    <aside className="fixed top-[38px] right-0 bottom-0 z-40 w-[420px] border-l border-card bg-surface-elevated shadow-2xl overflow-y-auto p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="text-lg font-semibold flex-1 min-w-0 truncate">{flow.name}</div>
        <button
          onClick={onClose}
          aria-label="Close overview"
          className="text-ink-faint hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5"
        >
          ×
        </button>
      </div>
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">
        {flowSpineSummary(flow)}
      </div>
      {flow.description && <p className="text-sm text-ink-muted">{flow.description}</p>}
      {running ? (
        <FlowRunLauncher flow={flow} onClose={() => setRunning(false)} />
      ) : (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRunning(true)}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90"
          >
            Run
          </button>
          <button
            onClick={onEdit}
            className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
          >
            Edit flow
          </button>
        </div>
      )}
      <div className="text-[11px] uppercase tracking-wider text-ink-faint">Pipeline</div>
      <FlowPipelineDiagram flow={flow} />
      {flow.tags && flow.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {flow.tags.map((tag) => (
            <span
              key={tag}
              role={onTagClick ? 'button' : undefined}
              onClick={
                onTagClick
                  ? (e) => {
                      e.stopPropagation();
                      onTagClick(tag);
                    }
                  : undefined
              }
              title={onTagClick ? `Filter by "${tag}"` : undefined}
              className={
                'text-[10px] px-1.5 py-0.5 rounded-full border border-card text-ink-faint ' +
                (onTagClick ? 'cursor-pointer hover:text-ink hover:border-card-strong' : '')
              }
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="text-[11px] text-ink-faint">
        {usage ? `Run ${usage.count} time${usage.count === 1 ? '' : 's'}` : 'Never run'}
      </div>
      {projects.length > 0 && <FlowDeployCard flow={flow} projects={projects} />}
    </aside>
  );
}
