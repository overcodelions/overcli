// Deploying a flow or a worker to CI.
//
// The job of this surface is narrow and worth stating, because it drove every
// choice below: let someone READ a generated pipeline file and understand its
// consequences before they commit it to their repository. Everything else is
// support for that.
//
// Which is why the file gets the room. The first version put it in a 420px
// drawer at `max-h-60`; the second gave it half a 1100px modal and it still
// clipped YAML mid-word. A file you cannot read is not a preview, it is a
// confirmation dialog wearing one. So the panel is as wide as the window
// sensibly allows and the file fills it.
//
// The vernacular here is code review — this is a diff you are approving before
// it lands — so the viewer borrows that language: a line-number gutter, and a
// badge per file saying whether it is new or replaces something you have
// already edited. The badge is the one piece of real work the decoration does:
// "replaces" is the only outcome on this screen that destroys anything.
//
// Everything else stays quiet. One filled button, the accent reserved for it
// and for progress; the rest is border and ink.

import { useEffect, useMemo, useState, type ReactNode } from 'react';

export interface CiDeployPlanView {
  files: Array<{ path: string; contents: string }>;
  steps: string[];
  notes: string[];
  warnings: string[];
  /// Standing context about the feature, not about this plan. Shown once,
  /// quietly, next to the Alpha flag it restates — see CiDeployPlan.
  toolNotice?: string;
  /// Set when writing into a project has no correct answer — a workspace
  /// worker, whose "project" is a symlink farm spanning several repos.
  block?: { reason: string; remedy: string } | null;
  /// Paths that already exist with different contents. Known at preview time
  /// so "you are about to replace your edit" is visible BEFORE the write, not
  /// reported after it.
  existing?: string[];
}

/// Alpha, and the reason is concrete rather than a disclaimer: the pipeline
/// files this generates invoke an `overcli` CLI that is not on npm yet, so a
/// job built from them fails at its setup step.
///
/// Blue, not amber, and that is the whole point of the colour. Amber already
/// means "this will bite you" here — it is the warning block three lines
/// below, and the `replaces` badge on a file about to be overwritten. A
/// maturity flag is not that: it is standing information about the feature,
/// true whether or not anything is wrong right now. Two meanings sharing one
/// colour is how a warning stops being read. Red would be worse again — it
/// reads as broken, and this works, it is just early. Green would say the
/// opposite of what is true.
export function AlphaBadge({ className = '' }: { className?: string }) {
  return (
    <span
      title="The overcli CLI these files call is not published yet, so a job built from them will not run end to end."
      className={
        'rounded-full border border-sky-400/40 bg-sky-400/15 px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.08em] text-sky-300 ' +
        className
      }
    >
      Alpha
    </span>
  );
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
  configSlot: ReactNode;
  plan: CiDeployPlanView | null;
  written: CiDeployWriteResult | null;
  busy: boolean;
  canPreview: boolean;
  onPreview: () => void;
  onWrite: () => void;
  onClose: () => void;
}) {
  const [activeFile, setActiveFile] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [savedTo, setSavedTo] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (plan && activeFile >= plan.files.length) setActiveFile(0);
  }, [plan, activeFile]);

  // Follow-up instructions are for after the write. A workspace deploy never
  // writes, so for that the follow-up is immediate.
  const revealFollowUp = Boolean(written) || Boolean(plan?.block);
  const file = plan?.files[activeFile];
  const lines = useMemo(() => (file ? file.contents.replace(/\n$/, '').split('\n') : []), [file]);
  const existing = useMemo(() => new Set(plan?.existing ?? []), [plan]);

  // Each step's own state, rather than one "current stage" counter.
  //
  // A counter got this wrong in both directions: it greyed step 3 while its
  // Write button was enabled, and it greyed step 4 at exactly the moment the
  // files landed and those instructions became the whole point. A step is
  // dimmed here only when it genuinely cannot be acted on yet.
  const stepState = (n: number): StepState => {
    if (n === 1) return 'active';
    if (n === 2) return plan ? 'done' : 'active';
    if (n === 3) return written ? 'done' : plan ? 'active' : 'todo';
    // With nowhere to write, the follow-up instructions are what the user acts
    // on next — waiting for a write that cannot happen would leave step 4
    // greyed out forever.
    return written || plan?.block ? 'active' : 'todo';
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-xl shadow-2xl border border-card-strong w-[min(1560px,95vw)] h-[92vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-start gap-4 px-6 py-4 border-b border-card shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight truncate">{title}</h2>
              <AlphaBadge className="shrink-0" />
            </div>
            <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
            {plan?.toolNotice && (
              <p className="mt-1.5 text-[11px] leading-[1.5] text-sky-300/70">{plan.toolNotice}</p>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 -mt-1 -mr-1 h-7 w-7 grid place-items-center rounded-md text-ink-faint hover:text-ink hover:bg-card focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            ×
          </button>
        </header>

        <div className="flex-1 min-h-0 flex">
          {/* Control rail. Recessed against the elevated panel so the file
              reads as the content and this reads as the frame around it. */}
          <div className="w-[380px] shrink-0 border-r border-card bg-surface overflow-y-auto">
            <div className="p-5 space-y-5">
              {plan && plan.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-3">
                  <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-amber-400/90">
                    About this {plan.warnings.length === 1 ? 'one' : 'flow'}
                  </div>
                  <ul className="mt-1.5 space-y-1.5">
                    {plan.warnings.map((w, i) => (
                      <li key={i} className="text-[11px] leading-[1.55] text-amber-200/80">
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <ol className="space-y-0">
                <Step n={1} title="Set it up" state={stepState(1)}>
                  {configSlot}
                </Step>

                <Step n={2} title="Read what gets written" state={stepState(2)}>
                  <button
                    onClick={onPreview}
                    disabled={busy || !canPreview}
                    className="rounded-md border border-card-strong bg-card px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink hover:border-card-strong disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    {busy ? 'Working…' : plan ? 'Refresh' : 'Show me the files'}
                  </button>
                  {plan && (
                    <p className="mt-2 text-[11px] leading-[1.5] text-ink-faint">
                      {plan.files.length} file{plan.files.length === 1 ? '' : 's'}, on the right.
                    </p>
                  )}
                </Step>

                <Step
                  n={3}
                  title={plan?.block ? 'Take them somewhere else' : 'Write them into the project'}
                  state={stepState(3)}
                >
                  {plan?.block ? (
                    <p className="mb-2 text-[11px] leading-[1.5] text-ink-muted">{plan.block.remedy}</p>
                  ) : (
                    <p className="mb-2 text-[11px] leading-[1.5] text-ink-faint">
                      Or copy them from the file pane — a Jenkins job set up outside a repo has no
                      project to write into.
                    </p>
                  )}
                  <button
                    onClick={onWrite}
                    disabled={plan === null || busy || !canPreview || Boolean(plan?.block)}
                    title={plan?.block?.reason}
                    className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-white hover:bg-accent-600 disabled:opacity-30 disabled:hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    Write files
                  </button>
                  {written && (
                    <p className="mt-2 text-[11px] leading-[1.5] text-ink-muted">
                      Wrote {written.written.length} file
                      {written.written.length === 1 ? '' : 's'}.
                      {written.overwritten.length > 0 && (
                        <span className="text-amber-400">
                          {' '}
                          Replaced your edits to {written.overwritten.join(', ')}.
                        </span>
                      )}
                    </p>
                  )}
                </Step>

                {/* Held back until the files exist, and this is the whole
                    reason the column reads calmly now. These instructions plus
                    the notes below were two thirds of the text in a 380px
                    rail, and none of them can be acted on before there is
                    something to commit — so they were asking to be read at the
                    one moment they could not be used. A workspace deploy is
                    the exception: there is no write, so they ARE the next
                    thing to do. */}
                <Step n={4} title="Then, outside Overcli" state={stepState(4)} last>
                  {revealFollowUp && plan ? (
                    <ol className="space-y-2">
                      {plan.steps.map((s, i) => (
                        <li
                          key={i}
                          className="grid grid-cols-[1.1rem_1fr] gap-x-1 text-[11px] leading-[1.55] text-ink-muted"
                        >
                          <span className="text-ink-faint tabular-nums">{i + 1}.</span>
                          <span>{s}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-[11px] leading-[1.5] text-ink-faint">
                      {plan
                        ? `${plan.steps.length} things to do once the files are written — secrets, commit, a first run.`
                        : 'Nothing yet.'}
                    </p>
                  )}
                </Step>
              </ol>

              {/* Not steps: true, worth saying, nothing to perform. Kept
                  visually distinct from the numbered list for exactly that
                  reason — numbering a fact makes it look like a task. */}
              {revealFollowUp && plan && plan.notes.length > 0 && (
                <div className="pt-1">
                  <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
                    Worth knowing
                  </div>
                  <ul className="mt-2 space-y-2">
                    {plan.notes.map((n, i) => (
                      <li
                        key={i}
                        className="border-l border-card pl-2.5 text-[11px] leading-[1.55] text-ink-faint"
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>

          {/* The file. */}
          <div className="flex-1 min-w-0 flex flex-col bg-surface-elevated">
            {!plan ? (
              <div className="flex-1 grid place-items-center p-10">
                <p className="max-w-xs text-center text-xs leading-relaxed text-ink-faint">
                  The files appear here before anything is written. Overcli puts them in your
                  project; committing and pushing stays yours.
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-stretch gap-px px-3 pt-2 border-b border-card overflow-x-auto shrink-0">
                  {plan.files.map((f, i) => (
                    <button
                      key={f.path}
                      onClick={() => setActiveFile(i)}
                      title={f.path}
                      className={
                        'group flex items-center gap-2 px-3 py-2 text-[11px] rounded-t-md border-b-2 whitespace-nowrap focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
                        (i === activeFile
                          ? 'border-accent text-ink bg-card/60'
                          : 'border-transparent text-ink-faint hover:text-ink-muted')
                      }
                    >
                      <span className="font-mono">{f.path.split('/').pop()}</span>
                      <FileBadge replaces={existing.has(f.path)} />
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 px-4 py-1.5 border-b border-card shrink-0">
                  <span className="font-mono text-[10px] text-ink-faint truncate">{file?.path}</span>
                  <span className="shrink-0 text-[10px] text-ink-faint tabular-nums">
                    {lines.length} lines
                  </span>
                  {/* Writing into the project is one exit, not the only one. A
                      workspace flow spans several repos and belongs to none of
                      them, and a Jenkins job is often configured outside a
                      repository entirely — those cases need the bytes, not a
                      path. */}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => {
                        if (!file) return;
                        void navigator.clipboard.writeText(file.contents);
                        setCopied(file.path);
                        window.setTimeout(() => setCopied(null), 1500);
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] text-ink-faint hover:text-ink hover:bg-card focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    >
                      {copied === file?.path ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      onClick={() => {
                        if (!file) return;
                        void window.overcli
                          .invoke('ci:saveFile', {
                            defaultName: file.path.split('/').pop() ?? 'overcli-ci',
                            contents: file.contents,
                          })
                          .then((res) => {
                            if (res.ok && res.filePath) setSavedTo(res.filePath);
                          });
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] text-ink-faint hover:text-ink hover:bg-card focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    >
                      Save as…
                    </button>
                  </div>
                </div>
                {savedTo && (
                  <div className="px-4 py-1 text-[10px] text-ink-faint truncate border-b border-card shrink-0">
                    Saved to {savedTo}
                  </div>
                )}

                {/* Line numbers because this is a file you are reviewing before
                    it lands, and that is the shape reviewing takes. They also
                    make "the cron is on line 6" a sayable thing. */}
                <div className="flex-1 min-h-0 overflow-auto font-mono text-[11.5px] leading-[1.65]">
                  <div className="flex min-w-full w-max">
                    <div
                      aria-hidden
                      className="sticky left-0 shrink-0 select-none border-r border-card bg-surface-elevated px-3 py-3 text-right text-ink-faint/60 tabular-nums"
                    >
                      {lines.map((_, i) => (
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>
                    <pre className="px-4 py-3 text-ink-muted whitespace-pre">
                      {lines.join('\n')}
                    </pre>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/// `new` or `replaces`. The only badge here, because replacing a file the user
/// has edited is the only thing this screen does that cannot be undone.
function FileBadge({ replaces }: { replaces: boolean }) {
  return (
    <span
      className={
        'rounded-full px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.06em] ' +
        (replaces
          ? 'bg-amber-500/15 text-amber-400/90'
          : 'bg-card text-ink-faint')
      }
    >
      {replaces ? 'replaces' : 'new'}
    </span>
  );
}

/// One step in a real sequence — create the secrets, commit, verify, stop the
/// local copy — where the order carries information the reader needs. The rail
/// connecting the markers says so; a plain list would not.
type StepState = 'todo' | 'active' | 'done';

function Step({
  n,
  title,
  state,
  last,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  last?: boolean;
  children: ReactNode;
}) {
  const done = state === 'done';
  const current = state === 'active';
  return (
    <li className="relative grid grid-cols-[1.5rem_1fr] gap-x-3">
      {!last && (
        <span
          aria-hidden
          className="absolute left-[0.6875rem] top-6 bottom-0 w-px bg-card-strong"
        />
      )}
      <span
        className={
          'relative z-10 mt-px grid h-[1.375rem] w-[1.375rem] place-items-center rounded-full border text-[10px] tabular-nums ' +
          (done
            ? 'border-accent/40 bg-accent/15 text-accent'
            : current
              ? 'border-accent bg-accent text-white'
              : 'border-card-strong bg-surface text-ink-faint')
        }
      >
        {done ? '✓' : n}
      </span>
      <div className={'pb-5 ' + (state === 'todo' ? 'opacity-50' : '')}>
        <div className="text-[12px] font-medium leading-[1.375rem] text-ink">{title}</div>
        <div className="mt-2">{children}</div>
      </div>
    </li>
  );
}
