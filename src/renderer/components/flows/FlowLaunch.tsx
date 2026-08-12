// Shared flow-launch UI, extracted from WelcomePane so the Flows library
// page and the start page render identical cards + run panels. Nothing
// here owns state — callers pass the flow, the draft key, and the
// target/worktree controls so each host stays in charge of where a run
// lands.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Attachment } from '@shared/types';
import type { Flow, FlowStep } from '@shared/flows/schema';
import { compactStepModel, flowSpineSummary, ROLE_VERB, stepWrites } from './flowSpine';
import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { flowStarKey } from '@shared/flows/schema';
import { Composer } from '../Composer';
import { BaseBranchSelect } from '../sheets/BaseBranchSelect';
import { FlowMonogram } from './FlowMonogram';

/// Expanded run panel — replaces the card grid in the same vertical slot
/// so picking a flow doesn't push other content down.
export function RunPanel({
  flow,
  targetLabel,
  targetControl,
  draftKey,
  rootPath,
  error,
  submitting,
  onCancel,
  onRun,
  canUseWorktree,
  isWorkspace = false,
  runIn,
  onRunIn,
  baseBranch,
  onBaseBranch,
  baseBranchRepoPaths,
  launchProgress,
  isDraft = false,
}: {
  flow: Flow;
  /// Static "in <name>" label, shown when no `targetControl` is given.
  targetLabel: string;
  /// Optional interactive target control (e.g. a project/workspace
  /// picker) rendered in the footer in place of the static label. Hosts
  /// that are already scoped to one context (the start page) omit it.
  targetControl?: ReactNode;
  /// Store key the Composer reads/writes its draft + attachments under.
  draftKey: string;
  /// Project/workspace root, for @-mention file lookup in the Composer.
  rootPath: string;
  error: string | null;
  submitting: boolean;
  onCancel: () => void;
  onRun: (prompt: string, attachments: Attachment[]) => void;
  canUseWorktree: boolean;
  /// True when the target is a workspace (multiple member repos). Switches
  /// the base-branch control to "each repo's default + shared override".
  isWorkspace?: boolean;
  runIn: 'cwd' | 'worktree';
  onRunIn: (v: 'cwd' | 'worktree') => void;
  baseBranch: string;
  onBaseBranch: (s: string) => void;
  /// Repos the worktree(s) will be minted from. Single project →
  /// `[projectPath]`; workspace → each member's path. Passed straight
  /// through to `BaseBranchSelect`, which lists the branch names that
  /// exist in EVERY listed repo (intersection) so a workspace flow
  /// can't pick a branch that one member doesn't have.
  baseBranchRepoPaths: string[];
  /// Live worktree-preparation beat while `submitting`, shown in place of the
  /// generic "Starting…" so a multi-second (or multi-repo) checkout reads as
  /// progress rather than a hang. Absent on `cwd` launches (no worktree work).
  launchProgress?: { completed: number; total: number; message: string } | null;
  /// This flow only exists in memory — an AI drafted it and it's saved on
  /// launch. Adds the draft badge and the full step breakdown.
  isDraft?: boolean;
}) {
  // Seed the composer with the flow's defaultPrompt the first time this
  // panel is opened for a given draftKey. Reads the store snapshot once
  // (no subscription) so user typing isn't fought by re-runs of this
  // effect, and only writes when the slot is empty — clearing back to ""
  // is a valid user action we must not overwrite.
  const setDraft = useStore((s) => s.setDraft);
  useEffect(() => {
    if (!flow.defaultPrompt) return;
    const existing = useStore.getState().conversationDrafts[draftKey];
    if (existing && existing.length > 0) return;
    setDraft(draftKey, flow.defaultPrompt);
  }, [draftKey, flow.defaultPrompt, setDraft]);

  return (
    <div
      className={
        // Solid card background — `bg-surface-elevated/60` + backdrop-blur
        // was flashing white in Electron's renderer before the CSS vars
        // settled on the first paint. Sticking to known-good tokens
        // (matching the sheet host's pattern) avoids the flicker.
        'relative rounded-2xl bg-surface-elevated ' +
        'shadow-[0_20px_60px_-20px_rgba(0,0,0,0.55),0_2px_0_0_rgba(255,255,255,0.04)_inset] ' +
        'ring-1 ring-card-strong overflow-hidden'
      }
    >
      <div className="relative p-5">
        {/* Header — monogram + title + steps, close on the right. No
            divider line; spacing alone separates from the input. */}
        <div className={'flex items-start gap-3 ' + (isDraft ? 'mb-3' : 'mb-4')}>
          <FlowMonogram name={flow.name} size="lg" draft={isDraft} />
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="text-[15px] font-semibold leading-tight text-ink truncate">
              {flow.name}
            </div>
            {/* One sentence instead of a badge plus a sentence. The badge
                said "draft" and the line underneath said what that meant,
                so the badge was a loud restatement sitting where it
                competed with the flow's own name. The state and its
                consequence fit in the line that was already there. */}
            <div className="text-[11px] text-ink-muted mt-1 truncate">
              {isDraft ? (
                <>
                  Not saved yet — running it adds it to your library.
                </>
              ) : (
                <StepPreview flow={flow} />
              )}
            </div>
          </div>
          <button
            onClick={onCancel}
            className="text-ink-faint hover:text-ink rounded-full w-7 h-7 flex items-center justify-center hover:bg-white/5 flex-shrink-0 transition"
            aria-label="Close"
            title="Back to flows"
          >
            ✕
          </button>
        </div>

        {/* A flow you picked from the grid you already know by name; one an
            AI just wrote you don't, and running it both saves it and turns
            it loose on your project. So the draft — and only the draft —
            spells its pipeline out. Vertically: the horizontal diagram is
            built for the editor's wide column and wraps into dangling
            arrows at this width. */}
        {isDraft && <FlowSpine flow={flow} />}

        {/* Multi-line prompt with image attach / paste / drag-drop — the
            same Composer the chat uses, so a flow can be launched from a
            screenshot, spec, or log. Its send button (⏎) starts the run;
            the target + worktree controls ride in the footer. */}
        <Composer
          draftKey={draftKey}
          variant="welcome"
          autoFocus
          rootPath={rootPath}
          placeholder="What should it work on? Paste a screenshot or drop a file…"
          onSend={onRun}
          footer={
            <>
              {/* Target — a host-supplied picker, or a static label when
                  the host is already scoped to one context. */}
              {targetControl ?? (
                <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
                  <span className="text-ink-faint">in</span>
                  <span className="font-medium text-ink truncate max-w-[140px]">{targetLabel}</span>
                </div>
              )}

              {canUseWorktree && (
                <>
                  <span className="text-ink-faint text-[11px]">·</span>
                  {/* Segmented control with a real "active" state. */}
                  <div className="inline-flex p-0.5 rounded-lg bg-card border border-card-strong">
                    <SegmentButton
                      active={runIn === 'cwd'}
                      onClick={() => onRunIn('cwd')}
                      title="Run in the project's working tree"
                    >
                      main tree
                    </SegmentButton>
                    <SegmentButton
                      active={runIn === 'worktree'}
                      onClick={() => onRunIn('worktree')}
                      title="Create a fresh worktree and run there"
                    >
                      worktree
                    </SegmentButton>
                  </div>
                  {runIn === 'worktree' && (
                    <WorktreeBaseControl
                      isWorkspace={isWorkspace}
                      repoPaths={baseBranchRepoPaths}
                      value={baseBranch}
                      onChange={onBaseBranch}
                    />
                  )}
                </>
              )}

              {submitting && (
                <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <Spinner />{' '}
                  {launchProgress
                    ? launchProgress.total > 1
                      ? `${launchProgress.message} (${launchProgress.completed}/${launchProgress.total})`
                      : launchProgress.message
                    : 'Starting…'}
                </span>
              )}
            </>
          }
        />

        {error && (
          <div className="text-[11px] text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mt-3 whitespace-pre-wrap">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

/// Run launcher for a flow that isn't already scoped to a context: owns
/// the target (project/workspace) selection + worktree controls and drives
/// `RunPanel`. The target picker rides in the panel footer because — unlike
/// the start page — neither the Flows library nor the ⌘K palette knows
/// which project you meant.
export function FlowRunLauncher({
  flow,
  onClose,
  onLaunched,
}: {
  flow: Flow;
  onClose: () => void;
  /// Fired after a successful launch, with the new run's id. The library
  /// is already showing the run, so it omits this; hosts that live
  /// somewhere else (the palette) use it to navigate and dismiss.
  onLaunched?: (runId: string) => void;
}) {
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
  // Which side the run-in toggle starts on comes from Settings → Flows, so
  // a worktree-first user doesn't re-flip it on every launch. The toggle
  // still wins for this run; flipping the setting re-seeds the launcher.
  const defaultRunIn = useStore((s) => s.settings.defaultFlowRunIn ?? 'cwd');
  const [runIn, setRunIn] = useState<'cwd' | 'worktree'>(defaultRunIn);
  useEffect(() => setRunIn(defaultRunIn), [defaultRunIn]);
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
      onLaunched?.(result.runId);
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

/// One segment of a small inline toggle (the cwd/worktree control here, and
/// the Orchestrator's batch-level copy of it).
export function SegmentButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        'text-[11px] px-2.5 py-1 rounded-md transition-all ' +
        (active
          ? 'bg-accent/25 text-ink shadow-[0_1px_0_0_rgba(255,255,255,0.06)_inset]'
          : 'text-ink-muted hover:text-ink hover:bg-white/5')
      }
    >
      {children}
    </button>
  );
}

/// Base-branch control for a worktree run.
///   - Single repo → a branch picker (auto-selects the repo's default).
///   - Workspace (multiple repos) → defaults to "each repo's own default
///     branch" (empty value; the runtime forks each repo off its own
///     default, so members that disagree — main vs master — still work),
///     with an opt-in to instead align every repo on one shared branch.
function WorktreeBaseControl({
  isWorkspace,
  repoPaths,
  value,
  onChange,
}: {
  isWorkspace: boolean;
  repoPaths: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [useShared, setUseShared] = useState(false);

  if (!isWorkspace) {
    return (
      <div className="inline-flex items-center gap-1.5 text-[11px]">
        <span className="text-ink-faint">off</span>
        <BaseBranchSelect
          repoPaths={repoPaths}
          value={value}
          onChange={onChange}
          className="text-[11px]"
        />
      </div>
    );
  }

  if (!useShared) {
    return (
      <div className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
        <span className="text-ink-faint">off</span>
        <span>each repo&rsquo;s default</span>
        <button
          type="button"
          onClick={() => setUseShared(true)}
          className="text-ink-faint hover:text-ink underline-offset-2 hover:underline"
        >
          use one branch
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 text-[11px]">
      <span className="text-ink-faint">off shared</span>
      <BaseBranchSelect
        repoPaths={repoPaths}
        value={value}
        onChange={onChange}
        className="text-[11px]"
      />
      <button
        type="button"
        onClick={() => {
          setUseShared(false);
          onChange('');
        }}
        title="Back to each repo&rsquo;s default branch"
        className="text-ink-faint hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin w-3 h-3"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/// Single flow card in the welcome grid. Subtle resting state, lifts on
/// hover with a soft outline + tinted glow so the affordance reads as
/// clickable without shouting.
export function FlowCard({
  flow,
  picked,
  onClick,
  onTagClick,
}: {
  flow: Flow;
  picked: boolean;
  onClick: () => void;
  /// When given, tags render as clickable chips that filter the list.
  /// Omitted by hosts with no filter state to drive.
  onTagClick?: (tag: string) => void;
}) {
  const starred = useStore(
    (s) => (s.settings.starredFlows ?? []).includes(flowStarKey(flow)),
  );
  const toggleFlowStar = useStore((s) => s.toggleFlowStar);
  return (
    <button
      onClick={onClick}
      className={
        'group relative text-left rounded-xl border bg-card/30 px-3.5 py-3 transition-all duration-150 ' +
        'hover:bg-card/60 hover:border-accent/40 hover:-translate-y-0.5 hover:shadow-[0_4px_18px_-8px_rgba(125,200,255,0.4)] ' +
        (picked
          ? 'border-accent shadow-[0_4px_18px_-8px_rgba(125,200,255,0.5)]'
          : 'border-card')
      }
    >
      <div className="flex items-start gap-3">
        <FlowMonogram name={flow.name} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate text-ink leading-tight">
            {flow.name}
          </div>
          {flow.description && (
            <div className="text-[11px] text-ink-muted line-clamp-1 mt-1 leading-snug">
              {flow.description}
            </div>
          )}
          <div className="text-[10px] text-ink-faint mt-2 truncate">
            <StepPreview flow={flow} />
          </div>
          {/* Tags as `span role="button"`, not `<button>` — the whole card
              is already a button and nesting them is invalid HTML (React
              renders it, the browser reparents it, hydration diverges).
              Capped at 3: the card is a scan target, not a manifest. */}
          {flow.tags && flow.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {flow.tags.slice(0, 3).map((tag) => (
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
                    'text-[9.5px] leading-none px-1.5 py-0.5 rounded-full border border-card text-ink-faint ' +
                    (onTagClick ? 'cursor-pointer hover:text-ink hover:border-card-strong' : '')
                  }
                >
                  {tag}
                </span>
              ))}
              {flow.tags.length > 3 && (
                <span className="text-[9.5px] leading-none px-1 py-0.5 text-ink-faint/70">
                  +{flow.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
        <span
          role="button"
          aria-label={starred ? 'Unstar flow' : 'Star flow'}
          title={starred ? 'Unstar' : 'Star to pin to the welcome pane'}
          onClick={(e) => {
            e.stopPropagation();
            void toggleFlowStar({ source: flow.source, id: flow.id });
          }}
          className={
            'self-start text-base leading-none cursor-pointer transition-colors ' +
            (starred
              ? 'text-amber-400'
              : 'text-ink-faint opacity-0 group-hover:opacity-100 hover:text-amber-400')
          }
        >
          {starred ? '★' : '☆'}
        </span>
      </div>
    </button>
  );
}

/// The drafted pipeline, read top-to-bottom into the composer below it:
/// this is what will happen, now say what to work on.
///
/// A single hairline spine threads the steps, each one hanging its output
/// artifact beneath it. That's the actual structure of a flow — a step
/// produces a named artifact and the next step consumes it — so the
/// device encodes the content rather than decorating it. Steps are
/// numbered because a pipeline genuinely is an ordered sequence, not
/// because numbering looks tidy.
///
/// Everything sits directly on the panel: no sub-card, no section
/// heading. The earlier version nested a bordered "Pipeline" box inside a
/// bordered draft box inside the launch card, and three levels of
/// containment for one idea is what made it feel cramped.
function FlowSpine({ flow }: { flow: Flow }) {
  // Retry targets live on the step that retries them, not in a separate
  // "retry edges" section competing with the pipeline for attention.
  const retryTarget = (step: FlowStep) =>
    step.onFail?.action === 'goto' ? step.onFail.target : undefined;

  const summary = useMemo(() => flowSpineSummary(flow), [flow]);

  // No "your request" node at the head of the spine: the composer sitting
  // directly below IS the request, so labelling it above the steps it
  // feeds would put the input after the thing it inputs to. The spine is
  // the steps, nothing else.
  return (
    <div className="mb-4">
      <div className="text-[11px] text-ink-muted mb-2.5">{summary}</div>
      <ol>
        {flow.steps.map((step, i) => {
          const last = i === flow.steps.length - 1;
          const retry = retryTarget(step);
          const verb = ROLE_VERB[step.role];
          const writes = stepWrites(step);
          return (
            <li key={step.id} className={'relative pl-7 ' + (last ? '' : 'pb-3')}>
              {!last && (
                <span
                  className="absolute left-[7px] top-[17px] bottom-0 w-px bg-card-strong"
                  aria-hidden
                />
              )}
              <span
                className="absolute left-0 top-[2px] w-[15px] h-[15px] rounded-full bg-card-strong text-ink-faint text-[9px] font-medium flex items-center justify-center tabular-nums"
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[12px] text-ink truncate">{step.id}</span>
                {/* The model as a chip, not grey micro-text. A flow that
                    spends a thinking model on review and a fast one on the
                    grunt work is doing something deliberate, and that only
                    reads if the models are visibly different from each
                    other. */}
                <span className="ml-auto flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-card-strong bg-card text-ink-muted">
                  {compactStepModel(flow, step)}
                </span>
              </div>
              <div className="flex items-baseline flex-wrap gap-x-2 gap-y-0.5 mt-1 text-[10px] text-ink-faint">
                {verb && <span className="text-ink-muted">{verb}</span>}
                {writes && (
                  <span className="text-amber-600 dark:text-amber-300">edits files</span>
                )}
                {step.rebound && (
                  <span title={`Up to ${step.rebound.maxIters} rounds with a critic`}>
                    ↻ critic loop
                  </span>
                )}
                {step.pauseBefore && (
                  <span className="text-amber-600 dark:text-amber-300">waits for you</span>
                )}
                {retry && (
                  <span>
                    retries <span className="font-mono">{retry}</span> on failure
                  </span>
                )}
                <span className="font-mono text-ink-faint/80 truncate">↳ {step.output}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/// Compact "5 steps · plan → build → review" line. Truncates to 3 step
/// ids with an ellipsis for longer flows.
export function StepPreview({ flow }: { flow: Flow }) {
  const count = flow.steps.length;
  const ids = flow.steps.slice(0, 3).map((s) => s.id);
  const trail = flow.steps.length > 3 ? '…' : '';
  return (
    <>
      {count} step{count === 1 ? '' : 's'}
      {ids.length > 0 && (
        <>
          {' · '}
          <span className="text-ink-muted">{ids.join(' → ')}{trail}</span>
        </>
      )}
    </>
  );
}
