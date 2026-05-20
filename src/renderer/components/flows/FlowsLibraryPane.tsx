// Top-level flows pane. Library list + (in Phase 3) the editor + (in
// Phase 4) the run pane. For Phase 2 this is a list view with create /
// edit / delete; Run is wired in Phase 4 when the runtime can execute
// the steps.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { resolveStepModel, type Flow } from '@shared/flows/schema';
import { FlowEditor } from './FlowEditor';
import { FlowRunPane } from './FlowRunPane';
import { NewFlowPicker } from './NewFlowPicker';
import { FlowMonogram } from './FlowMonogram';
import { FlowsAboutContent, FlowsAboutModal } from './FlowsAbout';
import type { FlowRun } from '@shared/flows/schema';

export function FlowsLibraryPane() {
  const projects = useStore((s) => s.projects);
  const flows = useFlowsStore((s) => s.flows);
  const loaded = useFlowsStore((s) => s.loaded);
  const reload = useFlowsStore((s) => s.reload);
  const editor = useFlowsStore((s) => s.editor);
  const openEditor = useFlowsStore((s) => s.openEditor);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const justSaved = useFlowsStore((s) => s.justSaved);
  const dismissJustSaved = useFlowsStore((s) => s.dismissJustSaved);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  // Auto-dismiss the "Saved" banner after 3 seconds.
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(dismissJustSaved, 3000);
    return () => clearTimeout(t);
  }, [justSaved?.at]);

  const projectPaths = useMemo(() => projects.map((p) => p.path), [projects]);

  useEffect(() => {
    void reload(projectPaths);
    // re-run when project list changes so newly added projects' .overcli/flows show up
  }, [projectPaths.join('|')]);

  // Seed persisted runs from disk on first mount so the Active + Recent
  // sections light up immediately after an app restart instead of only
  // showing runs started this session.
  useEffect(() => {
    void window.overcli.invoke('flows:listRuns').then((runs) => {
      const apply = useFlowsStore.getState().applyRunUpdate;
      for (const r of runs) apply(r);
    });
  }, []);

  if (activeRunId) return <FlowRunPane runId={activeRunId} />;
  if (editor.kind !== 'idle') return <FlowEditor />;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="text-2xl font-semibold">Flows</div>
        <div className="text-xs text-ink-faint">Multi-model pipelines</div>
        <button
          onClick={() => setAboutOpen(true)}
          className="text-xs text-ink-faint hover:text-ink ml-auto hover:bg-white/5 px-2 py-1 rounded"
          title="What is a flow?"
        >
          About
        </button>
        <button
          onClick={() => void reload(projectPaths)}
          className="text-xs text-ink-faint hover:text-ink hover:bg-white/5 px-2 py-1 rounded"
        >
          ↻ Refresh
        </button>
        <button
          onClick={() => setPickerOpen(true)}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90"
        >
          + New flow
        </button>
      </div>

      {justSaved && (
        <div
          onClick={dismissJustSaved}
          className="flex items-center gap-2 mb-4 text-sm text-emerald-200 bg-emerald-500/15 border border-emerald-400/40 rounded px-3 py-2 cursor-pointer"
        >
          <span>✓</span>
          <span>Saved <span className="font-semibold">{justSaved.name}</span>.</span>
          <span className="ml-auto text-[11px] text-emerald-200/70">dismiss</span>
        </div>
      )}

      <RunsOverview />

      {!loaded ? (
        <div className="text-sm text-ink-muted">Loading flows…</div>
      ) : flows.length === 0 ? (
        <EmptyState onCreate={() => setPickerOpen(true)} />
      ) : (
        <>
          <SectionHeading title="Your flows" count={flows.length} />
          <div className="space-y-3">
            {flows.map((flow) => (
              <FlowRow key={`${flow.source}:${flow.id}`} flow={flow} projectPaths={projectPaths} />
            ))}
          </div>
        </>
      )}

      {pickerOpen && <NewFlowPicker onClose={() => setPickerOpen(false)} />}
      {aboutOpen && <FlowsAboutModal onClose={() => setAboutOpen(false)} />}
    </div>
  );
}

/// Active + recent runs surfaced at the top of the library. Renders as
/// rows (not grid cards) so timestamps + project + actions fit cleanly
/// on each line and the layout reads top-to-bottom like a log.
function RunsOverview() {
  const runs = useFlowsStore((s) => s.runs);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const sorted = useMemo(
    () => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  );
  const active = sorted.filter(
    (r) => r.state.kind === 'running' || r.state.kind === 'paused',
  );
  const recent = sorted.filter(
    (r) => r.state.kind === 'done' || r.state.kind === 'aborted',
  );
  const [showRecent, setShowRecent] = useState(false);

  // Resolve project / workspace display names for the run rows. Cheap
  // map by path; falls back to the path basename if no match.
  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  if (active.length === 0 && recent.length === 0) return null;

  return (
    <div className="mb-6">
      {active.length > 0 && (
        <>
          <SectionHeading title="Active" count={active.length} accent />
          <div className="space-y-1.5 mb-4">
            {active.map((run) => (
              <RunRow key={run.id} run={run} projectLabel={nameForPath.get(run.projectPath)} />
            ))}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <>
          <button
            onClick={() => setShowRecent((v) => !v)}
            className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink mb-2"
          >
            <span>{showRecent ? '▼' : '▶'}</span>
            <span>Recent</span>
            <span className="text-ink-faint normal-case tracking-normal">
              · {recent.length}
            </span>
          </button>
          {showRecent && (
            <div className="space-y-1.5 mb-4">
              {recent.slice(0, 15).map((run) => (
                <RunRow key={run.id} run={run} projectLabel={nameForPath.get(run.projectPath)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RunRow({ run, projectLabel }: { run: FlowRun; projectLabel?: string }) {
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const removeRun = useFlowsStore((s) => s.removeRun);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const stateLabel =
    run.state.kind === 'running'
      ? 'running…'
      : run.state.kind === 'paused'
        ? 'paused'
        : run.state.kind === 'done'
          ? 'done'
          : 'aborted';
  const stateColor =
    run.state.kind === 'running'
      ? 'text-sky-300'
      : run.state.kind === 'paused'
        ? 'text-amber-300'
        : run.state.kind === 'done'
          ? 'text-emerald-300/80'
          : 'text-red-300';
  const isActive = run.state.kind === 'running' || run.state.kind === 'paused';
  // Latest attempt end-time → "completed at". Falls back to the run's
  // createdAt for runs with no completed attempts yet.
  const lastEnd = run.attempts
    .map((a) => a.endedAt)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => b - a)[0];
  const completedAt = run.state.kind === 'done' || run.state.kind === 'aborted'
    ? lastEnd ?? run.createdAt
    : null;

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const result = await window.overcli.invoke('flows:deleteRun', { runId: run.id });
    if (!result.ok) {
      // Server failed but the optimistic remove already happened — re-add isn't
      // worth the complexity; the next listRuns refresh would restore it. Just
      // surface the error.
      alert(`Couldn't delete: ${result.error}`);
      return;
    }
    removeRun(run.id);
  }

  return (
    <div
      className={
        'group flex items-center gap-3 rounded-md border px-3 py-2 cursor-pointer transition ' +
        (isActive
          ? 'border-accent/40 bg-card/40 hover:bg-card/60'
          : 'border-card bg-card/20 hover:bg-card/40')
      }
      onClick={() => setActiveRun(run.id)}
    >
      <FlowMonogram name={run.flowSnapshot.name} size="sm" />
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-sm font-semibold truncate">{run.flowSnapshot.name}</span>
        <span className="text-[11px] text-ink-faint truncate">
          {projectLabel ?? pathBasenameSafe(run.projectPath)}
          {run.worktreePath && <span className="ml-1">· worktree</span>}
        </span>
      </div>
      <span className={'text-[11px] font-medium ' + stateColor + ' flex items-center gap-1.5'}>
        {run.state.kind === 'running' && <RunningDot />}
        {stateLabel}
      </span>
      <span
        className="text-[11px] text-ink-faint w-28 text-right"
        title={new Date(completedAt ?? run.createdAt).toLocaleString()}
      >
        {completedAt
          ? `done ${relativeTime(completedAt)}`
          : `started ${relativeTime(run.createdAt)}`}
      </span>
      {confirmingDelete ? (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleDelete}
            className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
          >
            Confirm
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(false);
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-card"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
          className="text-[11px] text-ink-faint hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded hover:bg-card-strong"
          title="Delete this run"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/// Short "5m ago" / "2h ago" / "3d ago" relative timestamp. Beyond a
/// week we fall back to a date string so the user gets a real anchor.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function RunningDot() {
  return (
    <span
      aria-hidden
      className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse mr-1.5 align-middle"
    />
  );
}

function pathBasenameSafe(p: string): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? p;
}

function SectionHeading({
  title,
  count,
  accent,
}: {
  title: string;
  count?: number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span
        className={
          'text-[11px] uppercase tracking-wider ' +
          (accent ? 'text-accent' : 'text-ink-faint')
        }
      >
        {title}
      </span>
      {typeof count === 'number' && (
        <span className="text-[11px] text-ink-faint">· {count}</span>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  // No flows yet → use the empty-state card as the "About flows" page
  // itself. The About modal in the header has the exact same content,
  // but a first-time user shouldn't have to know to click it.
  return (
    <div className="rounded-xl border border-card bg-card/30 p-6 shadow-sm">
      <div className="flex items-baseline gap-3 mb-5">
        <div className="text-lg font-semibold">Flows orchestrate multiple models</div>
        <div className="text-xs text-ink-faint">— here's what you get</div>
      </div>
      <FlowsAboutContent compact />
      <div className="mt-6 pt-4 border-t border-card flex items-center gap-3">
        <button
          onClick={onCreate}
          className="text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 font-medium"
        >
          + Create your first flow
        </button>
        <span className="text-[11px] text-ink-faint">
          Start from a template or describe one — Claude can draft it.
        </span>
      </div>
    </div>
  );
}

function FlowRow({ flow, projectPaths }: { flow: Flow; projectPaths: string[] }) {
  const openEditor = useFlowsStore((s) => s.openEditor);
  const reload = useFlowsStore((s) => s.reload);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleDelete() {
    const projectPath = flow.source === 'project'
      ? flow.filePath.replace(/\/\.overcli\/flows\/.+$/, '')
      : undefined;
    const result = await window.overcli.invoke('flows:delete', {
      flowId: flow.id,
      source: flow.source,
      projectPath,
    });
    if (result.ok) {
      await reload(projectPaths);
      setConfirmingDelete(false);
    } else {
      alert(result.error);
    }
  }

  return (
    <div className="rounded-lg border border-card bg-card/30 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-base font-semibold truncate">{flow.name}</div>
            <SourceBadge source={flow.source} />
          </div>
          {flow.description && (
            <div className="text-sm text-ink-muted line-clamp-2 mb-2">{flow.description}</div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {flow.steps.map((step) => {
              const m = resolveStepModel(flow, step);
              return (
                <StepChip
                  key={step.id}
                  id={step.id}
                  model={`${m.backend}:${m.model}`}
                />
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-2 flex-shrink-0">
          <RunButton flow={flow} />
          <button
            onClick={() => openEditor({ kind: 'editing', flowId: flow.id })}
            className="text-xs px-3 py-1 rounded-md bg-card hover:bg-card-strong"
          >
            Edit
          </button>
          {!confirmingDelete ? (
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-xs px-3 py-1 rounded-md text-ink-muted hover:text-red-400 hover:bg-card-strong"
            >
              Delete
            </button>
          ) : (
            <div className="flex gap-1">
              <button
                onClick={handleDelete}
                className="text-xs px-2 py-1 rounded-md bg-red-500/80 text-white"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="text-xs px-2 py-1 rounded-md bg-card"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunButton({ flow }: { flow: Flow }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const applyRunUpdate = useFlowsStore((s) => s.applyRunUpdate);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  /// `target` stores a string of the form `project:<path>` or `workspace:<rootPath>`.
  /// On submit, we strip the prefix and pass the bare path to startRun.
  const [target, setTarget] = useState<string>('');
  const [runIn, setRunIn] = useState<'cwd' | 'worktree'>('cwd');
  const [baseBranch, setBaseBranch] = useState('main');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Worktree only makes sense for plain projects (not workspaces — those
  // are symlink trees). Force back to cwd when target is a workspace.
  const targetIsWorkspace = target.startsWith('workspace:');
  useEffect(() => {
    if (targetIsWorkspace && runIn === 'worktree') setRunIn('cwd');
  }, [targetIsWorkspace]);

  async function handleRun() {
    const path = stripTargetPrefix(target);
    if (!path || !prompt.trim()) {
      setError('Pick a target and enter a prompt.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await window.overcli.invoke('flows:startRun', {
        flowId: flow.id,
        projectPath: path,
        userPrompt: prompt,
        runIn,
        baseBranch: runIn === 'worktree' ? baseBranch : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const run = await window.overcli.invoke('flows:getRun', { runId: result.runId });
      if (run) applyRunUpdate(run);
      setActiveRun(result.runId);
      setPickerOpen(false);
    } finally {
      setSubmitting(false);
    }
  }

  if (!pickerOpen) {
    return (
      <button
        onClick={() => setPickerOpen(true)}
        className="text-xs px-3 py-1 rounded-md bg-accent text-white hover:opacity-90"
      >
        Run
      </button>
    );
  }

  return (
    <div className="absolute right-4 mt-8 z-10 bg-surface border border-card rounded-md shadow-lg p-3 w-72">
      <div className="text-xs font-semibold mb-2">Run “{flow.name}”</div>
      <label className="block text-[11px] text-ink-muted mb-1">Run in</label>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full mb-2 bg-card border border-card-strong rounded px-2 py-1 text-xs"
      >
        <option value="">Pick a project or workspace…</option>
        {projects.length > 0 && (
          <optgroup label="Projects">
            {projects.map((p) => (
              <option key={`p:${p.id}`} value={`project:${p.path}`}>{p.name}</option>
            ))}
          </optgroup>
        )}
        {workspaces.length > 0 && (
          <optgroup label="Workspaces">
            {workspaces.map((w) => (
              <option key={`w:${w.id}`} value={`workspace:${w.rootPath}`}>{w.name}</option>
            ))}
          </optgroup>
        )}
      </select>
      <label className="block text-[11px] text-ink-muted mb-1">Where the files live</label>
      <div className="grid grid-cols-2 gap-1 mb-2">
        <button
          onClick={() => setRunIn('cwd')}
          className={
            'text-[11px] px-2 py-1 rounded border ' +
            (runIn === 'cwd'
              ? 'border-accent bg-accent/20 text-ink'
              : 'border-card-strong bg-card text-ink-muted hover:bg-card-strong')
          }
        >
          In project
        </button>
        <button
          onClick={() => setRunIn('worktree')}
          disabled={targetIsWorkspace}
          title={targetIsWorkspace ? 'Worktrees aren\'t supported for workspaces yet.' : ''}
          className={
            'text-[11px] px-2 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed ' +
            (runIn === 'worktree'
              ? 'border-accent bg-accent/20 text-ink'
              : 'border-card-strong bg-card text-ink-muted hover:bg-card-strong')
          }
        >
          New worktree
        </button>
      </div>
      {runIn === 'worktree' && (
        <div className="mb-2">
          <label className="block text-[11px] text-ink-muted mb-1">Base branch</label>
          <input
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="main"
            className="w-full bg-card border border-card-strong rounded px-2 py-1 text-xs font-mono"
          />
        </div>
      )}
      <label className="block text-[11px] text-ink-muted mb-1">Prompt</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="e.g. PROJ-123 or describe the task"
        className="w-full mb-2 bg-card border border-card-strong rounded px-2 py-1 text-xs"
      />
      {error && (
        <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2 mb-2 whitespace-pre-wrap">
          {error}
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button
          onClick={() => setPickerOpen(false)}
          className="text-xs px-2 py-1 rounded bg-card"
        >
          Cancel
        </button>
        <button
          onClick={handleRun}
          disabled={submitting}
          className="text-xs px-3 py-1 rounded bg-accent text-white disabled:opacity-50"
        >
          {submitting ? 'Starting…' : 'Run'}
        </button>
      </div>
    </div>
  );
}

function stripTargetPrefix(target: string): string {
  if (target.startsWith('project:')) return target.slice('project:'.length);
  if (target.startsWith('workspace:')) return target.slice('workspace:'.length);
  return '';
}

function StepChip({ id, model }: { id: string; model: string }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-ink-muted">
      {id} <span className="text-ink-faint">·</span> {model}
    </span>
  );
}

function SourceBadge({ source }: { source: 'user' | 'project' }) {
  const cls =
    source === 'project'
      ? 'bg-emerald-500/20 text-emerald-300'
      : 'bg-sky-500/20 text-sky-300';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider ${cls}`}>
      {source}
    </span>
  );
}
