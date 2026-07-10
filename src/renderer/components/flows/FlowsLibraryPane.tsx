// Top-level flows pane. Library list + (in Phase 3) the editor + (in
// Phase 4) the run pane. For Phase 2 this is a list view with create /
// edit / delete; Run is wired in Phase 4 when the runtime can execute
// the steps.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { flowRunOwnerPath, resolveStepModel, flowStarKey, type Flow } from '@shared/flows/schema';
import { deleteFlowRunWithDirtyGuard } from './deleteRun';
import { FlowEditor } from './FlowEditor';
import { FlowRunPane } from './FlowRunPane';
import { NewFlowPicker } from './NewFlowPicker';
import { BrowseLibraryModal } from './BrowseLibraryModal';
import { FlowMonogram } from './FlowMonogram';
import { RunPanel } from './FlowLaunch';
import { FlowsAboutContent, FlowsAboutModal } from './FlowsAbout';
import type { FlowRun } from '@shared/flows/schema';
import type { Attachment } from '@shared/types';

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
  const [browseOpen, setBrowseOpen] = useState(false);
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
      useFlowsStore.getState().applyRunsBulk(runs);
    });
  }, []);

  // Key on the run id so switching flows mounts a fresh FlowRunPane
  // instead of reusing the instance — otherwise per-run local state
  // (focusStepId / autoFollowedId) carries over. A step manually picked
  // in the previous flow would stay selected, and since that step id
  // doesn't exist in the new flow, nothing highlights and the body
  // falsely reads "no participants".
  if (activeRunId) return <FlowRunPane key={activeRunId} runId={activeRunId} />;
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
        <button
          onClick={() => setBrowseOpen(true)}
          className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
        >
          Browse library
        </button>
      </div>

      {justSaved && (
        <div
          onClick={dismissJustSaved}
          className="flex items-center gap-2 mb-4 text-sm text-emerald-700 dark:text-emerald-200 bg-emerald-500/15 border border-emerald-400/40 rounded px-3 py-2 cursor-pointer"
        >
          <span>✓</span>
          <span>Saved <span className="font-semibold">{justSaved.name}</span>.</span>
          <span className="ml-auto text-[11px] text-emerald-700 dark:text-emerald-200/70">dismiss</span>
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
      {browseOpen && <BrowseLibraryModal onClose={() => setBrowseOpen(false)} />}
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
    (r) =>
      r.state.kind === 'running' ||
      r.state.kind === 'paused' ||
      // A watching run is an ongoing commitment (it's polling), so it belongs
      // with the active set, not buried in recent.
      r.state.kind === 'watching',
  );
  const recent = sorted.filter(
    (r) =>
      r.state.kind === 'done' || r.state.kind === 'aborted' || r.state.kind === 'archived',
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
              <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
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
                <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
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
        : run.state.kind === 'watching'
          ? 'watching'
          : run.state.kind === 'done'
            ? 'done'
            : run.state.kind === 'archived'
              ? 'archived'
              : 'aborted';
  const stateColor =
    run.state.kind === 'running'
      ? 'text-sky-700 dark:text-sky-300'
      : run.state.kind === 'paused'
        ? 'text-amber-700 dark:text-amber-300'
        : run.state.kind === 'watching'
          ? 'text-sky-700 dark:text-sky-300'
          : run.state.kind === 'done'
            ? 'text-emerald-700 dark:text-emerald-300/80'
            : run.state.kind === 'archived'
              ? 'text-ink-muted'
              : 'text-red-700 dark:text-red-300';
  const isActive =
    run.state.kind === 'running' ||
    run.state.kind === 'paused' ||
    run.state.kind === 'watching';
  // Latest attempt end-time → "completed at". Falls back to the run's
  // createdAt for runs with no completed attempts yet.
  const lastEnd = run.attempts
    .map((a) => a.endedAt)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => b - a)[0];
  const completedAt =
    run.state.kind === 'done' || run.state.kind === 'aborted' || run.state.kind === 'archived'
      ? lastEnd ?? run.createdAt
      : null;

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const res = await deleteFlowRunWithDirtyGuard(run.id);
    if (res.error) {
      // Server failed but the optimistic remove already happened — re-add isn't
      // worth the complexity; the next listRuns refresh would restore it. Just
      // surface the error.
      alert(`Couldn't delete: ${res.error}`);
      return;
    }
    if (res.deleted) removeRun(run.id);
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
        <span className="text-sm font-semibold truncate" title={run.userPrompt}>{runTitle(run)}</span>
        <span className="text-[11px] text-ink-faint truncate">
          {run.flowSnapshot.name}
          <span className="mx-1">·</span>
          {projectLabel ?? pathBasenameSafe(flowRunOwnerPath(run))}
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
      className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 dark:bg-sky-400 animate-pulse mr-1.5 align-middle"
    />
  );
}

/// Title for a run row: first non-empty line of the user prompt so runs
/// of the same flow are distinguishable; falls back to the flow name.
function runTitle(run: FlowRun): string {
  const firstLine = run.userPrompt
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine || run.flowSnapshot.name;
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
  const [running, setRunning] = useState(false);
  const starred = useStore(
    (s) => (s.settings.starredFlows ?? []).includes(flowStarKey(flow)),
  );
  const toggleFlowStar = useStore((s) => s.toggleFlowStar);

  // Picking "Run" swaps the row's contents for the shared run panel
  // (Composer + target/worktree controls) in place — no cramped popover,
  // no vertical jump. Mirrors the start page's flow launcher.
  if (running) {
    return <FlowRunLauncher flow={flow} onClose={() => setRunning(false)} />;
  }

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
    } else {
      alert(result.error);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openEditor({ kind: 'editing', flowId: flow.id })}
      onKeyDown={(e) => {
        // Only the card itself opens the editor on Enter/Space — a keypress
        // while an inner button (Run / ⋯) is focused must not also edit.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openEditor({ kind: 'editing', flowId: flow.id });
        }
      }}
      title="Click to edit this flow"
      className="group rounded-lg border border-card bg-card/30 p-4 cursor-pointer transition hover:border-accent hover:bg-accent/[0.08] hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="text-base font-semibold truncate transition-colors group-hover:text-accent">
              {flow.name}
            </div>
            <SourceBadge source={flow.source} />
            <span className="text-[11px] font-medium text-accent opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
              ✎ Edit
            </span>
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
        {/* The whole card is click-to-edit; this action cluster stops
            propagation so Run / ⋯ don't also trip the edit. Delete still
            lives behind the ⋯ menu so the row isn't a wall of buttons. */}
        <div
          className="flex items-center gap-2 flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => void toggleFlowStar({ source: flow.source, id: flow.id })}
            className={
              'text-base leading-none px-2 py-1 rounded-md hover:bg-card-strong ' +
              (starred ? 'text-amber-400' : 'text-ink-faint hover:text-amber-400')
            }
            title={starred ? 'Unstar' : 'Star to pin to the welcome pane'}
            aria-label={starred ? 'Unstar flow' : 'Star flow'}
          >
            {starred ? '★' : '☆'}
          </button>
          <button
            onClick={() => setRunning(true)}
            className="text-xs px-3 py-1 rounded-md bg-accent text-white hover:opacity-90"
          >
            Run
          </button>
          <RowActionsMenu
            onEdit={() => openEditor({ kind: 'editing', flowId: flow.id })}
            onDelete={handleDelete}
          />
        </div>
      </div>
    </div>
  );
}

/// Overflow menu for a flow row — holds the secondary Edit/Delete actions
/// so they don't each claim a permanent button. Delete confirms inline
/// inside the menu rather than firing a modal.
function RowActionsMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs px-2.5 py-1 rounded-md bg-card hover:bg-card-strong text-ink-muted leading-none"
        title="More actions"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-10 min-w-[130px] bg-surface border border-card-strong rounded-md shadow-lg py-1">
          <button
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            Edit
          </button>
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-red-400"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1 px-3 py-1.5">
              <button
                onClick={() => {
                  void onDelete();
                  setOpen(false);
                  setConfirming(false);
                }}
                className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-[11px] px-2 py-0.5 rounded bg-card"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Run launcher for a flow row. Owns the target (project/workspace)
/// selection + worktree controls and drives the shared `RunPanel`. The
/// target picker rides in the panel footer because — unlike the start
/// page — the Flows library isn't scoped to a single context.
function FlowRunLauncher({ flow, onClose }: { flow: Flow; onClose: () => void }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const applyRunUpdate = useFlowsStore((s) => s.applyRunUpdate);
  const setLaunchProgress = useFlowsStore((s) => s.setLaunchProgress);
  const launchProgressMap = useFlowsStore((s) => s.launchProgress);
  const setDraft = useStore((s) => s.setDraft);
  const clearAttachments = useStore((s) => s.clearAttachments);

  /// `target` is `project:<path>` | `workspace:<rootPath>` | ''.
  const [target, setTarget] = useState('');
  const [runIn, setRunIn] = useState<'cwd' | 'worktree'>('cwd');
  // Empty → BaseBranchSelect auto-detects the repo's default branch.
  const [baseBranch, setBaseBranch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const targetPath = stripTargetPrefix(target);
  const targetIsWorkspace = target.startsWith('workspace:');
  const canUseWorktree = !!targetPath;
  const draftKey = `__flow-launch:${flow.id}__`;

  // Repos the worktree(s) are minted from. Workspace → each member's
  // path (so the branch list is the intersection); single project → one.
  const baseBranchRepoPaths = useMemo(() => {
    if (targetIsWorkspace) {
      const ws = workspaces.find((w) => w.rootPath === targetPath);
      return ws
        ? ws.projectIds
            .map((pid) => projects.find((p) => p.id === pid))
            .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
            .map((p) => p.path)
        : [];
    }
    return targetPath ? [targetPath] : [];
  }, [target, targetPath, targetIsWorkspace, projects, workspaces]);

  const targetLabel = useMemo(() => {
    if (!targetPath) return 'Pick a target';
    if (targetIsWorkspace) {
      return workspaces.find((w) => w.rootPath === targetPath)?.name ?? targetPath;
    }
    return projects.find((p) => p.path === targetPath)?.name ?? targetPath;
  }, [target, targetPath, targetIsWorkspace, projects, workspaces]);

  async function handleRun(prompt: string, attachments: Attachment[]) {
    const text = prompt.trim();
    if (!targetPath || !text) {
      setError('Pick a project or workspace, and tell the flow what to work on.');
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.overcli.invoke('flows:startRun', {
        flowId: flow.id,
        projectPath: targetPath,
        userPrompt: text,
        attachments: attachments.length > 0 ? attachments : undefined,
        runIn: canUseWorktree ? runIn : 'cwd',
        baseBranch: canUseWorktree && runIn === 'worktree' ? baseBranch : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const run = await window.overcli.invoke('flows:getRun', { runId: result.runId });
      if (run) applyRunUpdate(run);
      setDraft(draftKey, '');
      clearAttachments(draftKey);
      setActiveRun(result.runId);
    } finally {
      setSubmitting(false);
      setLaunchProgress(targetPath, null);
    }
  }

  const targetControl = (
    <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className="text-ink-faint">in</span>
      <select
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
          // A workspace can't run a worktree until we know its members;
          // safe to leave runIn — canUseWorktree gates the controls.
        }}
        className="bg-card border border-card-strong rounded px-1.5 py-0.5 text-[11px] text-ink max-w-[160px]"
      >
        <option value="">Pick a target…</option>
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
    </div>
  );

  return (
    <RunPanel
      flow={flow}
      targetLabel={targetLabel}
      targetControl={targetControl}
      draftKey={draftKey}
      rootPath={targetPath}
      error={error}
      submitting={submitting}
      onCancel={onClose}
      onRun={handleRun}
      canUseWorktree={canUseWorktree}
      isWorkspace={targetIsWorkspace}
      runIn={runIn}
      onRunIn={setRunIn}
      baseBranch={baseBranch}
      onBaseBranch={setBaseBranch}
      baseBranchRepoPaths={baseBranchRepoPaths}
      launchProgress={launchProgressMap[targetPath]}
    />
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
      ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
      : 'bg-sky-500/20 text-sky-700 dark:text-sky-300';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider ${cls}`}>
      {source}
    </span>
  );
}
