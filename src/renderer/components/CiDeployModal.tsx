// Deploying a flow or a worker to CI, with room to read what you are about to
// commit.
//
// This started as a card inside the 420px flow drawer, which was the wrong
// shape for the job twice over. A generated workflow is a 30-line YAML file
// that will run agents against your repository on someone else's machine —
// reading it in a `max-h-60` scroll box is not reading it. And the steps that
// follow are a real sequence with an order (choose, review, write, then create
// a secret and push), which a flat bulleted list flattens into a wall.
//
// So: a wide modal, the files in tabs at full height, and the sequence
// numbered. The layout is deliberately two-column — decisions on the left stay
// visible while you scroll the file on the right, because the file is a
// rendering of those decisions and checking one against the other is the whole
// point of previewing.
//
// Shared by the flow and worker paths. What differs between them is only the
// configuration, which each caller passes in as `configSlot`: a worker needs a
// target, a flow needs a target plus a project plus the prompt to launch with.

import { useEffect, useState, type ReactNode } from 'react';

export interface CiDeployPlanView {
  files: Array<{ path: string; contents: string }>;
  steps: string[];
  notes: string[];
  warnings: string[];
}

export interface CiDeployWriteResult {
  written: string[];
  overwritten: string[];
}

export function CiDeployModal({
  title,
  subtitle,
  configSlot,
  plan,
  written,
  busy,
  canPreview,
  onPreview,
  onWrite,
  onClose,
}: {
  title: string;
  subtitle: string;
  /// The caller's own inputs — target buttons, project picker, prompt box.
  /// Rendered under step 1 so the numbering reads as one sequence.
  configSlot: ReactNode;
  plan: CiDeployPlanView | null;
  written: CiDeployWriteResult | null;
  busy: boolean;
  /// False while the configuration is incomplete (a flow with no project
  /// chosen). Blocks step 2 rather than letting a preview fail.
  canPreview: boolean;
  onPreview: () => void;
  onWrite: () => void;
  onClose: () => void;
}) {
  const [activeFile, setActiveFile] = useState(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // A fresh preview can have fewer files than the last one did.
  useEffect(() => {
    if (plan && activeFile >= plan.files.length) setActiveFile(0);
  }, [plan, activeFile]);

  const file = plan?.files[activeFile];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[1100px] h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-card">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold truncate">{title}</div>
            <p className="mt-1 text-xs text-ink-muted">{subtitle}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-ink-faint hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5"
          >
            ×
          </button>
        </header>

        <div className="flex-1 min-h-0 flex">
          {/* Decisions. Scrolls independently of the file so a long checklist
              never pushes the target buttons out of reach. */}
          <div className="w-[360px] shrink-0 border-r border-card overflow-y-auto p-5 space-y-5">
            {/* Things that will break the job, before anything you can do
                about the job. Above step 1 on purpose: a blocker you read
                after picking a target is a blocker you read too late. */}
            {plan && plan.warnings.length > 0 && (
              <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="text-[11px] uppercase tracking-wider text-amber-400">Read this first</div>
                <ul className="mt-2 space-y-1.5">
                  {plan.warnings.map((w, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-amber-200/90">
                      {w}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <Step n={1} title="Set it up">
              {configSlot}
            </Step>

            <Step n={2} title="Review what gets written">
              <button
                onClick={onPreview}
                disabled={busy || !canPreview}
                className="rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-40"
              >
                {plan ? 'Refresh preview' : 'Preview'}
              </button>
              <p className="mt-2 text-[11px] text-ink-faint">
                {plan
                  ? `${plan.files.length} file${plan.files.length === 1 ? '' : 's'} — read them on the right.`
                  : 'Nothing is written until you have seen it.'}
              </p>
            </Step>

            <Step n={3} title="Write them into the project">
              <button
                onClick={onWrite}
                disabled={plan === null || busy || !canPreview}
                className="rounded-md border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                Write files
              </button>
              {written && (
                <div className="mt-2 text-[11px] text-ink-muted">
                  Wrote {written.written.length} file{written.written.length === 1 ? '' : 's'}.
                </div>
              )}
              {written && written.overwritten.length > 0 && (
                <div className="mt-1 text-[11px] text-amber-400">
                  Replaced your edited {written.overwritten.join(', ')} — those changes are not kept.
                </div>
              )}
            </Step>

            {plan && plan.steps.length > 0 && (
              <Step n={4} title="Then do these" dim={!written}>
                <ol className="space-y-2">
                  {plan.steps.map((c, i) => (
                    <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-ink-muted">
                      <span className="shrink-0 text-ink-faint tabular-nums">{i + 1}.</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ol>
              </Step>
            )}

            {/* Not steps. True and worth knowing, but nothing to perform —
                numbering them alongside the actions is what made the old
                single list unreadable. */}
            {plan && plan.notes.length > 0 && (
              <section>
                <div className="text-[11px] uppercase tracking-wider text-ink-faint">
                  Worth knowing
                </div>
                <ul className="mt-2 space-y-2">
                  {plan.notes.map((n, i) => (
                    <li key={i} className="text-[11px] leading-relaxed text-ink-faint">
                      {n}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* The files. */}
          <div className="flex-1 min-w-0 flex flex-col">
            {!plan ? (
              <div className="flex-1 grid place-items-center p-8 text-center">
                <p className="max-w-sm text-xs text-ink-faint">
                  Preview to see the files. Overcli writes them into your project; committing and
                  pushing is yours, so nothing reaches CI without you.
                </p>
              </div>
            ) : (
              <>
                <div className="flex gap-1 px-4 pt-3 border-b border-card overflow-x-auto">
                  {plan.files.map((f, i) => (
                    <button
                      key={f.path}
                      onClick={() => setActiveFile(i)}
                      title={f.path}
                      className={
                        'px-3 py-1.5 text-[11px] rounded-t-md border-b-2 whitespace-nowrap ' +
                        (i === activeFile
                          ? 'border-accent text-ink'
                          : 'border-transparent text-ink-faint hover:text-ink-muted')
                      }
                    >
                      {f.path.split('/').pop()}
                    </button>
                  ))}
                </div>
                <div className="px-4 py-1.5 text-[10px] text-ink-faint font-mono truncate border-b border-card">
                  {file?.path}
                </div>
                <pre className="flex-1 min-h-0 overflow-auto p-4 text-[11px] leading-relaxed font-mono text-ink-muted whitespace-pre">
                  {file?.contents}
                </pre>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/// One numbered step. `dim` greys a step that is not actionable yet — step 4
/// is a list of things to do AFTER writing, and showing it at full strength
/// before the files exist reads as "do this now".
function Step({
  n,
  title,
  dim,
  children,
}: {
  n: number;
  title: string;
  dim?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={dim ? 'opacity-60' : undefined}>
      <div className="flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-card-strong text-[10px] text-ink-faint tabular-nums">
          {n}
        </span>
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">{title}</div>
      </div>
      <div className="mt-2 pl-7">{children}</div>
    </section>
  );
}
