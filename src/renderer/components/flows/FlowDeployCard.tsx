// Deploying a flow to CI, from the drawer you were already reading it in.
//
// The worker twin of this lives in WorkersPane.tsx. Kept as its own file
// because the flow case has an input the worker case does not — the prompt.
// A worker plans its own shift; a flow is a pipeline you hand an ask, so the
// job has to carry one, and the person deploying is the only one who knows
// what it should be.
//
// Preview-then-write, like the worker card and like ShareCard: you are about
// to commit a file that will run agents against this repo on someone else's
// machine, so you should read it first. Nothing is written until the second
// click.

import { useState } from 'react';

import { type Flow } from '@shared/flows/schema';
import { useFlowsStore } from '../../flowsStore';

type Target = 'github' | 'jenkins';

interface Plan {
  files: Array<{ path: string; contents: string }>;
  checklist: string[];
  warnings: string[];
}

/// Which project a flow belongs to, if it is possible to tell.
///
/// A project-sourced flow already lives in one — its `filePath` is under that
/// project's `.overcli/flows/`. A user-global flow belongs to none, and the
/// person deploying has to say where the pipeline file goes. Getting this
/// wrong writes a workflow into the wrong repository, so the card shows the
/// answer rather than assuming one.
export function homeProjectFor(flow: Flow, projects: Array<{ path: string }>): string | null {
  const match = projects
    .filter((p) => flow.filePath?.startsWith(p.path + '/'))
    // Longest wins, so a nested project beats the parent it sits inside.
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (match) return match.path;
  return projects.length === 1 ? projects[0].path : null;
}

export function FlowDeployCard({
  flow,
  projects,
}: {
  flow: Flow;
  projects: Array<{ name: string; path: string }>;
}) {
  const ciDeploy = useFlowsStore((s) => s.ciDeploy);
  const ciDeployWrite = useFlowsStore((s) => s.ciDeployWrite);

  const [projectPath, setProjectPath] = useState(() => homeProjectFor(flow, projects) ?? '');
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>('github');
  const [prompt, setPrompt] = useState(flow.defaultPrompt ?? '');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [written, setWritten] = useState<{ written: string[]; overwritten: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  // Any change to what the job would contain invalidates the preview. Writing
  // something the user never previewed is the one thing this shape exists to
  // prevent, so the Write button goes back to disabled rather than writing a
  // file that no longer matches what is on screen.
  function invalidate() {
    setPlan(null);
    setWritten(null);
  }

  const selected = 'rounded-md border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10';
  const unselected = 'rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink';

  return (
    <div className="rounded-xl border border-card-strong p-3">
      <div className="flex items-center gap-2">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint">Deploy to CI</div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="ml-auto text-[11px] text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
        >
          {open ? 'Hide' : 'Set up'}
        </button>
      </div>

      {!open ? (
        <p className="mt-2 text-xs text-ink-muted">
          Run this flow on GitHub Actions or Jenkins instead of here.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-muted">
            Writes the flow and a pipeline file into this project. Overcli writes them; you commit
            and push. The job runs with an allow-list — tools the flow asks for that are not on it
            are denied, because nobody is there to approve them.
          </p>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                setTarget('github');
                invalidate();
              }}
              className={target === 'github' ? selected : unselected}
            >
              GitHub Actions
            </button>
            <button
              onClick={() => {
                setTarget('jenkins');
                invalidate();
              }}
              className={target === 'jenkins' ? selected : unselected}
            >
              Jenkins
            </button>
          </div>

          {projects.length > 1 && (
            <label className="mt-3 block">
              <div className="text-[10px] uppercase tracking-wider text-ink-faint">Project</div>
              <select
                value={projectPath}
                onChange={(e) => {
                  setProjectPath(e.target.value);
                  invalidate();
                }}
                className="mt-1 w-full rounded-md border border-card bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:border-card-strong"
              >
                <option value="">Choose where the files go…</option>
                {projects.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="mt-3 block">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint">Prompt</div>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                invalidate();
              }}
              rows={2}
              placeholder="What this flow should work on when the job runs"
              className="mt-1 w-full rounded-md border border-card bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-card-strong"
            />
            <div className="mt-1 text-[10px] text-ink-faint">
              Becomes the job's default. On GitHub you can override it per run from the Actions tab.
            </div>
          </label>

          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              onClick={() => {
                setBusy(true);
                setWritten(null);
                void ciDeploy({ flowId: flow.id, target, projectPath, prompt })
                  .then(setPlan)
                  .finally(() => setBusy(false));
              }}
              disabled={busy || !projectPath}
              className={unselected + ' disabled:opacity-40'}
            >
              Preview
            </button>
            <button
              onClick={() => {
                setBusy(true);
                void ciDeployWrite({ flowId: flow.id, target, projectPath, prompt })
                  .then(setWritten)
                  .finally(() => setBusy(false));
              }}
              disabled={plan === null || busy || !projectPath}
              className={selected + ' disabled:opacity-40'}
            >
              Write files
            </button>
          </div>

          {!projectPath && (
            <div className="mt-2 text-[10px] text-amber-400">
              Pick the project these files belong in — a pipeline written into the wrong repository
              would run this flow against the wrong code.
            </div>
          )}

          {plan?.files.map((f) => (
            <div key={f.path} className="mt-2">
              <div className="text-[10px] text-ink-faint">{f.path}</div>
              <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-black/20 p-2 text-[10px] text-ink-muted whitespace-pre-wrap">
                {f.contents}
              </pre>
            </div>
          ))}

          {plan && plan.warnings.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {plan.warnings.map((w, i) => (
                <li key={i} className="text-[10px] text-amber-400">
                  {w}
                </li>
              ))}
            </ul>
          )}

          {plan && plan.checklist.length > 0 && (
            <div className="mt-2">
              <div className="text-[10px] uppercase tracking-wider text-ink-faint">
                Before this runs
              </div>
              <ul className="mt-1 space-y-0.5">
                {plan.checklist.map((c, i) => (
                  <li key={i} className="text-[10px] text-ink-faint">
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {written && (
            <div className="mt-2 text-[10px] text-ink-faint">
              Wrote {written.written.join(', ')} into {projectPath}
            </div>
          )}
          {written && written.overwritten.length > 0 && (
            <div className="mt-1 text-[10px] text-amber-400">
              Replaced your edited {written.overwritten.join(', ')} — those changes are not kept.
            </div>
          )}
        </>
      )}
    </div>
  );
}
