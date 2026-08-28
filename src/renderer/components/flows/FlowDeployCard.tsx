// Deploying a flow to CI. The button lives in the overview drawer; the work
// happens in a modal, because the drawer is 420px wide and the thing you most
// need to do here is READ a generated file before committing it.
//
// The worker twin is in ../workers/WorkerDeployCard.tsx. Both drive the same
// CiDeployModal; what differs is the configuration, and that difference is the
// point — a worker plans its own shift, so it needs nothing but a target,
// while a flow is a pipeline you hand an ask, so it needs the prompt and the
// project the pipeline file belongs in.

import { useState } from 'react';

import { type Flow } from '@shared/flows/schema';
import { useFlowsStore } from '../../flowsStore';
import {
  AlphaBadge,
  CiDeployModal,
  type CiDeployPlanView,
  type CiDeployWriteResult,
} from '../CiDeployModal';

type Target = 'github' | 'jenkins';

/// Which project a flow belongs to, if it is possible to tell.
///
/// A project-sourced flow already lives in one — its `filePath` is under that
/// project's `.overcli/flows/`. A user-global flow belongs to none, and the
/// person deploying has to say where the pipeline file goes. Getting this
/// wrong writes a workflow into the wrong repository, so the modal asks rather
/// than assuming.
export function homeProjectFor(flow: Flow, projects: Array<{ path: string }>): string | null {
  const match = projects
    .filter((p) => flow.filePath?.startsWith(p.path + '/'))
    // Longest wins, so a nested project beats the parent it sits inside.
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (match) return match.path;
  return projects.length === 1 ? projects[0].path : null;
}

/// One place a flow's CI job can cover: a project, or a whole workspace.
///
/// A workspace is the more interesting target and the reason this is not just
/// a project list. A flow is stateless, so "read across every repo in unifyr
/// and report" is exactly the shape a runner suits — the job checks the
/// members out side by side and the run's cwd is the directory holding them.
export interface DeployScope {
  name: string;
  path: string;
  kind: 'project' | 'workspace';
  /// Member count, for a workspace. Shown so the choice is legible.
  members?: number;
}

export function FlowDeployCard({
  flow,
  projects,
}: {
  flow: Flow;
  projects: DeployScope[];
}) {
  const ciDeploy = useFlowsStore((s) => s.ciDeploy);
  const ciDeployWrite = useFlowsStore((s) => s.ciDeployWrite);

  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Target>('github');
  const [projectPath, setProjectPath] = useState(() => homeProjectFor(flow, projects) ?? '');
  const [prompt, setPrompt] = useState(flow.defaultPrompt ?? '');
  const [plan, setPlan] = useState<CiDeployPlanView | null>(null);
  const [written, setWritten] = useState<CiDeployWriteResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Any change to what the job would contain invalidates the preview. Writing
  // something the user never saw is the one thing this shape exists to
  // prevent, so Write goes back to disabled rather than writing a file that no
  // longer matches what is on screen.
  function invalidate() {
    setPlan(null);
    setWritten(null);
  }

  const selected = 'rounded-md border border-accent/50 px-2.5 py-1 text-[11px] text-accent hover:bg-accent/10';
  const unselected = 'rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink';

  return (
    <>
      <div className="rounded-xl border border-card-strong p-3">
        <div className="flex items-center gap-2">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint">Deploy to CI</div>
          <AlphaBadge />
          <button
            onClick={() => setOpen(true)}
            className="ml-auto text-[11px] text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 rounded"
          >
            Set up…
          </button>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Run this flow on GitHub Actions or Jenkins instead of here.
        </p>
      </div>

      {open && (
        <CiDeployModal
          title={`Deploy ${flow.name} to CI`}
          subtitle="Writes the flow and a pipeline file into your project. Overcli writes them; committing and pushing is yours."
          canPreview={Boolean(projectPath)}
          plan={plan}
          written={written}
          busy={busy}
          onClose={() => setOpen(false)}
          onPreview={() => {
            setBusy(true);
            setWritten(null);
            void ciDeploy({ flowId: flow.id, target, projectPath, prompt })
              .then(setPlan)
              .finally(() => setBusy(false));
          }}
          onWrite={() => {
            setBusy(true);
            void ciDeployWrite({ flowId: flow.id, target, projectPath, prompt })
              .then(setWritten)
              .finally(() => setBusy(false));
          }}
          configSlot={
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
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
                <label className="block">
                  <div className="text-[10px] uppercase tracking-wider text-ink-faint">Runs across</div>
                  <select
                    value={projectPath}
                    onChange={(e) => {
                      setProjectPath(e.target.value);
                      invalidate();
                    }}
                    className="mt-1 w-full rounded-md border border-card bg-surface px-2 py-1 text-xs text-ink focus:outline-none focus:border-card-strong"
                  >
                    <option value="">Choose where the job runs…</option>
                    {projects.map((p) => (
                      <option key={p.path} value={p.path}>
                        {p.kind === 'workspace'
                          ? `${p.name} (workspace, ${p.members ?? 0} repos)`
                          : p.name}
                      </option>
                    ))}
                  </select>
                  {!projectPath && (
                    <div className="mt-1 text-[10px] text-amber-400">
                      Pick one — the wrong repo runs this against the wrong code.
                    </div>
                  )}
                </label>
              )}

              <label className="block">
                <div className="text-[10px] uppercase tracking-wider text-ink-faint">Prompt</div>
                <textarea
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    invalidate();
                  }}
                  rows={3}
                  placeholder="What this flow should work on when the job runs"
                  className="mt-1 w-full rounded-md border border-card bg-surface px-2 py-1 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-card-strong"
                />
                <div className="mt-1 text-[10px] text-ink-faint">
                  The job's default; overridable per run.
                </div>
              </label>
            </div>
          }
        />
      )}
    </>
  );
}
