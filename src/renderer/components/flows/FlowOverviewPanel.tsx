// Read-only overview drawer for a flow — opens on a row click so a person
// can see what a flow does (pipeline, tags, run history) before committing
// to the editor. `Edit flow` is the deliberate second click into it.

import { useEffect, useState } from 'react';

import { type Flow } from '@shared/flows/schema';
import { flowSpineFacts } from './flowSpine';
import { FlowPipelineDiagram } from './FlowPipelineDiagram';
import { FlowRunLauncher } from './FlowLaunch';
import { FlowDeployCard, type DeployScope } from './FlowDeployCard';

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
  /// Where a deploy could run — projects and workspaces both. Empty (the
  /// default) hides the deploy card rather than offering a button with nowhere
  /// to put its output.
  projects?: DeployScope[];
}) {
  const [running, setRunning] = useState(false);
  const { steps, models, writes } = flowSpineFacts(flow);
  // Critic loops are drawn on the step they belong to, so the count is
  // left out of this line. The run count joins it instead: it is a fact
  // about the flow's scale, and beside the buttons it had nothing to
  // hold on to.
  const facts = [steps, models, usage ? `run ${usage.count} time${usage.count === 1 ? '' : 's'}` : 'never run'];

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
    <aside className="fixed top-[38px] right-0 bottom-0 z-40 w-[420px] border-l border-card bg-surface-elevated shadow-2xl flex flex-col">
      <div className="flex-1 overflow-y-auto px-5 pt-[22px] pb-6 flex flex-col gap-5">
      <div className="flex items-start gap-2">
        <h2 className="text-base font-semibold leading-snug flex-1 min-w-0">{flow.name}</h2>
        <button
          onClick={onClose}
          aria-label="Close overview"
          className="text-ink-muted hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5 flex-shrink-0"
        >
          ×
        </button>
      </div>
      {/* Scale and consequence. The write claim gets its own tinted chip:
          it is the one fact here that can cost the reader something, and
          as the tail of a grey micro-caps string nobody read it. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-xs text-ink-muted -mt-2.5">
        <span>{facts.join(' · ')}</span>
        <span
          className={
            'rounded-full border px-2.5 py-0.5 ' +
            (writes
              ? 'border-amber-400/40 bg-amber-500/10 text-amber-700 dark:text-amber-200'
              : 'border-card-strong text-ink-muted')
          }
        >
          {writes ? 'Edits your files' : 'Read-only'}
        </span>
      </div>
      {flow.description && (
        <p className="text-sm text-ink-muted leading-relaxed">{flow.description}</p>
      )}
      {running ? (
        <FlowRunLauncher flow={flow} onClose={() => setRunning(false)} />
      ) : (
        <div className="flex items-center gap-2.5">
          <button
            onClick={() => setRunning(true)}
            className="text-[13px] font-medium px-4 py-2 rounded-md bg-accent text-white hover:opacity-90"
          >
            Run
          </button>
          <button
            onClick={onEdit}
            className="text-[13px] px-4 py-2 rounded-md border border-card-strong hover:bg-white/5"
          >
            Edit flow
          </button>
        </div>
      )}
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h3 className="text-xs font-medium text-ink-muted">Pipeline</h3>
          {/* The one key the pipeline needs. Tiers name themselves; a
              ring colour cannot, and this one is a warning. */}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-ink-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-[9px] w-[9px] rounded-full border-[1.5px] border-amber-500/80 dark:border-amber-400/80" />
              changes your files
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-[9px] w-[9px] rounded-full border-[1.5px] border-[var(--c-ink-faint)]" />
              read-only
            </span>
          </span>
        </div>
        {/* Stacked, and without the diagram's own card and heading — at
            420px the wide layout wraps into a snake, and a second
            "Pipeline" under this one reads as a bug. */}
        <FlowPipelineDiagram flow={flow} layout="stack" chrome={false} />
      </section>
      {flow.tags && flow.tags.length > 0 && (
        <section className="flex flex-col gap-2.5">
          {/* The tags were two bare words with no stated job. Clicking one
              filters the library, so the heading says that, and they are
              real buttons when they can be clicked. */}
          <h3 className="text-xs font-medium text-ink-muted">
            {onTagClick ? 'Tagged — pick one to filter the library' : 'Tagged'}
          </h3>
          <div className="flex flex-wrap gap-2">
            {flow.tags.map((tag) =>
              onTagClick ? (
                <button
                  key={tag}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTagClick(tag);
                  }}
                  title={`Filter by "${tag}"`}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border border-card-strong bg-[var(--c-surface-muted)] text-ink hover:border-accent/50"
                >
                  <TagIcon />
                  {tag}
                </button>
              ) : (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full border border-card-strong bg-[var(--c-surface-muted)] text-ink-muted"
                >
                  <TagIcon />
                  {tag}
                </span>
              ),
            )}
          </div>
        </section>
      )}
      </div>
      {/* Outside the scroller on purpose: running this somewhere else is
          not the pipeline's last stage, so it reads as the drawer's floor
          rather than as another step. */}
      {projects.length > 0 && <FlowDeployCard flow={flow} projects={projects} />}
    </aside>
  );
}

function TagIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden className="flex-shrink-0 text-ink-muted">
      <path
        d="M7.2 1.5 H12.5 V6.8 L6.6 12.7 L1.3 7.4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="9.9" cy="4.1" r="1.1" fill="currentColor" />
    </svg>
  );
}
