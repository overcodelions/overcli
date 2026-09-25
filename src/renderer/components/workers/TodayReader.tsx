// The Today page's reader: one pane on the right for whatever you opened.
//
// A finished job opens on its RESULT — the deliverable itself, rendered — with
// a box to ask its worker about it. A job waiting on you opens on the
// DECISION — the question with an answer box, or the checkpoint with what it
// did and what it changed. Either way the whole run is one switch away, drawn
// in this same pane, so going deeper never loses your place in the day.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useRunnersStore } from '../../runnersStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { FilePreview } from '../FilePreview';
import { UserBubble } from '../UserBubble';
import { WorkerReply } from './WorkerReply';
import { WorkerErrandComposer } from './WorkerDesk';
import { useOrchestratorStore } from '../../orchestratorStore';
import { producerProse } from './workerDeskSelectors';
import { sendParticipantTurn } from '../flows/participantTurn';
import { FlowRunPane } from '../flows/FlowRunPane';
import { AnswerBox, CheckpointReview, SectionLabel } from './NowSection';
import { PausedActions } from './PausedActions';
import { WorkerAvatar } from './WorkerAvatar';
import type { DigestSummary } from './digestSummary';
import {
  currentConversationId,
  elapsedLabel,
  lastTalkedStep,
  latestExchange,
  workerDecisions,
  latestSaid,
  talkedSincePause,
  waitingLine,
} from './nowCards';
import { clockStamp } from './todaySpine';
import { finalArtifactText } from './useDigest';
import type { QueueRow } from './workQueue';
import { baseName } from './workQueue';
import type { ArtifactPreviewResult } from '@shared/types';
import type { FlowRun, FlowWorkerExchange } from '@shared/flows/schema';
import type { WorkerFile } from './workerDeskSelectors';

/// Which tab you last picked for each item, for this session. Module-level
/// rather than component state because leaving the Workers tab unmounts the
/// reader, and the point is to come back to the same place.
const tabMemory = new Map<string, 'result' | 'run'>();

export function TodayReader({
  row,
  kind,
  file,
  digest,
  now,
}: {
  row: QueueRow;
  kind: 'needs' | 'done';
  file: WorkerFile | null;
  digest: DigestSummary | undefined;
  now: number;
}) {
  const [tab, setTab] = useState<'result' | 'run'>(() => tabMemory.get(row.key) ?? 'result');
  // A tab you picked is remembered for the item, so going to Chat and back —
  // which draws this page from scratch — lands you where you were.
  const chooseTab = (t: 'result' | 'run') => {
    tabMemory.set(row.key, t);
    setTab(t);
  };
  // The step the Run tab opens on, when you just spoke to one.
  const [runStep, setRunStep] = useState<string | undefined>(undefined);
  const run = useFlowsStore((s) => (row.runId ? s.runs[row.runId] : undefined));
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  // Where you left off in this run, if you have talked to it since it
  // stopped: that conversation is the decision in progress, so the reader
  // opens on it rather than on the output recorded before it.
  const talked = kind === 'needs' && !!run && talkedSincePause(run);
  const talkedStep = useRunnersStore((s) =>
    talked && run
      ? lastTalkedStep(run, (c) => {
          const events = s.runners[c]?.events;
          return events && events.length > 0 ? events[events.length - 1].timestamp : 0;
        }) ?? stepBeforePause(run)
      : undefined,
  );
  // A different item starts on its result — or, mid-conversation, on it.
  useEffect(() => {
    const remembered = tabMemory.get(row.key);
    if (remembered) {
      setTab(remembered);
      setRunStep(undefined);
      return;
    }
    if (talked && talkedStep) {
      setTab('run');
      setRunStep(talkedStep);
    } else if (kind === 'done' && row.runId && (row.status === 'running' || row.status === 'responding')) {
      // Still working: there is no result yet, so watch it work.
      setTab('run');
      setRunStep(undefined);
    } else {
      setTab('result');
      setRunStep(undefined);
    }
    // Only when the item changes: after that, the tabs are yours.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.key]);

  // The Run tab is the run pane, so the app has to know which run is open:
  // the side editor roots itself at the active run's worktree, and without
  // it a changed file opened from here resolved — and diffed — against the
  // wrong checkout. It also folds the sidebar away (see App) while you work
  // in the run, and hands both back when you leave the tab.
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const runOnScreen = tab === 'run' && row.runId ? row.runId : null;
  // A layout effect, so the store knows before the first paint: arriving on
  // a Run tab used to draw one frame WITH the sidebar and then slide it away.
  useLayoutEffect(() => {
    if (!runOnScreen) return;
    setActiveRun(runOnScreen);
    return () => {
      if (useFlowsStore.getState().activeRunId === runOnScreen) setActiveRun(null);
    };
  }, [runOnScreen, setActiveRun]);

  const live = row.status === 'running' || row.status === 'planning';
  return (
    <article
      aria-label={row.title}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-card"
      style={{ background: 'color-mix(in srgb, var(--c-ink) 2%, var(--c-surface))' }}
    >
      <div className="flex shrink-0 items-center gap-2.5 border-b border-card px-7 py-3">
        {worker && <WorkerAvatar worker={worker} size="xs" />}
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
          <span className="font-medium text-ink">{row.workerName}</span>
          {' · '}
          {kind === 'needs'
            ? `waiting ${elapsedLabel(now - row.at)}`
            : live
              ? `working · ${elapsedLabel(now - row.at)}`
              : clockStamp(row.at)}
          {row.flowName ? ` · ${row.flowName}` : ''}
        </span>
        {row.runId && run && (
          <div role="tablist" aria-label="Show" className="flex rounded-md border border-card-strong p-0.5">
            {(['result', 'run'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => chooseTab(t)}
                className={
                  'rounded px-2.5 py-0.5 text-[11.5px] ' +
                  (tab === t ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
                }
              >
                {t === 'result' ? (kind === 'needs' ? 'Decision' : live ? 'Now' : 'Result') : 'Run'}
              </button>
            ))}
          </div>
        )}

      </div>

      {tab === 'run' && row.runId ? (
        // The run itself, in place: steps, transcript and chat, without
        // leaving the day.
        <div className="flex min-h-0 flex-1 flex-col">
          <FlowRunPane
            key={`${row.runId}:${runStep ?? ''}`}
            runId={row.runId}
            initialStepId={runStep}
            // Reviewing a decision means reading the step's output beside
            // the conversation about it, so the output starts open.
            producedOpen={kind === 'needs'}
          />
        </div>
      ) : kind === 'needs' ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-6">
          {/* The pane's full width: a review is read, and a narrow column of
              it wasted half the screen beside it. */}
          <div className="flex flex-col gap-5">
            <Decision
              row={row}
              talkedStep={talked ? talkedStep : undefined}
              onTalked={(stepId) => {
                setRunStep(stepId);
                chooseTab('run');
              }}
            />
          </div>
        </div>
      ) : (
        <Result row={row} file={file} digest={digest} live={live} />
      )}
    </article>
  );
}

// ---- A job waiting on you --------------------------------------------------

function Decision({
  row,
  talkedStep,
  onTalked,
}: {
  row: QueueRow;
  /// Set when you have talked to the run since it stopped: the step you were
  /// last talking to.
  talkedStep?: string;
  onTalked: (stepId: string) => void;
}) {
  const run = useFlowsStore((s) => (row.runId ? s.runs[row.runId] : undefined));
  const convId = run ? currentConversationId(run) : undefined;
  const question = useRunnersStore((s) => (convId ? latestSaid(s.runners[convId]?.events, 1500) : ''));
  const step = row.steps.find((s) => s.state === 'current')?.id;
  const asked = row.pausedReason === 'needsInput';
  // The flow asks its worker first; when the worker could not settle it,
  // its reply — why it escalated — is the context you need to answer.
  const exchange = run ? latestExchange(run) : undefined;
  if (row.status === 'proposed') return <ProposalReview row={row} />;
  return (
    <>
      <h2 className="text-[21px] font-semibold leading-snug tracking-[-0.01em] text-ink">{row.title}</h2>
      {row.steps.length > 0 && <StepBar row={row} />}
      {talkedStep && (
        <div
          className="flex items-center gap-3 rounded-lg border px-4 py-3"
          style={{
            borderColor: 'color-mix(in srgb, var(--c-accent) 40%, var(--c-card-border))',
            background: 'color-mix(in srgb, var(--c-accent) 7%, var(--c-card))',
          }}
        >
          <p className="min-w-0 flex-1 text-[13px] leading-snug text-ink">
            You’ve been talking to <strong>{talkedStep}</strong> since it paused. When you continue, the next step gets a
            fresh output from that conversation — not the one recorded below.
          </p>
          <button
            onClick={() => onTalked(talkedStep)}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
          >
            Back to the conversation
          </button>
        </div>
      )}
      {asked ? (
        <>
          <QuestionThread
            row={row}
            question={exchange?.question || question || 'Open the run to read the question.'}
            exchange={exchange}
          />
          {row.runId && <AnswerBox runId={row.runId} />}
          {run && <TalkToStep run={run} asking onTalked={onTalked} />}
          {row.runId && (
            <div className="flex justify-end">
              <PausedActions row={row} tone="solid" rejectOnly />
            </div>
          )}
        </>
      ) : (
        <>
          <p className="text-[14px] leading-relaxed text-ink-muted">{waitingLine(row.pausedReason, step)}</p>
          {row.runId && (
            <div className="rounded-lg border border-card">
              <CheckpointReview row={row} runId={row.runId} onOpen={() => {}} hideOpenLink />
            </div>
          )}
          {run && <TalkToStep run={run} onTalked={onTalked} />}
          {row.runId && (
            <div className="flex">
              <PausedActions row={row} tone="solid" />
            </div>
          )}
        </>
      )}
    </>
  );
}

/// Work the worker suggested but did not start — held back for your say, so
/// there is no run to show yet. What you need to decide is why it wants to
/// and what it would do, then launch it or turn it down.
function ProposalReview({ row }: { row: QueueRow }) {
  const item = useOrchestratorStore((s) =>
    row.orchestrationId ? s.orchestrations[row.orchestrationId]?.items.find((i) => i.candidate.id === row.candidateId) : undefined,
  );
  const [busy, setBusy] = useState<'launch' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  const act = async (kind: 'launch' | 'reject') => {
    if (busy || !row.orchestrationId || !row.candidateId) return;
    setBusy(kind);
    setError(null);
    const id = row.orchestrationId;
    const candidateId = row.candidateId;
    try {
      const res =
        kind === 'launch'
          ? await window.overcli.invoke('orchestrator:approveBatch', { id, approve: [{ candidateId }], keepUnpicked: true })
          : await window.overcli.invoke('orchestrator:rejectItem', { id, candidateId });
      if (!res.ok) setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const why = item?.candidate.note;
  const prompt = item?.candidate.prompt;
  return (
    <>
      <h2 className="text-[21px] font-semibold leading-snug tracking-[-0.01em] text-ink">{row.title}</h2>
      <p className="text-[14px] leading-relaxed text-ink-muted">
        {row.workerName} proposed this and is waiting for you to launch it — nothing has run yet.
        {item?.note ? ` ${item.note}` : ''}
      </p>
      {why && (
        <section className="flex flex-col gap-1.5">
          <SectionLabel>Why</SectionLabel>
          <p className="text-[13.5px] leading-relaxed text-ink">{why}</p>
        </section>
      )}
      {prompt && (
        <section className="flex flex-col gap-1.5">
          <SectionLabel>What it will do{item?.flowId ? ` · ${item.flowId}` : ''}</SectionLabel>
          <div className="rounded-lg border border-card bg-card px-4 py-3">
            <p
              className={
                'whitespace-pre-wrap text-[13px] leading-relaxed text-ink ' + (showPrompt ? '' : 'line-clamp-6')
              }
            >
              {prompt}
            </p>
            <button
              onClick={() => setShowPrompt((v) => !v)}
              className="mt-1.5 text-[12px] text-accent hover:underline"
            >
              {showPrompt ? 'Show less' : 'Show all'}
            </button>
          </div>
        </section>
      )}
      <div className="flex items-center gap-2">
        <button
          disabled={!!busy}
          onClick={() => void act('launch')}
          className="rounded-md bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy === 'launch' ? 'Launching…' : 'Launch'}
        </button>
        <button
          disabled={!!busy}
          onClick={() => void act('reject')}
          className="rounded-md border border-card-strong px-3 py-1.5 text-[12.5px] text-ink-muted hover:border-red-400/60 hover:text-red-400 disabled:opacity-50"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        {error && <span className="text-[12px] text-red-400">{error}</span>}
      </div>
    </>
  );
}

/// The question as it travelled: the step asked the worker, and the worker
/// answered back to you — escalated, with its reasons, or failed. Without the
/// worker's half, the page showed only the step's raw question and hid the
/// judgement the worker had already made about it.
function QuestionThread({
  row,
  question,
  exchange,
}: {
  row: QueueRow;
  question: string;
  exchange: FlowWorkerExchange | undefined;
}) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const [full, setFull] = useState(false);
  const stepName = exchange?.stepId ?? row.steps.find((s) => s.state === 'current')?.id ?? 'The step';
  const workerSpoke = exchange && (exchange.status === 'escalated' || exchange.status === 'failed') && exchange.note;
  const long = question.length > 420;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <SectionLabel>{workerSpoke ? `${stepName} asked ${row.workerName}` : `${row.workerName} asked`}</SectionLabel>
        <p
          className={
            'mt-1.5 whitespace-pre-line text-[13.5px] leading-relaxed ' +
            (workerSpoke ? 'text-ink-muted' : 'text-ink') +
            (long && !full ? ' line-clamp-4' : '')
          }
        >
          {question}
        </p>
        {long && (
          <button onClick={() => setFull((f) => !f)} className="mt-1 text-[11.5px] text-accent hover:underline">
            {full ? 'Show less' : 'Show the whole question'}
          </button>
        )}
      </div>
      {workerSpoke && (
        <div
          className="flex gap-3 rounded-lg border px-4 py-3"
          style={{
            borderColor: 'color-mix(in srgb, #fbbf24 35%, var(--c-card-border))',
            background: 'color-mix(in srgb, #fbbf24 6%, var(--c-card))',
          }}
        >
          {worker && <WorkerAvatar worker={worker} size="xs" />}
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-500">
              {exchange.status === 'escalated'
                ? `${row.workerName} escalated this to you`
                : `${row.workerName} couldn’t answer it`}
            </div>
            <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-ink">{exchange.note}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/// Talk to a step before deciding: ask it why, push back, ask for a change.
/// The message goes into that step's own session and you land in its
/// conversation to read the reply and keep going. Nothing here advances the
/// run — when you continue, the step is asked for a fresh output that
/// reflects what you discussed.
function TalkToStep({
  run,
  asking = false,
  onTalked,
}: {
  run: FlowRun;
  /// A question is pending: the step that asked is the one to talk to.
  asking?: boolean;
  onTalked: (stepId: string) => void;
}) {
  const steps = run.flowSnapshot.steps;
  const nextId = run.state.kind === 'paused' ? run.state.nextStepId : undefined;
  const nextAt = steps.findIndex((s) => s.id === nextId);
  // The steps that have spoken — the only ones with a session to resume.
  const talkable = steps.filter((s) => run.attempts.some((a) => a.stepId === s.id));
  // A checkpoint is about the work before it, so the step that did that work
  // is who to ask; a question belongs to the step that asked it.
  const preferred = asking ? nextId : nextAt > 0 ? steps[nextAt - 1].id : nextId;
  const [stepId, setStepId] = useState<string>(
    talkable.find((s) => s.id === preferred)?.id ?? talkable[talkable.length - 1]?.id ?? '',
  );
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (talkable.length === 0) return null;
  const step = steps.find((s) => s.id === stepId);

  const submit = async () => {
    const message = text.trim();
    if (!message || !step || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendParticipantTurn({ run, participantId: step.participantId, prompt: message });
      setText('');
      onTalked(step.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <SectionLabel>Talk it through</SectionLabel>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`talk-step-${run.id}`}>
          Step to talk to
        </label>
        <select
          id={`talk-step-${run.id}`}
          value={stepId}
          onChange={(e) => setStepId(e.target.value)}
          className="shrink-0 rounded-md border border-card-strong bg-card px-2 py-2 text-[12.5px] text-ink"
        >
          {talkable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor={`talk-text-${run.id}`}>
          Message
        </label>
        <input
          id={`talk-text-${run.id}`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Ask ${stepId} why, push back, or ask for a change…`}
          className="min-w-0 flex-1 rounded-md border border-card-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-md border border-card-strong px-3.5 py-2 text-[12.5px] text-ink hover:bg-card-strong disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </div>
      <span className="text-[11px] text-ink-faint">
        Opens {stepId}’s conversation. Nothing advances until you continue — then it gives a fresh output that
        reflects what you discussed.
      </span>
      {error && <span className="text-[11px] text-red-500">{error}</span>}
    </form>
  );
}

// ---- A finished (or working) job ------------------------------------------

function Result({
  row,
  file,
  digest,
  live,
}: {
  row: QueueRow;
  file: WorkerFile | null;
  digest: DigestSummary | undefined;
  live: boolean;
}) {
  const openFile = useStore((s) => s.openFile);
  const run = useFlowsStore((s) => (row.runId ? s.runs[row.runId] : undefined));
  const [doc, setDoc] = useState<{ content: string; artifact: ArtifactPreviewResult | null } | null>(null);

  // The whole file, not a skim: this is the deliverable as it is meant to
  // be seen. Images and PDFs come as a preview artifact instead of text.
  useEffect(() => {
    setDoc(null);
    if (!file) return;
    let cancelled = false;
    const binary = /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(file.name);
    void (async () => {
      const [text, artifact] = await Promise.all([
        binary ? Promise.resolve(null) : window.overcli.invoke('fs:readFile', { path: file.path }),
        binary ? window.overcli.invoke('fs:readArtifactPreview', { path: file.path }) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setDoc({ content: text && text.ok ? text.content : '', artifact });
    })();
    return () => {
      cancelled = true;
    };
  }, [file?.path, file?.modifiedAt]);

  const failed = row.status === 'failed';
  // No file: the run's final output is still the result, drawn the same way —
  // and a job answered in chat, which ran nothing, has its answer in the
  // worker's reply to you. Several answers grouped into one row read as one
  // page, each under its question.
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  // Questions answered in chat are a conversation, not a document: each is
  // drawn as what you asked and what the worker said back.
  const answers = useMemo(() => {
    if (file || run) return [];
    const entries = row.answers?.length
      ? [...row.answers].reverse() // oldest first: read it the way it happened
      : row.orchestrationId
        ? [{ key: row.key, title: row.title, at: row.at, orchestrationId: row.orchestrationId }]
        : [];
    return entries.flatMap((a) => {
      const o = a.orchestrationId ? orchestrations[a.orchestrationId] : undefined;
      if (!o) return [];
      const asked = o.origin?.kind === 'worker' && o.origin.errand ? o.origin.errand : a.title;
      return [{ key: a.key, asked, answer: producerProse(o), at: a.at, orchestrationId: o.id }];
    });
  }, [file, run, row.answers, row.orchestrationId, row.key, row.title, row.at, orchestrations]);
  const finalText = file ? '' : finalArtifactText(run);
  const previewPath = file ? file.path : 'result.md';
  const previewContent = file ? doc?.content ?? null : finalText;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-card px-8 pb-4 pt-5">
        <h2 className="text-[20px] font-semibold leading-snug tracking-[-0.01em] text-ink">
          {failed || live
            ? row.title
            : row.status === 'quiet' && row.task === 'errand'
              ? row.answers?.length
                ? `Answered ${row.answers.length} questions`
                : `Answered: ${row.title}`
              : digest?.headline ?? row.title}
        </h2>
        {!failed && !live && row.status !== 'quiet' && digest?.summary && (
          <p className="max-w-[980px] text-[13.5px] leading-relaxed text-ink-muted">{digest.summary}</p>
        )}
        {row.steps.length > 0 && <StepBar row={row} />}
        {failed && row.note && <p className="text-[13.5px] text-red-400">{row.note}</p>}
        {live && <p className="text-[13.5px] text-ink-muted">Still working — its result lands here when it finishes.</p>}
        {run && <WorkerDecisions run={run} workerName={row.workerName} />}
        {file && (
          <button
            onClick={() => openFile(file.path, undefined, 'preview')}
            className="self-start rounded-md border border-card-strong px-3 py-1.5 text-[12px] text-ink hover:bg-card-strong"
            title={file.path}
          >
            Open {baseName(file.name)}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {answers.length > 0 ? (
          <AnswerThread row={row} answers={answers} />
        ) : previewContent === null ? (
          <p className="px-8 py-6 text-[12px] text-ink-faint">Reading {file ? baseName(file.name) : 'the result'}…</p>
        ) : previewContent || doc?.artifact ? (
          <FilePreview path={previewPath} content={previewContent} artifact={doc?.artifact ?? null} />
        ) : (
          !live && (
            <p className="px-8 py-6 text-[13px] text-ink-muted">
              This job left nothing to read. The Run tab has the whole transcript.
            </p>
          )
        )}
      </div>
      {!live && <FollowUp row={row} thread={answers.length > 0} />}
    </div>
  );
}

/// Questions a worker answered in chat, drawn as the conversation they were —
/// with the same bubbles as the worker's desk and the Chat window, so a reply
/// reads the same wherever you meet it: your words on your side, the
/// worker's answer on its side, one turn after another.
function AnswerThread({
  row,
  answers,
}: {
  row: QueueRow;
  answers: Array<{ key: string; asked: string; answer: string; at: number; orchestrationId: string }>;
}) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  // What each turn handed on, read back from the journal — the outcome, not
  // what the reply asked for, so a handoff that failed says so.
  const journal = useWorkersStore((s) => s.journals[row.workerId]);
  const loadJournal = useWorkersStore((s) => s.loadJournal);
  const heldCount = useWorkersStore((s) => s.heldHandoffs.length);
  // What you just sent from the box below, until its answer lands — which
  // is when it joins the thread as a real turn.
  const sending = useWorkersStore((s) => s.errandSending[row.workerId]);
  const end = useRef<HTMLDivElement>(null);
  const turns = answers.length + (sending?.length ?? 0);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns, row.key]);
  useEffect(() => {
    void loadJournal(row.workerId);
  }, [loadJournal, row.workerId, answers.length, heldCount]);
  if (!worker) return null;
  return (
    <div className="h-full overflow-y-auto px-8 py-6">
      <div className="flex flex-col gap-6">
        {answers.map((a) => (
          <div key={a.key} className="flex flex-col gap-2">
            <UserBubble text={a.asked} />
            <WorkerReply
              worker={worker}
              at={a.at}
              reply={a.answer}
              footer={<HandoffNotes entries={(journal ?? []).filter((e) => e.kind === 'delegated' && e.orchestrationId === a.orchestrationId)} />}
            />
          </div>
        ))}
        {sending?.map((p, i) => (
          <div key={p.id} className="flex flex-col gap-2">
            <UserBubble text={p.text} />
            <div role="status" aria-live="polite" className="flex items-center gap-2 px-1 text-[11.5px] text-ink-faint">
              <WorkerAvatar worker={worker} size="xs" live={i === 0} />
              {i === 0 ? `${worker.name} is on it…` : `Queued · ${i} ahead`}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

/// What a turn passed to colleagues, under the reply that did it: "Handed to
/// Chief of Staff", "Will hand to Chief of Staff on Tue, Oct 13", or why it
/// could not.
function HandoffNotes({ entries }: { entries: Array<{ id?: string; note?: string }> }) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-card pt-2">
      {entries.map((e, i) => {
        const note = e.note ?? '';
        const ok = /^(Handed to|Will hand to)/.test(note);
        return (
          <div key={e.id ?? i} className={'flex items-start gap-1.5 text-[11.5px] ' + (ok ? 'text-ink-muted' : 'text-red-400')}>
            <span aria-hidden>→</span>
            <span>{ok ? note.split(': ')[0] : note}</span>
          </div>
        );
      })}
    </div>
  );
}

/// The calls the worker made on your behalf during the run — questions the
/// flow put to it that it answered without you. Folded to one line; they are
/// worth checking, not reading every time.
function WorkerDecisions({ run, workerName }: { run: FlowRun; workerName: string }) {
  const decisions = workerDecisions(run);
  const [open, setOpen] = useState(false);
  if (decisions.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setOpen((o) => !o)} className="self-start text-[12px] text-ink-muted hover:text-ink">
        {open ? '▾' : '▸'} {workerName} decided {decisions.length === 1 ? '1 question' : `${decisions.length} questions`} along
        the way
      </button>
      {open && (
        <ul className="flex flex-col gap-2 rounded-lg border border-card px-4 py-3">
          {decisions.map((d) => (
            <li key={d.id} className="text-[12.5px] leading-relaxed">
              <span className="text-ink-faint">{d.stepId} asked:</span>{' '}
              <span className="text-ink-muted">{d.question.length > 240 ? `${d.question.slice(0, 239)}…` : d.question}</span>
              <span className="mt-0.5 block text-ink">
                <span className="text-ink-faint">{workerName}:</span> {d.answer}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// The chat box at the foot of the reader — the app's own composer, files
/// and all. Under a conversation it simply continues it: an errand picks up
/// the worker's desk session for the day, so "and next week?" lands. Under a
/// result it names the job, so the worker knows what "this" is.
function FollowUp({ row, thread }: { row: QueueRow; thread: boolean }) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const sending = useWorkersStore((s) => (s.errandSending[row.workerId]?.length ?? 0) > 0);
  if (!worker) return null;
  const frame = thread ? undefined : (ask: string) => `About "${row.title}" (${clockStamp(row.at)} today): ${ask}`;
  return (
    <div className="shrink-0 border-t border-card px-8 pb-4 pt-3">
      {!thread && sending && (
        <div role="status" className="mb-2 flex items-center gap-2 text-[11.5px] text-ink-faint">
          <WorkerAvatar worker={worker} size="xs" live />
          {worker.name} is on it — the answer lands in your inbox.
        </div>
      )}
      <WorkerErrandComposer
        key={row.key}
        worker={worker}
        draftKey={`today-ask:${row.key}`}
        placeholder={thread ? `Message ${worker.name}…` : `Ask ${worker.name} about this…`}
        frame={frame}
        hints={false}
      />
    </div>
  );
}

function StepBar({ row }: { row: QueueRow }) {
  return (
    <ol aria-label="Steps" className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${row.steps.length}, minmax(0, 1fr))` }}>
      {row.steps.map((s) => (
        <li key={s.id} className="flex min-w-0 flex-col gap-1">
          <span
            className="h-[4px] rounded-full"
            style={{
              background:
                s.state === 'done'
                  ? 'color-mix(in srgb, #34d399 70%, transparent)'
                  : s.state === 'failed'
                    ? '#f87171'
                    : s.state === 'current'
                      ? row.status === 'paused'
                        ? '#fbbf24'
                        : 'var(--c-accent)'
                      : 'var(--c-card-border)',
            }}
          />
          <span className={'truncate text-[10.5px] ' + (s.state === 'current' ? 'text-ink' : 'text-ink-faint')}>{s.id}</span>
        </li>
      ))}
    </ol>
  );
}

/// The step whose work a pause is about: the one before the step it stopped
/// in front of, or that step itself for a question.
function stepBeforePause(run: FlowRun): string | undefined {
  if (run.state.kind !== 'paused') return undefined;
  const steps = run.flowSnapshot.steps;
  const at = steps.findIndex((s) => s.id === (run.state as { nextStepId: string }).nextStepId);
  if (run.state.reason === 'needsInput') return steps[at]?.id;
  return at > 0 ? steps[at - 1].id : steps[at]?.id;
}
