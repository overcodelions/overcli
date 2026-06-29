// Active flow run viewer, structured around PARTICIPANTS.
//
// Top bar: title, state, cost, abort.
// Pause banner (when paused): explains what's happening + Continue.
// Step timeline: chips showing every step + who runs it; the current /
//   focus step is highlighted. Click a chip to jump to that
//   participant's tab.
// Participant tabs: one per declared participant; the active tab is the
//   participant currently executing (or the most recently active).
// Body: full ChatView for the selected participant's conversation.
// Hijack composer: at the bottom of the body — sends a turn DIRECTLY
//   to that participant. The runtime tolerates user-driven turns
//   (they don't count toward step completion) so you can ask
//   questions, redirect, or fork the participant's thinking from
//   anywhere.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { useRunner, useRunnerIsRunning } from '../../runnersStore';
import { ChatView } from '../ChatView';
import { RunningIndicator } from '../RunningIndicator';
import { Composer } from '../Composer';
import { Markdown } from '../Markdown';
import { ChangesBar, type FileChangeSummary } from '../ChangesBar';
import { workspaceSymlinkNames } from '@shared/workspaceNames';
import type { Attachment } from '@shared/types';
import {
  resolveRunStepModel,
  type FlowArtifact,
  type FlowParticipant,
  type FlowRun,
  type FlowStep,
  type FlowStepAttempt,
  type WatchTickLogEntry,
} from '@shared/flows/schema';
import { modelSpeed, friendlyModelLabel, PREMIUM_MODELS } from '@shared/modelCatalog';
import { FlowMonogram } from './FlowMonogram';

export function FlowRunPane({ runId }: { runId: string }) {
  const run = useFlowsStore((s) => s.runs[runId]);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const applyRunUpdate = useFlowsStore((s) => s.applyRunUpdate);
  const removeRun = useFlowsStore((s) => s.removeRun);
  const openSheet = useStore((s) => s.openSheet);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingRerun, setConfirmingRerun] = useState(false);
  const [diffSheetOpen, setDiffSheetOpen] = useState(false);
  const [watchSetupOpen, setWatchSetupOpen] = useState(false);

  useEffect(() => {
    if (!run) {
      void window.overcli
        .invoke('flows:getRun', { runId })
        .then((r) => r && applyRunUpdate(r));
    }
  }, [runId]);

  // Track the focus STEP instead of a participant — the pipeline at the
  // top is a single row of step cards, and clicking one switches the
  // body to that step's participant's conversation. Auto-follows the
  // currently-running step unless the user has manually picked another.
  // Depend on the whole run: pickFocusStepId reads currentStepId / nextStepId
  // and per-attempt endedAt, which can change without state.kind or
  // attempts.length changing. The store swaps the run object on every update,
  // and defaultStepId is a primitive, so the auto-follow effect below only
  // fires when the resolved value actually changes — recomputing is cheap.
  const defaultStepId = useMemo(() => {
    if (!run) return null;
    return pickFocusStepId(run);
  }, [run]);

  const [focusStepId, setFocusStepId] = useState<string | null>(null);
  const [autoFollowedId, setAutoFollowedId] = useState<string | null>(null);
  useEffect(() => {
    if (!defaultStepId) return;
    if (focusStepId === autoFollowedId) {
      setFocusStepId(defaultStepId);
    }
    setAutoFollowedId(defaultStepId);
  }, [defaultStepId]);

  if (!run) {
    return (
      <div className="p-6 text-sm text-ink-muted">
        Loading run…
        <div className="mt-4">
          <button
            onClick={() => setActiveRun(null)}
            className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ← Back to library
          </button>
        </div>
      </div>
    );
  }

  const participants = run.flowSnapshot.participants ?? [];
  const activeStepId = focusStepId ?? defaultStepId ?? run.flowSnapshot.steps[0]?.id ?? null;
  const activeStep = run.flowSnapshot.steps.find((s) => s.id === activeStepId) ?? null;
  const activeParticipant =
    activeStep && participants.find((p) => p.id === activeStep.participantId) || null;
  const activeConvId = activeParticipant
    ? run.conversationIds[activeParticipant.id]
    : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Header — flow name as h1, original prompt as a real subtitle
          underneath. Treating the prompt as the run's identity rather
          than a separate banner reads cleaner than the colored strip
          and stops the page from having two competing "anchors". */}
      <div className="pl-2 pr-3 pt-4 pb-2 border-b border-card">
        <div className="flex items-center gap-3 mb-1">
          <div className="flex items-center gap-1.5 text-xs text-ink-faint">
            <button
              onClick={() => setActiveRun(null)}
              className="hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5"
            >
              Flows
            </button>
            <span className="text-ink-faint">/</span>
          </div>
          <div className="text-xl font-semibold">{run.flowSnapshot.name}</div>
          <RunStateBadge state={run.state} />
          <RunTokenSummary run={run} />
          <RunDiffStats run={run} onOpen={() => setDiffSheetOpen(true)} />
          <div className="flex-1 min-w-0" />
          <div className="flex items-center gap-2">
            {activeParticipant && (
              <HijackModelPicker
                runId={run.id}
                participant={activeParticipant}
              />
            )}
            {(run.worktreePath || (run.workspaceWorktrees?.length ?? 0) > 0) && (
              <button
                onClick={() => openSheet({ type: 'flowRunReview', runId })}
                className="text-xs px-3 py-1 rounded-md bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25"
                title="Review the worktree diff and merge / push / open a PR — pull the work back into your local repo"
              >
                Review &amp; merge
              </button>
            )}
            {/* Re-run from the currently-viewed step. The user's "how do I
                go back?" answer: rewind to this step and re-execute it plus
                every later step, picking up any edits made to upstream
                artifacts via hijack chat. Only offered on a settled run for
                a step that has actually run — re-running a never-reached step
                is meaningless, and re-running while a step is live would race
                the subprocess (Abort shows instead in that case). */}
            {activeStep &&
              (run.state.kind === 'paused' ||
                run.state.kind === 'done' ||
                run.state.kind === 'aborted') &&
              run.attempts.some((a) => a.stepId === activeStep.id) &&
              (confirmingRerun ? (
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-ink-faint mr-1">
                    Re-run from <span className="font-mono">{activeStep.id}</span>? Re-does it
                    and every later step.
                  </span>
                  <button
                    onClick={async () => {
                      const result = await window.overcli.invoke('flows:rerunFromStep', {
                        runId,
                        stepId: activeStep.id,
                      });
                      setConfirmingRerun(false);
                      if (!result.ok) alert(`Couldn't re-run: ${result.error}`);
                    }}
                    className="text-xs px-2 py-1 rounded-md bg-amber-500/80 text-white"
                  >
                    Re-run
                  </button>
                  <button
                    onClick={() => setConfirmingRerun(false)}
                    className="text-xs px-2 py-1 rounded-md bg-card"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingRerun(true)}
                  className="text-xs px-3 py-1 rounded-md border border-card-strong bg-surface-elevated text-ink-muted hover:text-ink hover:border-amber-500/50"
                  title={`Rewind and re-run from "${activeStep.id}" — re-does this step and every later step using the current (possibly edited) upstream artifacts`}
                >
                  ↻ Re-run from here
                </button>
              ))}
            {(run.state.kind === 'running' || run.state.kind === 'paused') && (
              <button
                onClick={() => {
                  void window.overcli.invoke('flows:abortRun', { runId });
                }}
                className="text-xs px-3 py-1 rounded-md bg-red-500/20 text-red-700 dark:text-red-200 hover:bg-red-500/30"
              >
                Abort
              </button>
            )}
            {/* Watch entry point. Always offered on a completed run; also
                offered on an archived run that has NO saved watch — otherwise
                that run is stranded with no way to (re)start a watch, since
                the archived summary row + its Resume button only render when
                `state.watch` exists. An archived run that DOES still have its
                watch gets its Resume affordance from WatchSection instead, so
                we don't duplicate a trigger here. */}
            {(run.state.kind === 'done' ||
              (run.state.kind === 'archived' && !run.state.watch)) && (
              <button
                onClick={() => setWatchSetupOpen((v) => !v)}
                className={
                  'inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-md border transition-colors ' +
                  (watchSetupOpen
                    ? 'border-accent/50 bg-accent/10 text-accent'
                    : 'border-card-strong bg-surface-elevated text-ink-muted hover:text-ink hover:border-accent/50')
                }
                title="Keep this run on call to answer follow-up comments while you're away — it answers questions, never does new work"
              >
                <WatchEye className="w-3.5 h-3.5" />
                Watch
              </button>
            )}
            {confirmingDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-ink-faint mr-1">Delete this run?</span>
                <button
                  onClick={async () => {
                    const result = await window.overcli.invoke('flows:deleteRun', { runId });
                    if (!result.ok) {
                      alert(`Couldn't delete: ${result.error}`);
                      return;
                    }
                    setConfirmingDelete(false);
                    removeRun(runId);
                    setActiveRun(null);
                  }}
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
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-xs px-3 py-1 rounded-md text-ink-muted hover:text-red-700 dark:hover:text-red-300 hover:bg-card-strong"
                title="Delete this run permanently"
              >
                Delete
              </button>
            )}
          </div>
        </div>
        {/* Step pipeline gets its own full-width row so it can breathe and
            stays vertically clean — keeping it inline with the title/actions
            row left the pills offset by the reserved scrollbar gutter. */}
        <div className="overflow-x-auto no-scrollbar -mx-0.5 px-0.5 mb-1">
          <InlineStepPipeline
            run={run}
            activeStepId={activeStepId}
            onPick={(id) => {
              // Switching steps abandons any half-open re-run confirmation —
              // it's bound to the step being viewed, so it must never carry
              // over to the step the user just navigated to.
              setConfirmingRerun(false);
              setFocusStepId(id);
            }}
          />
        </div>
        {/* Original prompt as subtitle. Sits directly under the flow
            name, treats the user's words as the run's identity. */}
        <RunPromptSubtitle
          prompt={run.userPrompt}
          activeStep={activeStep}
          run={run}
          activeParticipant={activeParticipant}
          activeStepId={activeStepId}
        />
      </div>

      {/* Pause banner — shown when actually paused AND while a Continue
          click is being processed (`pendingContinue`), so the user gets
          explicit "Continuing…" feedback instead of the banner vanishing
          instantly on click. */}
      {(run.state.kind === 'paused' || run.pendingContinue) && (
        <PauseBanner run={run} />
      )}

      {/* Watch ("stewardship tail") — entry form on a completed run (opened
          from the header "Watch" button), status banner while watching,
          summary once archived. */}
      <WatchSection run={run} open={watchSetupOpen} setOpen={setWatchSetupOpen} />

      {/* Body */}
      {participants.length === 0 || !activeParticipant ? (
        <div className="p-6 text-sm text-ink-muted">
          This run has no participants — open the flow in the editor to fix.
        </div>
      ) : (
        <ParticipantBody
          run={run}
          participant={activeParticipant}
          convId={activeConvId}
          focusStepId={activeStepId}
        />
      )}
      {diffSheetOpen && <DiffSheet run={run} onClose={() => setDiffSheetOpen(false)} />}
    </div>
  );
}

// Step the user's attention should be on. Running => the executing
// step. Paused => the step that just finished so the user can chat
// with whoever just produced output. Done / aborted => last attempt's
// step.
function pickFocusStepId(run: FlowRun): string | null {
  const state = run.state;
  if (state.kind === 'running') return state.currentStepId;
  for (let i = run.attempts.length - 1; i >= 0; i--) {
    if (run.attempts[i].endedAt) return run.attempts[i].stepId;
  }
  if (state.kind === 'paused') return state.nextStepId;
  return run.flowSnapshot.steps[0]?.id ?? null;
}

// Watch ("stewardship tail") UI. Three modes keyed off run state:
//   - done:     a collapsed "Watch for follow-ups" affordance that expands
//               to a small setup form (source, target, plain-language
//               instructions, cadence, optional auto-stop).
//   - watching: a live status banner (what it's watching, how many comments
//               it has answered, escalation flag, last tick note) + Archive.
//   - archived: a one-line summary of how the watch went.
// Everything routes through the flows:enterWatch / flows:archiveRun IPC.
function WatchSection({
  run,
  open,
  setOpen,
}: {
  run: FlowRun;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [sources, setSources] = useState<Array<{ id: string; displayName: string }>>([]);
  const [sourceId, setSourceId] = useState('ai');
  const [binding, setBinding] = useState('');
  const [instructions, setInstructions] = useState('');
  const [pollMin, setPollMin] = useState(10);
  const [ttlHours, setTtlHours] = useState<number | ''>(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  useEffect(() => {
    if (!open || sources.length > 0) return;
    void window.overcli.invoke('flows:listWatchSources').then((s) => {
      setSources(s);
      // Default to the AI-defined source — the no-integration-needed path.
      if (s.length > 0 && !s.some((x) => x.id === 'ai')) setSourceId(s[0].id);
    });
  }, [open, sources.length]);

  // When opening the form to RESUME an archived watch, prefill it with the
  // saved settings so the user can tweak (e.g. fix a mistyped target) rather
  // than retype everything. Seeds once per open.
  const resuming = run.state.kind === 'archived' && !!run.state.watch;
  const priorWatch = run.state.kind === 'archived' ? run.state.watch : undefined;
  useEffect(() => {
    if (!open || !priorWatch) return;
    setSourceId(priorWatch.sourceId);
    setBinding(priorWatch.binding);
    setInstructions(priorWatch.instructions ?? '');
    setPollMin(Math.max(1, Math.round(priorWatch.pollIntervalMs / 60_000)));
    setTtlHours('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fieldCls =
    'w-full bg-card border border-card-strong rounded-md px-2.5 py-1.5 text-xs text-ink ' +
    'placeholder:text-ink-faint focus:outline-none focus:border-accent transition-colors';

  if (open && (run.state.kind === 'done' || run.state.kind === 'archived')) {
    return (
      <div className="pl-2 pr-3 pt-1.5">
        <div className="rounded-lg border border-card-strong bg-surface-elevated overflow-hidden">
          {/* Header */}
          <div className="flex items-start gap-3 px-4 py-3 border-b border-card-strong/70">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
              <WatchEye className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-ink leading-tight">
                {resuming ? 'Resume watching' : 'Watch for follow-ups'}
              </div>
              <div className="text-[11px] text-ink-faint leading-tight mt-0.5">
                {resuming
                  ? 'Edit anything and resume — if you keep the same target it picks up where it left off without re-answering old comments.'
                  : "Keeps this run on call to answer comments while you're away — it answers questions, never does new work."}
              </div>
            </div>
          </div>

          {/* Body */}
          <div className="px-4 py-3 space-y-3">
            {/* The Source picker only earns its place once there's more than
                one source — with just the universal AI-defined source, it's a
                pointless one-option dropdown, so we hide it and let "What to
                watch" take the full row. It returns automatically if a named
                preset (GitHub, Zendesk, …) is ever registered. */}
            <div
              className={
                'grid grid-cols-1 gap-3 ' + (sources.length > 1 ? 'sm:grid-cols-[200px_1fr]' : '')
              }
            >
              {sources.length > 1 && (
                <div className="space-y-1">
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                    Source
                  </label>
                  <select
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                    className={fieldCls + ' appearance-none cursor-pointer'}
                  >
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div className="space-y-1">
                <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                  What to watch
                </label>
                <input
                  value={binding}
                  onChange={(e) => setBinding(e.target.value)}
                  placeholder="URL, ticket id, or name"
                  className={fieldCls}
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] font-medium uppercase tracking-wide text-ink-faint">
                Instructions
              </label>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={
                  'Describe in plain language what to watch and how to respond — e.g. ' +
                  '"Watch this ticket for tester comments and answer their questions about the ' +
                  'fix. If they ask for changes, flag me instead of doing them."'
                }
                rows={3}
                className={fieldCls + ' resize-y leading-relaxed'}
              />
            </div>

            <div className="flex items-center gap-5">
              <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span>Check every</span>
                <input
                  type="number"
                  min={1}
                  value={pollMin}
                  onChange={(e) => setPollMin(Math.max(1, Number(e.target.value) || 1))}
                  className="w-14 bg-card border border-card-strong rounded-md px-2 py-1 text-xs text-ink text-center focus:outline-none focus:border-accent"
                />
                <span>min</span>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                <span>Auto-stop after</span>
                <input
                  type="number"
                  min={0}
                  value={ttlHours}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTtlHours(v === '' ? '' : Math.max(0, Number(v) || 0));
                  }}
                  placeholder="∞"
                  className="w-14 bg-card border border-card-strong rounded-md px-2 py-1 text-xs text-ink text-center placeholder:text-ink-faint focus:outline-none focus:border-accent"
                />
                <span>hrs</span>
              </label>
            </div>

            {error && (
              <div className="text-[11px] text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-2.5 py-1.5">
                {error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-card-strong/70 bg-card/30">
            <button
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              className="text-xs font-medium px-3 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-card-strong transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                const result = await window.overcli.invoke('flows:enterWatch', {
                  runId: run.id,
                  sourceId,
                  binding: binding.trim(),
                  instructions: instructions.trim() || undefined,
                  pollIntervalSec: pollMin * 60,
                  ttlHours: ttlHours === '' ? undefined : ttlHours,
                });
                setBusy(false);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                setOpen(false);
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3.5 py-1.5 rounded-md bg-accent text-white hover:bg-accent-600 disabled:opacity-50 shadow-sm transition-colors"
            >
              <WatchEye className="w-3.5 h-3.5" />
              {busy ? (resuming ? 'Resuming…' : 'Starting…') : resuming ? 'Resume watching' : 'Start watching'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (run.state.kind === 'watching') {
    const w = run.state.watch;
    const lastTick = w.lastTickAt ? new Date(w.lastTickAt).toLocaleTimeString() : 'pending…';
    const logCount = w.log?.length ?? 0;
    return (
      <div className="pl-2 pr-3 pt-1.5">
        <div
          className={
            'rounded-lg border bg-surface-elevated overflow-hidden ' +
            (w.escalated ? 'border-amber-500/50' : 'border-card-strong')
          }
        >
          <div className="flex items-center gap-3 px-3.5 py-2">
            <div
              className={
                'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md ' +
                (w.escalated ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300' : 'bg-accent/15 text-accent')
              }
            >
              <WatchEye className="w-4 h-4" />
              {!w.escalated && (
                <span className="absolute -right-0.5 -top-0.5 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-ink leading-tight">
                <span className="truncate">Watching {w.binding || 'follow-ups'}</span>
                {w.escalated && (
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
                    Needs you
                  </span>
                )}
              </div>
              <div className="text-[11px] text-ink-faint leading-tight mt-0.5 truncate">
                {w.escalated ? 'A comment asked for work — reopen the flow to act. ' : ''}
                {w.lastNote ? w.lastNote + ' · ' : ''}
                answered {w.answered} · last checked {lastTick}
              </div>
            </div>

            <button
              onClick={() => setLogOpen((v) => !v)}
              className="shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1.5 rounded-md text-ink-muted hover:text-ink hover:bg-card-strong/60 transition-colors"
              title="Read the watch log — every check this watch has done"
            >
              <Chevron open={logOpen} />
              Log{logCount > 0 ? ` (${logCount})` : ''}
            </button>
            <button
              disabled={archiving}
              onClick={() => {
                // Guard against a double-fire — the run state round-trips back
                // through IPC asynchronously, so without this a quick second
                // click would invoke archiveRun again on an already-archived
                // run.
                if (archiving) return;
                setArchiving(true);
                void window.overcli.invoke('flows:archiveRun', { runId: run.id });
              }}
              className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-md border border-card-strong bg-surface-elevated text-ink-muted hover:text-ink transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Stop watching and archive this run"
            >
              {archiving ? 'Archiving…' : 'Archive'}
            </button>
          </div>
          {logOpen && <WatchLog log={w.log} />}
        </div>
      </div>
    );
  }

  if (run.state.kind === 'archived' && run.state.watch) {
    const w = run.state.watch;
    const logCount = w.log?.length ?? 0;
    return (
      <div className="pl-2 pr-3 pt-1.5">
        <div className="rounded-lg border border-card-strong bg-card/40 overflow-hidden">
          <div className="flex items-center gap-2.5 px-3.5 py-2">
            <ArchiveIcon className="w-4 h-4 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1 text-[11px] text-ink-muted truncate">
              <span className="font-medium text-ink">Archived</span> · watched{' '}
              {w.binding || '(AI-defined)'} · answered {w.answered} follow-up
              {w.answered === 1 ? '' : 's'}
              {w.escalated ? ' · escalated once' : ''}
            </div>
            {logCount > 0 && (
              <button
                onClick={() => setLogOpen((v) => !v)}
                className="shrink-0 inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md text-ink-muted hover:text-ink hover:bg-card-strong/60 transition-colors"
                title="Read the watch log — every check this watch did"
              >
                <Chevron open={logOpen} />
                Log ({logCount})
              </button>
            )}
            <button
              onClick={() => setOpen(true)}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-md border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
              title="Resume this watch — opens the settings so you can edit the target or instructions first"
            >
              <WatchEye className="w-3.5 h-3.5" />
              Resume…
            </button>
          </div>
          {logOpen && <WatchLog log={w.log} />}
        </div>
      </div>
    );
  }

  return null;
}

/// The readable watch log: one row per completed poll tick, newest first,
/// with time, what it saw, and answered / needs-work markers.
function WatchLog({ log }: { log?: WatchTickLogEntry[] }) {
  const entries = (log ?? []).slice().reverse();
  return (
    <div className="border-t border-card bg-surface/40 max-h-56 overflow-y-auto">
      {entries.length === 0 ? (
        <div className="px-3.5 py-3 text-[11px] text-ink-faint">
          No checks recorded yet — the first one will appear here after the next poll.
        </div>
      ) : (
        <ul>
          {entries.map((e, i) => (
            <li
              key={i}
              className="flex items-start gap-2.5 px-3.5 py-2 border-t border-card first:border-t-0"
            >
              <span className="shrink-0 w-16 text-[10px] tabular-nums text-ink-faint pt-0.5">
                {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="min-w-0 flex-1 text-[11px] text-ink-muted leading-snug">{e.note}</span>
              <span className="shrink-0 flex items-center gap-1.5">
                {e.answered > 0 && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                    {e.answered} answered
                  </span>
                )}
                {e.needsWork && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-700 dark:text-amber-300">
                    needs you
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// Small archive-box glyph (replaces the 📦 emoji, which rendered
/// inconsistently and clashed with the rest of the watch UI).
function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7.5 4.2 5.3A1.5 1.5 0 0 1 5.5 4.5h13a1.5 1.5 0 0 1 1.3.8L21 7.5M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V7.5M3 7.5h18M10 11h4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/// Disclosure chevron that rotates when open.
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={'w-3 h-3 transition-transform ' + (open ? 'rotate-90' : '')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/// Eye glyph used across the watch UI — a single inline SVG so the icon is
/// crisp and tintable (the emoji 👁 rendered inconsistently across platforms).
function WatchEye({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

// Compact step pills designed to live inside the page header row. Each
// pill is just idx + monogram + step name + status icon — model goes in
// the tooltip. Clicking switches the body to that step's participant.
function InlineStepPipeline({
  run,
  activeStepId,
  onPick,
}: {
  run: FlowRun;
  activeStepId: string | null;
  onPick: (stepId: string) => void;
}) {
  const steps = run.flowSnapshot.steps;
  const participants = run.flowSnapshot.participants ?? [];
  const st = run.state;
  // When the run is in a terminal state, a participant's conv can still
  // be streaming if the user is hijack-chatting with it. Surface that as
  // a pulse on the step pill they're viewing, so a "done" run still
  // visually reflects in-flight activity.
  const activeStep = steps.find((s) => s.id === activeStepId) ?? null;
  const activeConvId = activeStep ? run.conversationIds[activeStep.participantId] : undefined;
  const activeConvIsRunning = useRunnerIsRunning(activeConvId);
  return (
    <div className="flex items-center gap-1">
      {steps.map((step, idx) => {
        const participant = participants.find((p) => p.id === step.participantId);
        const attempts = run.attempts.filter((a) => a.stepId === step.id);
        const last = attempts[attempts.length - 1];
        const done = last?.outcome === 'success';
        const failed = last?.outcome && last.outcome !== 'success';
        const isCurrent = st.kind === 'running' && st.currentStepId === step.id;
        const isPausedNext = st.kind === 'paused' && st.nextStepId === step.id;
        const isActive = step.id === activeStepId;
        const isResponding = isActive && activeConvIsRunning && !isCurrent;
        return (
          <div key={step.id} className="flex items-center gap-1 flex-shrink-0">
            <InlineStepPill
              step={step}
              participant={participant}
              isActive={isActive}
              isCurrent={isCurrent}
              isResponding={isResponding}
              isPausedNext={isPausedNext}
              done={done}
              failed={!!failed}
              onClick={() => onPick(step.id)}
              idx={idx}
            />
            {idx < steps.length - 1 && <StepArrow done={done} pulsing={isCurrent} />}
          </div>
        );
      })}
    </div>
  );
}

function InlineStepPill({
  step,
  participant,
  isActive,
  isCurrent,
  isResponding,
  isPausedNext,
  done,
  failed,
  onClick,
  idx,
}: {
  step: FlowStep;
  participant: FlowParticipant | undefined;
  isActive: boolean;
  isCurrent: boolean;
  isResponding: boolean;
  isPausedNext: boolean;
  done: boolean;
  failed: boolean;
  onClick: () => void;
  idx: number;
}) {
  const pulsing = isCurrent || isResponding;
  const stateBorder = isActive
    ? 'border-accent'
    : pulsing
      ? 'border-accent/80'
      : isPausedNext
        ? 'border-amber-400/60'
        : done
          ? 'border-emerald-400/40'
          : failed
            ? 'border-red-400/40'
            : 'border-card-strong';
  const bg = isActive ? 'bg-accent/[0.14]' : 'bg-card/30 hover:bg-card/55';
  return (
    <button
      onClick={onClick}
      aria-pressed={isActive}
      className={
        'flex items-center gap-1.5 rounded-md border px-2 py-1 transition flex-shrink-0 ' +
        stateBorder + ' ' + bg
      }
      title={
        (participant ? `${participant.backend}:${participant.model}` : '') +
        (isActive ? ' (viewing)' : '') +
        (isResponding ? ' — responding' : '')
      }
    >
      <span
        className={
          'text-[10px] font-mono ' + (isActive ? 'text-accent' : 'text-ink-faint')
        }
      >
        {idx + 1}
      </span>
      {participant && <FlowMonogram name={participant.name} size="xs" />}
      <span className="text-xs font-semibold text-ink">{step.id}</span>
      {pulsing && <span className="text-sky-700 dark:text-sky-300 animate-spin text-[10px]">⟳</span>}
      {done && !pulsing && <span className="text-emerald-700 dark:text-emerald-300/80 text-[10px]">✓</span>}
      {failed && !pulsing && <span className="text-red-700 dark:text-red-300 text-[10px]">!</span>}
      {isPausedNext && <span className="text-amber-700 dark:text-amber-300 text-[10px]">⏸</span>}
    </button>
  );
}

function StepArrow({ done, pulsing }: { done: boolean; pulsing: boolean }) {
  const color = done ? 'text-emerald-700 dark:text-emerald-400/70' : 'text-ink-faint';
  return (
    <div className="flex items-center px-0.5">
      <svg width="18" height="12" viewBox="0 0 22 14" className={color + (pulsing ? ' animate-pulse' : '')} aria-hidden>
        <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
        <path d="M14 3 L18 7 L14 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    </div>
  );
}

function ParticipantBody({
  run,
  participant,
  convId,
  focusStepId,
}: {
  run: FlowRun;
  participant: FlowParticipant;
  convId: string | undefined;
  focusStepId: string | null;
}) {
  // Steps this participant owns, in order. Still used for the "not called
  // yet" hint below; the in-thread chips moved to the header.
  const ownedSteps = useMemo(
    () => run.flowSnapshot.steps.filter((s) => s.participantId === participant.id),
    [run.flowSnapshot.steps, participant.id],
  );

  // Artifacts this participant produced — the persisted record of WHAT
  // GOT DONE. Surface these prominently above the chat so a user
  // coming back to a finished run sees the outputs without having to
  // scroll a transcript that may be gone (renderer-side runnersStore
  // is in-memory; the chat empties after restart but artifacts survive
  // in the FlowRun JSON on disk).
  //
  // Read each step's OWN produced artifact off its latest successful
  // attempt rather than the name-keyed `run.artifacts` map: when two
  // steps share an output name (e.g. `build` and `tests` both produce
  // `diff`), the map only keeps the last writer, so looking up by name
  // would show the same blob once per step. The per-attempt copy also
  // carries each diff step's INCREMENTAL change instead of the cumulative
  // diff. Falls back to the map for steps whose attempt predates this
  // (older runs didn't record per-attempt artifacts). Memoized so the
  // `isTyping` flip below doesn't force ArtifactsPanel to re-scan diffs.
  const producedArtifacts = useMemo(
    () =>
      ownedSteps
        .map((step) => {
          const latest = [...run.attempts]
            .reverse()
            .find((a) => a.stepId === step.id && a.outcome === 'success');
          const artifact = latest?.artifact ?? run.artifacts[step.output];
          return { step, artifact };
        })
        .filter(
          (x): x is { step: typeof x.step; artifact: NonNullable<typeof x.artifact> } =>
            !!x.artifact,
        ),
    [ownedSteps, run.attempts, run.artifacts],
  );

  // When the user starts typing a hijack message, collapse the artifacts
  // panel so the chat + composer aren't squeezed. The Composer writes its
  // draft to `conversationDrafts[draftKey]` — reading the same key here
  // lets us react instantly as they type.
  const hijackDraftKey = `flow-hijack:${run.id}:${participant.id}`;
  const isTyping = useStore((s) => (s.conversationDrafts[hijackDraftKey] ?? '').trim().length > 0);

  // Restore the chat transcript on mount. Flow conversations are now
  // first-class in the conversation index (synthesized from FlowRun
  // data); `loadHistoryIfNeeded` can resolve the backend + cwd +
  // sessionId for them and pull the CLI's persisted JSONL from disk.
  // Without this call the chat panel only shows the artifact after an
  // app restart and the user can't see what the model actually said.
  const loadHistoryIfNeeded = useStore((s) => s.loadHistoryIfNeeded);
  useEffect(() => {
    if (convId) void loadHistoryIfNeeded(convId);
  }, [convId, loadHistoryIfNeeded]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Context strip — "this participant ran/will-run these steps; you're
          seeing the cumulative transcript." Only shown when the
          participant runs more than one step; single-step participants
          don't benefit from the strip (the top pipeline already labels
          it). */}
      {/* Artifacts panel — collapsible "what this participant produced"
          summary. Shown above the chat so it's visible at a glance,
          even when the chat transcript is empty (e.g. after a restart
          when runnersStore lost its in-memory events). The "steps in this
          thread" strip that used to sit here now lives next to the
          produces/reads line in the header. */}
      {producedArtifacts.length > 0 && (
        <ArtifactsPanel items={producedArtifacts} forceCollapsed={isTyping} />
      )}

      {/* Faint separator between the top block (watch banner + outputs) and
          the conversation pane, so the chat reads as its own region. */}
      {/* ChatView's root uses `flex-1 min-h-0 flex flex-col`, so its
          immediate parent MUST be a column flex container — otherwise
          Virtuoso never gets a height and the chat renders blank. */}
      <div className="flex-1 min-h-0 flex flex-col border-t border-card">
        {convId ? (
          <ChatView conversationId={convId} />
        ) : (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <div className="text-sm text-ink-muted">
                {participant.name} hasn't been called yet.
              </div>
              <div className="text-[11px] text-ink-faint mt-1">
                {ownedSteps.length > 0
                  ? `Will run: ${ownedSteps.map((s) => s.id).join(', ')}. Type below to talk to them now.`
                  : 'No steps assigned. Type below to talk to them directly.'}
              </div>
            </div>
          </div>
        )}
      </div>
      <HijackComposer run={run} participant={participant} convId={convId} />
    </div>
  );
}

// Render the named artifacts a participant produced, with sensible
// per-kind rendering (markdown for .md, diff coloring for diffs, plain
// code fences for everything else). Each artifact starts collapsed if
// the body is large so the panel doesn't shove the chat off-screen.
function ArtifactsPanel({
  items,
  forceCollapsed = false,
}: {
  items: Array<{ step: FlowStep; artifact: import('@shared/flows/schema').FlowArtifact }>;
  /// When true, every artifact renders collapsed regardless of the
  /// user's per-row toggle state. Used to shrink the panel out of the
  /// way when the user is typing a hijack message so the chat keeps
  /// the screen. Their toggle state is preserved and restored when the
  /// flag flips back to false.
  forceCollapsed?: boolean;
}) {
  const openFile = useStore((s) => s.openFile);
  // Keyed by STEP id, not artifact name: two owned steps can produce the
  // same output name (e.g. both `diff`), so the name isn't unique per row.
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set());
  // STEP id of the row whose "copy" was just clicked, for transient
  // "copied" feedback on that row only.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Whole-panel collapse. Default collapsed so the produced summary stays a
  // slim header bar instead of a bulky stack — expand to see the files.
  const [panelOpen, setPanelOpen] = useState(false);
  function toggle(key: string) {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function copyBody(key: string, body: string) {
    void navigator.clipboard.writeText(body);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1200);
  }
  // summarizeArtifact iterates every line of a diff body, so caching the
  // result keyed on the (memoized) items array keeps the `forceCollapsed`
  // flip cheap when the user starts/stops typing.
  const summaries = useMemo(
    () => items.map(({ artifact }) => summarizeArtifact(artifact)),
    [items],
  );
  return (
    <div className="pl-2 pr-3 pt-1.5 pb-1.5">
      <div className="rounded-lg border border-card-strong bg-surface-elevated overflow-hidden">
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-3.5 py-2 text-[10px] uppercase tracking-wider text-ink-faint hover:text-ink-muted transition-colors"
        >
          <Chevron open={panelOpen} />
          <span>What this participant produced</span>
          <span className="text-ink-faint/70 normal-case tracking-normal">
            · {items.length} file{items.length === 1 ? '' : 's'}
          </span>
        </button>
        {panelOpen && (
        <div className="px-3.5 pb-3 space-y-2">
        {items.map(({ step, artifact }, idx) => {
          const open = !forceCollapsed && openSet.has(step.id);
          const summary = summaries[idx];
          return (
            <div
              key={step.id}
              className="rounded-md border border-card bg-card/30 overflow-hidden"
            >
              {/* Header row: the toggle is its own button (can't nest the
                  copy/open buttons inside it), with the actions as siblings
                  so the whole strip reads as one bar. */}
              <div className="flex items-center hover:bg-white/[0.02]">
                <button
                  onClick={() => toggle(step.id)}
                  className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left"
                >
                  <span className="text-[11px] text-ink-faint">{open ? '▼' : '▶'}</span>
                  <span className="text-xs font-mono text-ink truncate">{artifact.name}</span>
                  <span className="text-[11px] text-ink-faint whitespace-nowrap">
                    · from <span className="font-semibold">{step.id}</span> ·{' '}
                    {artifact.body.length.toLocaleString()} chars
                  </span>
                  {summary && (
                    <span className="ml-2 text-[11px] text-emerald-700 dark:text-emerald-300/80 truncate">
                      {summary}
                    </span>
                  )}
                </button>
                <div className="ml-auto flex items-center gap-1 pr-2 shrink-0">
                  <button
                    onClick={() => copyBody(step.id, artifact.body)}
                    className="px-1.5 py-0.5 text-[10px] text-ink-faint hover:text-ink"
                    title="Copy the output to the clipboard"
                  >
                    {copiedKey === step.id ? 'copied' : 'copy'}
                  </button>
                  {artifact.kind !== 'url' && (
                    <button
                      onClick={() =>
                        void window.overcli.invoke('flows:openArtifact', {
                          name: artifact.name,
                          kind: artifact.kind,
                          body: artifact.body,
                        })
                      }
                      className="px-1.5 py-0.5 text-[10px] text-ink-faint hover:text-ink"
                      title="Open the output in your default app"
                    >
                      open
                    </button>
                  )}
                </div>
              </div>
              {open && (
                <>
                  {/* Cap the expanded view at 70% of the viewport so it
                      makes use of the window when there's room (big
                      diffs are useful to read) but doesn't shove the
                      chat fully off-screen on a small window. */}
                <div className="border-t border-card-strong/60 p-3 max-h-[70vh] overflow-auto">
                  {artifact.kind === 'markdown' ? (
                    <div className="text-sm">
                      {/* `onOpenPath` lets the markdown's recognized
                          file-path spans (e.g. `src/renderer/store.ts`)
                          open in the file editor on click — same wiring
                          AssistantBubble + ReviewCard use. */}
                      <Markdown source={artifact.body} onOpenPath={(p) => openFile(p)} />
                    </div>
                  ) : artifact.kind === 'diff' ? (
                    <pre className="text-xs font-mono whitespace-pre">{colorizeDiff(artifact.body)}</pre>
                  ) : artifact.kind === 'url' ? (
                    (() => {
                      const raw = artifact.body.trim();
                      const safe = safeWebUrl(raw);
                      return safe ? (
                        <a
                          href={safe}
                          onClick={(e) => {
                            e.preventDefault();
                            void window.overcli.invoke('app:openExternal', safe);
                          }}
                          className="text-sm text-accent hover:underline break-all"
                        >
                          {raw}
                        </a>
                      ) : (
                        <span className="text-sm break-all">{raw}</span>
                      );
                    })()
                  ) : (
                    <pre className="text-xs font-mono whitespace-pre-wrap">{artifact.body}</pre>
                  )}
                </div>
                </>
              )}
            </div>
          );
        })}
        </div>
        )}
      </div>
    </div>
  );
}

// Count files / added / removed lines in a diff body. Returns null when
// the body doesn't look like a diff at all so the caller can skip the
// summary chip.
function computeDiffStats(
  body: string,
): { files: number; added: number; removed: number } | null {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('--- ')) files += 1;
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  if (files === 0 && added === 0 && removed === 0) return null;
  return { files, added, removed };
}

// Compute a short "what changed" summary for an artifact. For diffs,
// extract file count + added/removed line counts. For markdown, the
// first heading. For text/url, nothing; just show the size.
function summarizeArtifact(
  artifact: import('@shared/flows/schema').FlowArtifact,
): string | null {
  if (artifact.kind === 'diff') {
    const s = computeDiffStats(artifact.body);
    if (!s) return null;
    return `${s.files || '?'} file${s.files === 1 ? '' : 's'} · +${s.added} / −${s.removed}`;
  }
  if (artifact.kind === 'markdown') {
    const m = artifact.body.match(/^#+\s+(.+)$/m);
    return m ? `“${m[1].trim().slice(0, 60)}”` : null;
  }
  return null;
}

// Aggregate +/- line counts across every diff artifact in a run. The scan
// splits every diff body line-by-line, so on a run with large diffs it's
// real work — and it's hit twice in the header (chip + sheet) plus on every
// re-render (step clicks, watch ticks, local state). Cache the result against
// the `artifacts` object: that reference is stable until the run next updates,
// so rapid flow switching and incidental re-renders read the cached totals
// instead of re-scanning thousands of diff lines on the main thread.
const aggregateDiffStatsCache = new WeakMap<
  object,
  { files: number; added: number; removed: number } | null
>();
function aggregateDiffStats(
  run: FlowRun,
): { files: number; added: number; removed: number } | null {
  const cached = aggregateDiffStatsCache.get(run.artifacts);
  if (cached !== undefined) return cached;
  let files = 0;
  let added = 0;
  let removed = 0;
  let any = false;
  for (const art of Object.values(run.artifacts)) {
    if (art.kind !== 'diff') continue;
    const s = computeDiffStats(art.body);
    if (!s) continue;
    files += s.files;
    added += s.added;
    removed += s.removed;
    any = true;
  }
  const result = any ? { files, added, removed } : null;
  aggregateDiffStatsCache.set(run.artifacts, result);
  return result;
}

// Aggregate +/- line counts across every diff artifact the run has
// produced, surfaced as a compact `+X / −Y · N files` chip in the header.
// Clicking opens a full-screen viewer so the user can read the actual
// diff without scrolling through the participant's artifacts panel.
function RunDiffStats({ run, onOpen }: { run: FlowRun; onOpen: () => void }) {
  const stats = aggregateDiffStats(run);
  if (!stats) return null;
  const { files, added, removed } = stats;
  return (
    <button
      onClick={onOpen}
      className="ml-1 inline-flex items-center gap-1.5 text-[11px] font-mono px-1.5 py-0.5 rounded hover:bg-card-strong transition"
      title="Click to view the diff"
    >
      <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      <span className="text-ink-faint">/</span>
      <span className="text-red-700 dark:text-red-300">−{removed}</span>
      {files > 0 && (
        <span className="text-ink-faint">
          · {files} file{files === 1 ? '' : 's'}
        </span>
      )}
    </button>
  );
}

// Modal viewer for a run's diff artifacts. Lists every artifact whose
// kind is `diff`, concatenated with headers, so a multi-step flow that
// writes several diffs can be read in one place. Reuses `colorizeDiff`
// for +/-/@@ coloring.
function DiffSheet({ run, onClose }: { run: FlowRun; onClose: () => void }) {
  // Show each step's OWN diff (its incremental change), pulled from the
  // latest successful attempt per step. Dedupe byte-identical bodies as a
  // safety net so a step that left the worktree unchanged — or an older
  // run that stored cumulative diffs under one name — doesn't render the
  // same blob twice. Falls back to the name-keyed map for older runs that
  // predate per-attempt artifacts.
  const diffs = useMemo(() => {
    const byStep = new Map<string, FlowArtifact>();
    for (const a of run.attempts) {
      if (a.outcome === 'success' && a.artifact?.kind === 'diff') {
        byStep.set(a.stepId, a.artifact); // later attempts overwrite earlier
      }
    }
    let list: FlowArtifact[] =
      byStep.size > 0
        ? [...byStep.values()]
        : Object.values(run.artifacts).filter((a) => a.kind === 'diff');
    const seen = new Set<string>();
    return list.filter((art) => {
      const key = art.body.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [run.attempts, run.artifacts]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[1100px] max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-3 border-b border-card">
          <div className="text-sm font-semibold">Diff</div>
          <RunDiffStatsInline run={run} />
          <button
            onClick={onClose}
            className="ml-auto text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {diffs.length === 0 ? (
            <div className="text-sm text-ink-muted">No diff artifacts in this run.</div>
          ) : (
            diffs.map((art) => (
              <div key={art.name} className="rounded-md border border-card-strong bg-card/30 overflow-hidden">
                <div className="px-3 py-1.5 text-[11px] text-ink-faint border-b border-card-strong/60 flex items-center gap-2">
                  <span className="font-mono text-ink">{art.name}</span>
                  <span>· from {art.producedByStepId}</span>
                  <span>· {art.body.length.toLocaleString()} chars</span>
                </div>
                <pre className="text-xs font-mono whitespace-pre p-3 overflow-x-auto">
                  {colorizeDiff(art.body)}
                </pre>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Non-clickable inline rendering of the same +/- stats. Used inside the
// DiffSheet header so the totals stay visible without an infinite
// click-loop back into the sheet.
function RunDiffStatsInline({ run }: { run: FlowRun }) {
  const stats = aggregateDiffStats(run);
  const { files, added, removed } = stats ?? { files: 0, added: 0, removed: 0 };
  return (
    <span className="text-[11px] font-mono">
      <span className="text-emerald-700 dark:text-emerald-300">+{added}</span>
      <span className="text-ink-faint">/</span>
      <span className="text-red-700 dark:text-red-300">−{removed}</span>
      {files > 0 && (
        <span className="text-ink-faint"> · {files} file{files === 1 ? '' : 's'}</span>
      )}
    </span>
  );
}

// Lightweight diff renderer: colorize +/-/@@ lines via JSX nodes so
// the rendered output isn't a wall of grey monospace. Returns an
// element instead of a string so React can apply per-line classes.
/// Return `raw` only if it's a plain web/mail/tel URL, else null. A `url`
/// artifact body is model-controlled, so we must not put an arbitrary
/// scheme (file:, javascript:, slack://) into an <a href>: the onClick →
/// app:openExternal path is validated in main, but a cmd/middle-click
/// bypasses onClick and lets Electron navigate the href directly. Mirrors
/// the main-process isSafeExternalUrl allowlist.
function safeWebUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ||
      u.protocol === 'http:' ||
      u.protocol === 'mailto:' ||
      u.protocol === 'tel:'
      ? raw
      : null;
  } catch {
    return null;
  }
}

function colorizeDiff(body: string): React.ReactNode {
  return body.split('\n').map((line, i) => {
    let cls = 'text-ink';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-ink-muted';
    else if (line.startsWith('+')) cls = 'text-emerald-700 dark:text-emerald-300';
    else if (line.startsWith('-')) cls = 'text-red-700 dark:text-red-300';
    else if (line.startsWith('@@')) cls = 'text-sky-700 dark:text-sky-300';
    else if (line.startsWith('diff --git ')) cls = 'text-amber-700 dark:text-amber-300';
    return (
      <div key={i} className={cls}>
        {line || ' '}
      </div>
    );
  });
}

// Hijack composer: sends turns directly to the participant's
// conversation, independent of step orchestration. Use cases: ask the
// planner why it chose X, redirect the implementer mid-flight, or fork
// into a different direction. The runtime ignores hijack turns for
// step-completion detection, so this won't accidentally advance the
// flow.
function HijackComposer({
  run,
  participant,
  convId,
}: {
  run: FlowRun;
  participant: FlowParticipant;
  convId: string | undefined;
}) {
  // Narrow subscription: the composer only needs `isRunning` for the
  // send/stop toggle. Reading the full runner here would re-render the
  // composer on every streamed event (and the composer's `onSend`
  // closure would change too, dragging Composer along with it). Event
  // count for the git probe below is read with a tight selector so the
  // probe deps only fire when the count actually changes.
  const isRunning = useRunnerIsRunning(convId ?? '');
  const [changes, setChanges] = useState<FileChangeSummary[]>([]);

  // A flow's cwd can be one of three things — a project path, a fresh
  // worktree, or a workspace's symlink root that fans out to multiple
  // member projects. Workspace roots aren't git repos themselves, so
  // `git:commitStatus` returns `isRepo: false` and we miss every change
  // the model made in member repos. We aggregate via
  // `git:workspaceCommitStatus` (prefixes paths with `name/`) in two
  // workspace cases:
  //   - In-place workspace run: probe each member's MAIN checkout (the
  //     cwd IS the workspace rootPath).
  //   - Worktree workspace run: the cwd is a coordinator symlink root
  //     (not the workspace rootPath, so the store lookup misses), and the
  //     changes live in the per-member MINTED worktrees — probe those
  //     directly off `run.workspaceWorktrees`.
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const workspaceProjects = useMemo(() => {
    if (run.workspaceWorktrees && run.workspaceWorktrees.length > 0) {
      return run.workspaceWorktrees.map((w) => ({ name: w.name, path: w.worktreePath }));
    }
    const ws = workspaces.find((w) => w.rootPath === run.projectPath);
    if (!ws) return null;
    const projs = ws.projectIds
      .map((pid) => projects.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
      .map((p) => ({ name: p.name, path: p.path }));
    return workspaceSymlinkNames(projs);
  }, [workspaces, projects, run.projectPath, run.workspaceWorktrees]);

  // Re-probe the working tree whenever a step attempt finishes or the
  // runner flips running/idle. Mirrors how ConversationPane keeps its
  // ChangesBar in sync via `refreshGitStatus`, but scoped to the flow's
  // cwd since flow conversations aren't in the main gitStatusByConv
  // index. We deliberately do NOT depend on event count here — that
  // would re-render the composer on every streamed event and make
  // typing feel laggy. Attempt boundaries + the running-flip are when
  // diffs actually land anyway.
  const attemptCount = run.attempts.length;
  useEffect(() => {
    let cancelled = false;
    const probe = workspaceProjects
      ? window.overcli.invoke('git:workspaceCommitStatus', { projects: workspaceProjects })
      : window.overcli.invoke('git:commitStatus', { cwd: run.projectPath });
    void probe
      .then((res) => {
        if (cancelled) return;
        if (!res.isRepo) {
          setChanges([]);
          return;
        }
        setChanges(res.changes ?? []);
      })
      .catch(() => {
        if (!cancelled) setChanges([]);
      });
    return () => {
      cancelled = true;
    };
  }, [run.projectPath, workspaceProjects, attemptCount, isRunning]);

  // Pull the draft setters so we can clear the composer immediately
  // after a send. The shared `store.send` action does this for the
  // regular chat path; here we go straight to the `runner:send` IPC, so
  // we have to clear the draft + attachments ourselves — otherwise the
  // user's just-typed text stays in the box and they can accidentally
  // resubmit it on the next Enter.
  const setDraft = useStore((s) => s.setDraft);
  const clearAttachments = useStore((s) => s.clearAttachments);
  const stop = useStore((s) => s.stop);
  const draftKey = `flow-hijack:${run.id}:${participant.id}`;

  // Per-participant model override, persisted on the run. Lets the user
  // bump from a struggling small model to a stronger one mid-run — it
  // drives orchestration AND these hijack turns. Falls back to the
  // participant's declared model.
  const modelOverride = useFlowsStore((s) => s.runs[run.id]?.modelOverrides?.[participant.id]);
  const effectiveModel = modelOverride ?? participant.model;

  const handleSend = (prompt: string, attachments: Attachment[]) => {
    // Mint a conv id if this participant hasn't been used yet so the
    // first hijack message actually starts a session.
    const id = convId ?? cryptoRandomUuid();
    if (!convId) {
      // We can't write to run.conversationIds directly from the renderer;
      // it'll get synced once a real flow event arrives. For now the
      // local runner store handles per-conv state by id.
    }
    void window.overcli.invoke('runner:send', {
      conversationId: id,
      prompt,
      backend: participant.backend,
      cwd: run.projectPath,
      model: effectiveModel,
      // Hijack turns inherit the run's default permission — bypass for
      // worker/primary participants that need write access, default
      // otherwise. The user can be more conservative by adjusting
      // settings; runtime's preflight already gated the run.
      permissionMode: 'bypassPermissions',
      attachments,
    });
    setDraft(draftKey, '');
    clearAttachments(draftKey);
  };

  // Padding + chrome mirror ConversationPane's composer wrapper
  // (`px-4 pb-3 pt-1 flex flex-col gap-1.5`, no top border) so the
  // ChangesBar + Composer + StatsFooter stack reads the same as the
  // regular chat instead of feeling smushed against the bottom edge.
  return (
    <div className="px-4 pb-3 pt-1 flex flex-col gap-1.5">
      {/* Pinned "it's working…" strip — same component ConversationPane
          mounts above its composer. The flow pane renders ChatView
          directly (not via ConversationPane), so without this the live
          Thinking/Working/Reading… cue never shows while a step runs. */}
      {convId && <RunningIndicator conversationId={convId} />}
      <ChangesBar files={changes} />
      <Composer
        draftKey={draftKey}
        historyConvId={convId}
        onSend={handleSend}
        onStop={() => {
          if (convId) void stop(convId);
        }}
        isRunning={isRunning}
        variant="compact"
        placeholder={`Ask ${friendlyModelLabel(participant.backend, effectiveModel)} anything — your messages don't advance the flow.`}
      />
      <FlowStatsFooter
        convId={convId}
        fallbackModel={`${participant.backend}:${effectiveModel}`}
      />
    </div>
  );
}

// Compact backend+model picker for a participant. Upgrading here applies
// to EVERYTHING the participant does for the rest of the run —
// orchestration, the finalize turn, answering questions, and hijack chat
// — and persists across restart (the override lives on the run). The
// picker is limited to supported models so the run can't be pointed at a
// model the CLI won't actually accept.
function HijackModelPicker({
  runId,
  participant,
}: {
  runId: string;
  participant: FlowParticipant;
}) {
  const setOverride = useFlowsStore((s) => s.setParticipantModelOverride);
  const override = useFlowsStore((s) => s.runs[runId]?.modelOverrides?.[participant.id]) ?? null;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const effective = override ?? participant.model;
  const upgraded = override != null && override !== participant.model;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const presets =
    participant.backend === 'ollama'
      ? []
      : PREMIUM_MODELS[participant.backend as Exclude<typeof participant.backend, 'ollama'>] ?? [];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition ' +
          (upgraded
            ? 'border-accent/25 bg-accent/[0.08] text-ink hover:bg-accent/[0.14]'
            : 'border-card/60 bg-card/20 text-ink-muted hover:bg-card/40 hover:text-ink')
        }
        title={`${participant.name} is running ${friendlyModelLabel(participant.backend, effective)}` +
          (upgraded ? ` (overrides ${friendlyModelLabel(participant.backend, participant.model)})` : '')}
      >
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Model</span>
        <span className="font-mono">{friendlyModelLabel(participant.backend, effective)}</span>
        {upgraded && <span className="text-accent text-[10px]">↑</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[280px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">
            Override model for this participant
          </div>
          {presets.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {presets.map((m) => {
                const isCurrent = m === effective;
                const isDeclared = m === participant.model;
                return (
                  <button
                    key={m}
                    onClick={() => {
                      void setOverride(runId, participant.id, isDeclared ? null : m);
                      setOpen(false);
                    }}
                    className={
                      'text-left px-2 py-1 rounded font-mono text-[11px] flex items-center justify-between ' +
                      (isCurrent
                        ? 'bg-accent/15 text-ink'
                        : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                    }
                  >
                    <span>{friendlyModelLabel(participant.backend, m)}</span>
                    {isDeclared && <span className="text-[9px] text-ink-faint">declared</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="text-[10px] uppercase tracking-wider text-ink-faint mt-1">Custom</div>
          <div className="px-2 py-1 text-[10px] text-ink-faint">
            Manual model overrides are disabled. Pick a supported model above.
          </div>
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-ink-faint">
              Drives every turn this participant runs from here on
              (orchestration, questions, chat). Declared model:{' '}
              <span className="font-mono">{participant.model}</span>.
            </span>
            {upgraded && (
              <button
                onClick={() => {
                  void setOverride(runId, participant.id, null);
                  setOpen(false);
                }}
                className="text-accent hover:underline whitespace-nowrap ml-2"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Flow-pane equivalent of StatsFooter — the regular one reads from
// `useConversation(convId)`, but flow conversations aren't in the main
// store's conversation index so that lookup returns null. Read the
// same numbers off the runner store instead: turns from `localUser`
// events, model from `currentModel`, sessionId from the most recent
// `systemInit` event (Claude/Codex both emit one per subprocess).
function FlowStatsFooter({
  convId,
  fallbackModel,
}: {
  convId: string | undefined;
  fallbackModel: string;
}) {
  // Subscribe to the runner here, not in the parent HijackComposer.
  // Streamed events update the runner on every chunk; keeping that
  // subscription isolated to this small footer means the composer
  // (and its `onSend` closure) stays stable while a step is running.
  const runner = useRunner(convId ?? '');
  if (!runner) return null;
  let turns = 0;
  let sessionId: string | null = null;
  for (const ev of runner.events) {
    if (ev.kind.type === 'localUser') turns += 1;
    else if (ev.kind.type === 'systemInit') sessionId = ev.kind.info.sessionId;
  }
  const model = runner.currentModel || fallbackModel;
  return (
    <div className="flex items-center gap-2 text-[10px] text-ink-faint px-2">
      <span>
        {turns} turn{turns === 1 ? '' : 's'}
      </span>
      {model && <span>· {model}</span>}
      {sessionId && <span className="truncate">· {sessionId.slice(0, 8)}</span>}
    </div>
  );
}

function cryptoRandomUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Cheap fallback so tests don't depend on the crypto API.
  return 'tmp-' + Math.random().toString(36).slice(2);
}

// The original prompt rendered as a slim, collapsible card. Visual
// language matches the WelcomePane flow cards — rounded surface with
// `bg-surface-elevated`, a ring border, and a soft drop shadow for
// depth — but a thinner, single-line resting state with a chevron to
// expand. The focused step's metadata sits below the card as a quiet
// caption.
function RunPromptSubtitle({
  prompt,
  activeStep,
  run,
  activeParticipant,
  activeStepId,
}: {
  prompt: string;
  activeStep: FlowStep | null;
  run: FlowRun;
  activeParticipant: FlowParticipant | null;
  activeStepId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const roleBlurb = activeStep ? ROLE_DESCRIPTIONS[activeStep.role] ?? null : null;
  // Steps the active participant owns, in order — relocated here from the
  // body so the "which steps this thread covers" info sits next to the
  // produces/reads line rather than floating above the chat. Only shown
  // when the participant runs more than one step (otherwise the pipeline
  // up top already says it all).
  const ownedSteps = activeParticipant
    ? run.flowSnapshot.steps.filter((s) => s.participantId === activeParticipant.id)
    : [];
  const showStepChips = ownedSteps.length > 1;
  return (
    <div className="mt-2.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className={
          'group w-full text-left rounded-xl bg-surface-elevated ring-1 ring-card-strong ' +
          'shadow-[0_10px_30px_-18px_rgba(0,0,0,0.55),0_1px_0_0_rgba(255,255,255,0.03)_inset] ' +
          'px-3.5 py-2 transition-all duration-150 hover:ring-accent/40'
        }
        title={expanded ? 'Click to collapse' : 'Click to expand'}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={
              'flex-1 min-w-0 text-[13px] text-ink leading-snug ' +
              (expanded ? 'whitespace-pre-wrap' : 'truncate')
            }
          >
            {prompt}
          </div>
          <span
            aria-hidden
            className={
              'text-[10px] text-ink-faint group-hover:text-ink flex-shrink-0 transition-transform ' +
              (expanded ? 'rotate-180' : '')
            }
          >
            ▾
          </span>
        </div>
      </button>
      {activeStep && (
        <div className="mt-1.5 px-1 text-[11px] text-ink-faint flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent/70" />
            <span className="font-semibold text-ink-muted">{activeStep.id}</span>
          </span>
          <span className="text-ink-faint/60">·</span>
          <span className="font-mono text-ink-muted">{activeStep.role}</span>
          {roleBlurb && (
            <span className="text-ink-faint italic">— {roleBlurb}</span>
          )}
          <span className="text-ink-faint/60">·</span>
          <span>
            produces <span className="font-mono text-ink-muted">{activeStep.output}</span>
          </span>
          {activeStep.inputs.length > 0 && (
            <>
              <span className="text-ink-faint/60">·</span>
              <span>
                reads{' '}
                <span className="font-mono text-ink-muted">
                  {activeStep.inputs.join(', ')}
                </span>
              </span>
            </>
          )}
          {showStepChips && (
            <>
              <span className="text-ink-faint/60">·</span>
              <span className="uppercase tracking-wider text-[10px]">in thread</span>
              {ownedSteps.map((step) => {
                const attempts = run.attempts.filter((a) => a.stepId === step.id);
                const last = attempts[attempts.length - 1];
                const done = last?.outcome === 'success';
                const isCurrent = step.id === activeStepId;
                return (
                  <span
                    key={step.id}
                    className={
                      'px-1.5 py-0.5 rounded ' +
                      (isCurrent ? 'bg-accent/20 text-ink' : done ? 'text-ink-muted' : 'text-ink-faint')
                    }
                  >
                    {done && <span className="text-emerald-700 dark:text-emerald-300/80 mr-0.5">✓</span>}
                    {isCurrent && <span className="animate-pulse text-sky-700 dark:text-sky-300 mr-0.5">●</span>}
                    {step.id}
                  </span>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RunContextStrip({
  run,
  activeStep,
}: {
  run: FlowRun;
  activeStep: FlowStep | null;
}) {
  const [open, setOpen] = useState(true);
  const roleBlurb = activeStep ? ROLE_DESCRIPTIONS[activeStep.role] ?? null : null;
  return (
    <div className="border-b border-card bg-accent/[0.06] border-l-2 border-l-accent/60">
      {/* Accent-tinted strip with a left rail so the original prompt
          reads as the anchor for the whole run, not a passive subtitle.
          Visual weight is comparable to the pause banner but in the
          run's primary accent color rather than amber. */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-6 py-2.5 text-[11px] uppercase tracking-wider text-accent/90 hover:text-accent"
      >
        <span>{open ? '▼' : '▶'}</span>
        <span className="font-semibold">Original request</span>
        {!open && (
          <span className="ml-2 text-ink-muted normal-case tracking-normal truncate font-normal">
            “{run.userPrompt.slice(0, 100)}{run.userPrompt.length > 100 ? '…' : ''}”
          </span>
        )}
      </button>
      {open && (
        <div className="px-6 pb-4 space-y-2">
          {/* The prompt body: larger text, sits inside a card with a
              subtle quotation feel so it reads as the load-bearing
              piece of context for the whole run. */}
          <div className="relative rounded-lg bg-card/60 border border-card-strong px-4 py-3 text-[15px] whitespace-pre-wrap text-ink leading-relaxed shadow-sm">
            <span
              aria-hidden
              className="absolute -left-1 top-2 text-3xl text-accent/40 leading-none select-none font-serif"
            >
              “
            </span>
            <div className="pl-3">{run.userPrompt}</div>
          </div>
          {activeStep && (
            <div className="text-[11px] text-ink-muted">
              <span className="text-ink-faint">Step</span>{' '}
              <span className="font-semibold text-ink">{activeStep.id}</span>
              {' · '}
              <span className="text-ink-faint">role</span>{' '}
              <span className="font-mono text-ink">{activeStep.role}</span>
              {roleBlurb && <span className="text-ink-faint"> — {roleBlurb}</span>}
              {' · '}
              <span className="text-ink-faint">produces</span>{' '}
              <span className="font-mono text-ink">{activeStep.output}</span>
              {activeStep.inputs.length > 0 && (
                <>
                  {' · '}
                  <span className="text-ink-faint">reads</span>{' '}
                  <span className="font-mono text-ink">
                    {activeStep.inputs.join(', ')}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One-line summary of each preset role so the run pane can explain
// "what was this step tasked with" without dumping the full system
// prompt. Kept terse; full prompts live in roles.ts. Custom roles
// surface as "Custom prompt" since we have no canonical blurb.
const ROLE_DESCRIPTIONS: Record<string, string> = {
  planner: 'reads context, produces a concrete plan for downstream steps',
  'plan-reviewer': 'validates the plan before any code is written',
  implementer: 'executes a plan literally and surgically; minimal edits',
  reviewer: 'reads the plan + diff, decides if the work is correct',
  'test-writer': 'adds tests matching the project\'s existing style',
  researcher: 'gathers context, no code changes',
  shipper: 'commits, pushes, opens a PR',
  'technical-writer': 'drafts clear technical prose from inputs',
  editor: 'polishes a draft for accuracy and clarity',
  debugger: 'traces a symptom to its root cause',
  'code-reader': 'surveys how code works today, no changes',
  'code-reviewer': 'judges a code change for correctness and quality',
  'security-reviewer': 'audits for security issues with severities',
  'adversarial-reviewer': 'skeptically tries to break the work',
  custom: 'Custom prompt',
};

function PauseBanner({ run }: { run: FlowRun }) {
  // Local "click was just received" guard. The main process emits
  // pendingContinue asynchronously, so without this the banner can sit
  // unchanged for one round-trip after the click, looking unresponsive.
  const [clicked, setClicked] = useState(false);
  const continuing = !!run.pendingContinue;
  // Reset the local optimistic flag once the main process has either
  // confirmed via pendingContinue OR fully advanced (banner unmounts).
  useEffect(() => {
    if (continuing) setClicked(false);
  }, [continuing]);

  const nextStepId = run.state.kind === 'paused' ? run.state.nextStepId : null;
  const reason = run.state.kind === 'paused' ? run.state.reason : null;
  const nextStep = nextStepId
    ? run.flowSnapshot.steps.find((s) => s.id === nextStepId)
    : null;
  const nextModel = nextStep ? resolveRunStepModel(run, nextStep) : null;

  const inFlight = continuing || clicked;
  const priorOutput = run.pendingContinue?.priorOutput;

  return (
    <div className="px-6 py-3 border-b border-amber-400/30 bg-amber-400/5">
      <div className="flex items-start gap-3 max-w-[1200px] mx-auto">
        <div className="flex-1">
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-200 mb-0.5 flex items-center gap-2">
            {inFlight && (
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-full border-2 border-amber-500/40 border-t-amber-600 animate-spin"
              />
            )}
            {inFlight
              ? priorOutput
                ? `Continuing — finalizing ${priorOutput}…`
                : 'Continuing…'
              : reason === 'preStep'
                ? 'Paused before next step'
                : reason === 'interrupted'
                  ? 'Interrupted — resume to re-run this step'
                  : 'Paused — step needs attention'}
          </div>
          <div className="text-xs text-amber-700 dark:text-amber-100/80">
            {inFlight ? (
              <>
                Your Continue was received. The prior step's participant is
                re-emitting its <code className="text-amber-700 dark:text-amber-100">&lt;output&gt;</code> block
                to reflect your changes, then the next step will start.
              </>
            ) : reason === 'interrupted' ? (
              <>
                This run was still working on a step when the app last closed, so it
                couldn't continue on its own. Earlier steps' results are kept — resume to
                re-run <span className="font-semibold">{nextStep?.id ?? 'this step'}</span> from
                the start and roll forward.
              </>
            ) : (
              <>
                Talk to any participant below to redirect or get questions answered. When you continue,
                the prior step's latest <code className="text-amber-700 dark:text-amber-100">&lt;output&gt;</code> block
                becomes the artifact handed to the next step.
              </>
            )}
            {nextStep && nextModel && (
              <span className="block mt-1 text-amber-700 dark:text-amber-200/70">
                Next: <span className="font-semibold">{nextStep.id}</span>{' '}
                ({nextModel.backend}:{nextModel.model})
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => {
            if (inFlight) return;
            setClicked(true);
            void window.overcli.invoke('flows:resumeRun', { runId: run.id });
          }}
          disabled={inFlight}
          className={`text-xs px-3 py-1.5 rounded-md text-white flex items-center gap-1.5 ${
            inFlight
              ? 'bg-emerald-500/40 cursor-not-allowed'
              : 'bg-emerald-500/80 hover:bg-emerald-500'
          }`}
        >
          {inFlight && (
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin"
            />
          )}
          {inFlight ? 'Continuing…' : reason === 'interrupted' ? 'Re-run step →' : 'Continue →'}
        </button>
      </div>
    </div>
  );
}

function RunStateBadge({ state }: { state: { kind: string } }) {
  const label = state.kind;
  const cls =
    label === 'running'
      ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
      : label === 'paused'
        ? 'bg-amber-500/20 text-amber-700 dark:text-amber-300'
        : label === 'done'
          ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
          : label === 'watching'
            ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
            : label === 'archived'
              ? 'bg-card-strong text-ink-muted'
              : 'bg-red-500/20 text-red-700 dark:text-red-300';
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}

// Bucket every attempt's tokens by the speed tier of the model that ran
// it (thinking / standard / fast for catalog backends, local for Ollama).
// Replaced the dollar number because per-attempt `costUSD` is the CLI's
// cumulative-for-conv snapshot, so summing across attempts over-counts
// for participants that run multiple steps. Token counts are summed
// per-turn deltas in runtime.ts and are accurate.
//
// Finished attempts' usage lives on `run.attempts[i].usage`, but the
// runtime only writes that buffer to the run when the attempt ENDS —
// so a running step's tokens wouldn't show up until it completed. We
// supplement by reading live runner events for the in-progress attempt
// (events newer than `attempt.startedAt`) and adding their usage on top.
function RunTokenSummary({ run }: { run: FlowRun }) {
  const steps = run.flowSnapshot.steps;
  const participants = run.flowSnapshot.participants ?? [];
  const buckets = { frontier: 0, thinking: 0, standard: 0, fast: 0, local: 0 };

  const inProgress = run.attempts.find((a) => !a.endedAt);
  const liveRunner = useRunner(inProgress?.conversationId ?? '');

  function bucketFor(stepId: string): keyof typeof buckets {
    const step = steps.find((s) => s.id === stepId);
    const participant = step
      ? participants.find((p) => p.id === step.participantId)
      : undefined;
    if (!participant || participant.backend === 'ollama') return 'local';
    return modelSpeed(participant.model);
  }

  for (const a of run.attempts) {
    if (a === inProgress) continue;
    if (!a.usage) continue;
    buckets[bucketFor(a.stepId)] += a.usage.inputTokens + a.usage.outputTokens;
  }

  if (inProgress && liveRunner) {
    let live = 0;
    for (const ev of liveRunner.events) {
      if (ev.timestamp < inProgress.startedAt) continue;
      if (ev.reviewer) continue;
      if (ev.kind.type !== 'assistant') continue;
      if (ev.kind.info.isPartial) continue;
      if (ev.kind.info.usage) {
        live += ev.kind.info.usage.inputTokens + ev.kind.info.usage.outputTokens;
      }
    }
    buckets[bucketFor(inProgress.stepId)] += live;
  }
  const chips: Array<{
    key: keyof typeof buckets;
    label: string;
    cls: string;
  }> = [
    { key: 'frontier', label: 'frontier', cls: 'text-purple-700 dark:text-purple-300' },
    { key: 'thinking', label: 'thinking', cls: 'text-amber-700 dark:text-amber-300' },
    { key: 'standard', label: 'standard', cls: 'text-sky-700 dark:text-sky-300' },
    { key: 'fast', label: 'fast', cls: 'text-emerald-700 dark:text-emerald-300' },
    { key: 'local', label: 'local', cls: 'text-ink-faint' },
  ];
  const visible = chips.filter((c) => buckets[c.key] > 0);
  if (visible.length === 0) return null;
  return (
    <span
      className="ml-2 inline-flex items-center gap-2 text-[11px] font-medium"
      title={
        'Tokens by model tier (input + output):\n' +
        visible
          .map((c) => `  ${c.label}: ${buckets[c.key].toLocaleString()}`)
          .join('\n')
      }
    >
      {visible.map((c) => (
        <span key={c.key} className={c.cls}>
          {formatTokens(buckets[c.key])} {c.label}
        </span>
      ))}
    </span>
  );
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

// Re-exported types referenced by sibling components in this folder.
export type { FlowStepAttempt };
