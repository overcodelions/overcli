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
import { Composer } from '../Composer';
import { Markdown } from '../Markdown';
import { ChangesBar, type FileChangeSummary } from '../ChangesBar';
import { workspaceSymlinkNames } from '@shared/workspaceNames';
import type { Attachment } from '@shared/types';
import {
  resolveStepModel,
  type FlowArtifact,
  type FlowParticipant,
  type FlowRun,
  type FlowStep,
  type FlowStepAttempt,
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
  const [diffSheetOpen, setDiffSheetOpen] = useState(false);

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
      <div className="px-6 py-4 border-b border-card">
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
          <div className="flex-1 min-w-0 overflow-x-auto">
            <InlineStepPipeline
              run={run}
              activeStepId={activeStepId}
              onPick={setFocusStepId}
            />
          </div>
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
        {/* Original prompt as subtitle. Sits directly under the flow
            name, treats the user's words as the run's identity. */}
        <RunPromptSubtitle prompt={run.userPrompt} activeStep={activeStep} />
      </div>

      {/* Pause banner */}
      {run.state.kind === 'paused' && (
        <PauseBanner run={run} />
      )}

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
  // Steps this participant owns, in order. The "in-thread" strip only
  // matters when the same participant runs more than one step (where
  // the persistent conv blends multiple steps' contributions).
  const ownedSteps = useMemo(
    () => run.flowSnapshot.steps.filter((s) => s.participantId === participant.id),
    [run.flowSnapshot.steps, participant.id],
  );
  const showStrip = ownedSteps.length > 1;
  const st = run.state;
  const currentStepId =
    st.kind === 'running' ? st.currentStepId : st.kind === 'paused' ? st.nextStepId : focusStepId;

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
      {showStrip && (
        <div className="px-4 py-1.5 border-b border-card text-[11px] text-ink-faint flex items-center gap-1.5 flex-wrap">
          <span className="uppercase tracking-wider mr-1">Steps in this thread</span>
          {ownedSteps.map((step) => {
            const attempts = run.attempts.filter((a) => a.stepId === step.id);
            const last = attempts[attempts.length - 1];
            const done = last?.outcome === 'success';
            const isCurrent = step.id === currentStepId;
            return (
              <span
                key={step.id}
                className={
                  'px-1.5 py-0.5 rounded ' +
                  (isCurrent
                    ? 'bg-accent/20 text-ink'
                    : done
                      ? 'text-ink-muted'
                      : 'text-ink-faint')
                }
              >
                {done && <span className="text-emerald-700 dark:text-emerald-300/80 mr-0.5">✓</span>}
                {isCurrent && <span className="animate-pulse text-sky-700 dark:text-sky-300 mr-0.5">●</span>}
                {step.id}
              </span>
            );
          })}
        </div>
      )}

      {/* Artifacts panel — collapsible "what this participant produced"
          summary. Shown above the chat so it's visible at a glance,
          even when the chat transcript is empty (e.g. after a restart
          when runnersStore lost its in-memory events). */}
      {producedArtifacts.length > 0 && (
        <ArtifactsPanel items={producedArtifacts} forceCollapsed={isTyping} />
      )}

      {/* ChatView's root uses `flex-1 min-h-0 flex flex-col`, so its
          immediate parent MUST be a column flex container — otherwise
          Virtuoso never gets a height and the chat renders blank. */}
      <div className="flex-1 min-h-0 flex flex-col">
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
  function toggle(key: string) {
    setOpenSet((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // summarizeArtifact iterates every line of a diff body, so caching the
  // result keyed on the (memoized) items array keeps the `forceCollapsed`
  // flip cheap when the user starts/stops typing.
  const summaries = useMemo(
    () => items.map(({ artifact }) => summarizeArtifact(artifact)),
    [items],
  );
  return (
    <div className="border-b border-card bg-card/20">
      <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-ink-faint">
        What this participant produced
      </div>
      <div className="px-4 pb-3 space-y-2">
        {items.map(({ step, artifact }, idx) => {
          const open = !forceCollapsed && openSet.has(step.id);
          const summary = summaries[idx];
          return (
            <div
              key={step.id}
              className="rounded-md border border-card-strong bg-card/40 overflow-hidden"
            >
              <button
                onClick={() => toggle(step.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02]"
              >
                <span className="text-[11px] text-ink-faint">{open ? '▼' : '▶'}</span>
                <span className="text-xs font-mono text-ink">{artifact.name}</span>
                <span className="text-[11px] text-ink-faint">
                  · from <span className="font-semibold">{step.id}</span> ·{' '}
                  {artifact.body.length.toLocaleString()} chars
                </span>
                {summary && (
                  <span className="ml-auto text-[11px] text-emerald-700 dark:text-emerald-300/80">{summary}</span>
                )}
              </button>
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

// Aggregate +/- line counts across every diff artifact the run has
// produced, surfaced as a compact `+X / −Y · N files` chip in the header.
// Clicking opens a full-screen viewer so the user can read the actual
// diff without scrolling through the participant's artifacts panel.
function RunDiffStats({ run, onOpen }: { run: FlowRun; onOpen: () => void }) {
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
  if (!any) return null;
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
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const art of Object.values(run.artifacts)) {
    if (art.kind !== 'diff') continue;
    const s = computeDiffStats(art.body);
    if (!s) continue;
    files += s.files;
    added += s.added;
    removed += s.removed;
  }
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

  // Hijack-only model override. Lets the user bump from a struggling
  // small model to a stronger one while talking the run home, without
  // re-running the flow. Falls back to the participant's declared model.
  const overrideKey = `${run.id}:${participant.id}`;
  const modelOverride = useFlowsStore((s) => s.hijackModelOverrides[overrideKey]);
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
      <ChangesBar files={changes} />
      <Composer
        draftKey={draftKey}
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

// Compact backend+model picker for hijack chat. The participant's
// declared model drives orchestration; this override only affects
// hijack turns through `runner:send`. Premium model ids come from
// the shared catalog; the input lets the user type any id (custom
// fine-tunes, local Ollama tags) too.
function HijackModelPicker({
  runId,
  participant,
}: {
  runId: string;
  participant: FlowParticipant;
}) {
  const setOverride = useFlowsStore((s) => s.setHijackModelOverride);
  const override = useFlowsStore((s) => s.hijackModelOverrides[`${runId}:${participant.id}`]) ?? null;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(override ?? participant.model);
  const ref = useRef<HTMLDivElement>(null);
  const effective = override ?? participant.model;
  const upgraded = override != null && override !== participant.model;

  useEffect(() => {
    setDraft(override ?? participant.model);
  }, [override, participant.model]);

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
        title={`Hijack chat is using ${friendlyModelLabel(participant.backend, effective)}` +
          (upgraded ? ` (overrides ${friendlyModelLabel(participant.backend, participant.model)})` : '')}
      >
        <span className="text-[10px] uppercase tracking-wider text-ink-faint">Model</span>
        <span className="font-mono">{friendlyModelLabel(participant.backend, effective)}</span>
        {upgraded && <span className="text-accent text-[10px]">↑</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[280px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-ink-faint">
            Override model for this chat
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
                      setOverride(runId, participant.id, isDeclared ? null : m);
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
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const trimmed = draft.trim();
                setOverride(runId, participant.id, !trimmed || trimmed === participant.model ? null : trimmed);
                setOpen(false);
              }
            }}
            placeholder={participant.model}
            className="field px-2 py-1 font-mono text-[11px]"
          />
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-ink-faint">
              Only affects your chat. Step orchestration still uses{' '}
              <span className="font-mono">{participant.model}</span>.
            </span>
            {upgraded && (
              <button
                onClick={() => {
                  setOverride(runId, participant.id, null);
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
}: {
  prompt: string;
  activeStep: FlowStep | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const roleBlurb = activeStep ? ROLE_DESCRIPTIONS[activeStep.role] ?? null : null;
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
  custom: 'Custom prompt',
};

function PauseBanner({ run }: { run: FlowRun }) {
  const nextStepId = run.state.kind === 'paused' ? run.state.nextStepId : null;
  const reason = run.state.kind === 'paused' ? run.state.reason : null;
  const nextStep = nextStepId
    ? run.flowSnapshot.steps.find((s) => s.id === nextStepId)
    : null;
  const nextModel = nextStep ? resolveStepModel(run.flowSnapshot, nextStep) : null;

  return (
    <div className="px-6 py-3 border-b border-amber-400/30 bg-amber-400/5">
      <div className="flex items-start gap-3 max-w-[1200px] mx-auto">
        <div className="flex-1">
          <div className="text-sm font-semibold text-amber-700 dark:text-amber-200 mb-0.5">
            {reason === 'preStep' ? 'Paused before next step' : 'Paused — step needs attention'}
          </div>
          <div className="text-xs text-amber-700 dark:text-amber-100/80">
            Talk to any participant below to redirect or get questions answered. When you continue,
            the prior step's latest <code className="text-amber-700 dark:text-amber-100">&lt;output&gt;</code> block
            becomes the artifact handed to the next step.
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
            void window.overcli.invoke('flows:resumeRun', { runId: run.id });
          }}
          className="text-xs px-3 py-1.5 rounded-md bg-emerald-500/80 text-white hover:bg-emerald-500"
        >
          Continue →
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
  const buckets = { thinking: 0, standard: 0, fast: 0, local: 0 };

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
