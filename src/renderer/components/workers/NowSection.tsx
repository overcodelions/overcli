// The pieces the Today page's cards and reader share: the live card for work
// in flight, the in-place review of a checkpoint, and the answer box for a
// question. Each says what a job is doing or asking without opening its run.

import { useEffect, useMemo, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useRunnersStore } from '../../runnersStore';
import { useWorkersStore } from '../../workersStore';
import { Markdown } from '../Markdown';
import { PausedActions } from './PausedActions';
import type { FlowArtifact, FlowRun } from '@shared/flows/schema';
import { WorkerAvatar } from './WorkerAvatar';
import {
  currentConversationId,
  elapsedLabel,
  latestSaid,
  latestToolLine,
  waitingLine,
} from './nowCards';
import type { QueueRow, QueueStep } from './workQueue';

export function SectionLabel({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
      {children}
    </h3>
  );
}

/// What you are being asked to approve, opened under its row: the account
/// the previous step gave of its work, and the files it changed. Enough to
/// decide on most checkpoints without leaving the page; the full run is one
/// link away for the ones that need more.
export function CheckpointReview({
  row,
  runId,
  onOpen,
  hideOpenLink = false,
}: {
  row: QueueRow;
  runId: string;
  onOpen: (row: QueueRow) => void;
  /// For a host that already offers the run another way (the reader's Run tab).
  hideOpenLink?: boolean;
}) {
  const run = useFlowsStore((s) => s.runs[runId]);
  const [changes, setChanges] = useState<
    | { state: 'loading' }
    | { state: 'none' }
    | { state: 'ready'; files: Array<{ path: string; additions: number; deletions: number }>; plus: number; minus: number }
  >({ state: 'loading' });
  const worktreePath = run?.worktreePath;
  const baseBranch = run?.baseBranch;
  const baselineCommit = run?.baselineCommit;

  useEffect(() => {
    // Only a worktree run has a diff of its own to show; one working in the
    // checkout would be reporting whatever else changed there too.
    if (!worktreePath || !baseBranch) {
      setChanges({ state: 'none' });
      return;
    }
    let cancelled = false;
    void window.overcli
      .invoke('git:worktreeChanges', { worktreePath, baseBranch, baselineCommit })
      .then((res) => {
        if (cancelled) return;
        if (!res?.isRepo) return setChanges({ state: 'none' });
        setChanges({ state: 'ready', files: res.changes, plus: res.insertions, minus: res.deletions });
      })
      .catch(() => !cancelled && setChanges({ state: 'none' }));
    return () => {
      cancelled = true;
    };
  }, [worktreePath, baseBranch, baselineCommit]);

  return (
    <div className="flex flex-col gap-3 border-t px-3.5 pb-3 pt-3" style={{ borderColor: 'var(--c-card-border)' }}>
      {run && <StepOutputs run={run} />}
      {changes.state === 'ready' && (
        <div>
          <SectionLabel>
            {changes.files.length === 0
              ? 'No file changes'
              : `Changes · ${changes.files.length} file${changes.files.length === 1 ? '' : 's'}, +${changes.plus} −${changes.minus}`}
          </SectionLabel>
          {changes.files.length > 0 && (
            <ul className="mt-1.5 overflow-hidden rounded-md border" style={{ borderColor: 'var(--c-card-border)' }}>
              {changes.files.slice(0, 12).map((f) => (
                <li
                  key={f.path}
                  className="flex items-center gap-3 border-b px-2.5 py-1.5 last:border-b-0"
                  style={{ borderColor: 'var(--c-card-border)' }}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">{f.path}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-emerald-500">+{f.additions}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-red-400">−{f.deletions}</span>
                </li>
              ))}
              {changes.files.length > 12 && (
                <li className="px-2.5 py-1.5 text-[11px] text-ink-faint">{changes.files.length - 12} more in the run</li>
              )}
            </ul>
          )}
        </div>
      )}
      {changes.state === 'loading' && <span className="text-[11px] text-ink-faint">Reading the changes…</span>}
      {!hideOpenLink && (
      <button
        onClick={() => onOpen(row)}
        className="self-start text-[11.5px] text-accent hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      >
        Open the full run →
      </button>
      )}
    </div>
  );
}

/// What the run has done so far, as the steps themselves reported it: each
/// finished step's output — the review, the test report, the eval — rendered,
/// newest first and open. A sentence lifted from the chat said nothing; the
/// outputs are what you would read to decide, so they are what is shown.
function StepOutputs({ run }: { run: FlowRun }) {
  const outputs = useMemo(
    () => Object.values(run.artifacts ?? {}).sort((a, b) => b.producedAt - a.producedAt),
    [run.artifacts],
  );
  const [picked, setPicked] = useState<string | null>(null);
  if (outputs.length === 0) {
    return (
      <div>
        <SectionLabel>What it did</SectionLabel>
        <p className="mt-1 text-[12.5px] text-ink-muted">No step has reported yet — the Run tab has the transcript.</p>
      </div>
    );
  }
  const shown = outputs.find((a) => a.name === picked) ?? outputs[0];
  const stepOf = (a: FlowArtifact) => a.producedByStepId;
  const body = shown.kind === 'diff' ? '```diff\n' + shown.body + '\n```' : shown.body;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <SectionLabel>What it did</SectionLabel>
        <span className="mx-1 text-ink-faint/50">·</span>
        {outputs.map((a) => (
          <button
            key={a.name}
            onClick={() => setPicked(a.name)}
            aria-pressed={a.name === shown.name}
            className={
              'rounded px-2 py-0.5 text-[11px] ' +
              (a.name === shown.name ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
            }
            title={a.name}
          >
            {stepOf(a)}
          </button>
        ))}
      </div>
      <div className="max-h-[62vh] overflow-y-auto rounded-lg border border-card bg-surface px-6 py-5 text-[13px] leading-relaxed">
        <Markdown source={body || '_(empty)_'} />
      </div>
    </div>
  );
}

/// Answer the question where it is asked. The answer rides into the step as a
/// steer — injected at the top of its prompt — and the run resumes, so the
/// step that asked is the one that reads it. Same two calls the run page
/// makes, minus opening the run page.
export function AnswerBox({ runId }: { runId: string }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingContinue = useFlowsStore((s) => !!s.runs[runId]?.pendingContinue);

  const submit = async () => {
    const answer = text.trim();
    if (!answer || sending) return;
    setSending(true);
    setError(null);
    const steer = await window.overcli.invoke('flows:steerRun', {
      runId,
      text: `The user answered your question:\n${answer}`,
    });
    if (!steer || steer.ok === false) {
      setError(steer?.error ?? 'Could not send the answer.');
      setSending(false);
      return;
    }
    const res = await window.overcli.invoke('flows:resumeRun', { runId });
    if (!res || res.ok === false) {
      setError((res as { error?: string } | undefined)?.error ?? 'The answer was saved, but the run did not resume.');
      setSending(false);
      return;
    }
    setText('');
    setSending(false);
  };

  const busy = sending || pendingContinue;
  return (
    <div className="flex flex-col gap-1.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor={`answer-${runId}`}>
          Your answer
        </label>
        <input
          id={`answer-${runId}`}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your answer…"
          className="min-w-0 flex-1 rounded-md border border-card-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-[5px] bg-amber-400 px-3 py-1.5 text-[11.5px] font-medium text-[#1c1c21] hover:bg-amber-300 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Answer'}
        </button>
      </form>
      {error && <span className="text-[11px] text-red-500">{error}</span>}
    </div>
  );
}

export function NowCard({
  row,
  now,
  onOpen,
  waiting = false,
}: {
  row: QueueRow;
  now: number;
  onOpen: (row: QueueRow) => void;
  waiting?: boolean;
}) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const convId = useFlowsStore((s) => {
    const run = row.runId ? s.runs[row.runId] : undefined;
    return run ? currentConversationId(run) : undefined;
  });
  // Plain strings out of the selector, so the card re-renders when the line
  // changes and not on every streamed token.
  const toolLine = useRunnersStore((s) => (convId ? latestToolLine(s.runners[convId]?.events) : ''));
  const said = useRunnersStore((s) =>
    convId && waiting && row.pausedReason === 'needsInput' ? latestSaid(s.runners[convId]?.events) : '',
  );

  const currentStep = row.steps.find((s) => s.state === 'current');
  const stepAt = currentStep ? row.steps.indexOf(currentStep) + 1 : 0;
  // Prose reads as prose; only a tool call gets the code face.
  const isTool = !waiting && (row.status === 'planning' ? !!row.note : !!toolLine);
  const live = waiting
    ? said || waitingLine(row.pausedReason, currentStep?.id)
    : row.status === 'planning'
      ? row.note ?? 'Reading the project…'
      : toolLine || 'Thinking…';

  return (
    <article
      className="flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card px-3.5 py-3"
      style={
        waiting
          ? {
              borderColor: 'color-mix(in srgb, #fbbf24 35%, var(--c-card-border))',
              background: 'color-mix(in srgb, #fbbf24 5%, var(--c-card))',
            }
          : { borderColor: 'var(--c-card-border)' }
      }
    >
      <button
        onClick={() => onOpen(row)}
        className="flex min-w-0 items-center gap-2.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        title="Open this run"
      >
        {worker && <WorkerAvatar worker={worker} size="xs" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] text-ink-muted">{row.workerName}</span>
          <span className="block truncate text-[13px] font-medium text-ink">{row.title}</span>
        </span>
        <StatePill row={row} waiting={waiting} />
      </button>

      {row.steps.length > 0 && <StepTrack steps={row.steps} waiting={waiting} />}

      {isTool ? (
        <div
          className="truncate rounded-md px-2.5 py-1.5 font-mono text-[11.5px] text-ink-muted"
          style={{ background: 'color-mix(in srgb, var(--c-ink) 4%, transparent)' }}
          title={live}
        >
          <span className="mr-1 text-ink-faint">›</span>
          {live}
        </div>
      ) : (
        <p
          className={
            'text-[12.5px] leading-snug ' +
            // A question is read in full before it is answered; anything
            // else is a status and gets two lines.
            (waiting && said ? 'line-clamp-4 text-ink' : 'line-clamp-2 text-ink-muted')
          }
          title={live}
        >
          {live}
        </p>
      )}

      {waiting && row.pausedReason === 'needsInput' && row.runId && <AnswerBox runId={row.runId} />}

      {/* Pinned to the bottom: cards in a row share a height, and a
          two-line question must not push its buttons out of line with its
          neighbours'. */}
      <div className="mt-auto flex items-center gap-2">
        <span className="text-[11px] text-ink-faint">
          {waiting ? `Waiting ${elapsedLabel(now - row.at)}` : `Running ${elapsedLabel(now - row.at)}`}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {waiting && row.runId ? (
            <PausedActions row={row} tone="solid" rejectOnly={row.pausedReason === 'needsInput'} />
          ) : (
            <button
              onClick={() => onOpen(row)}
              className="rounded-md border border-card-strong px-2.5 py-1 text-[11px] text-ink-muted hover:bg-card-strong hover:text-ink"
            >
              Open
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

function StatePill({ row, waiting }: { row: QueueRow; waiting: boolean }) {
  const label = waiting
    ? row.pausedReason === 'needsInput'
      ? 'Asked you'
      : row.pausedReason === 'failure'
        ? 'Failed'
        : 'Waiting on you'
    : row.status === 'planning'
      ? 'Planning'
      : 'Running';
  return (
    <span
      className={
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ' +
        (waiting ? 'bg-amber-400 text-amber-950' : 'text-emerald-400')
      }
      style={waiting ? undefined : { background: 'color-mix(in srgb, #34d399 12%, transparent)' }}
    >
      {label}
    </span>
  );
}

/// Where the run is, at a glance: one thin segment per step, and the name of
/// the step it is on. A seven-step flow as seven labelled chips wrapped across
/// the card and had to be read; a bar is seen.
function StepTrack({ steps, waiting }: { steps: QueueStep[]; waiting: boolean }) {
  const current = steps.find((s) => s.state === 'current');
  const at = current ? steps.indexOf(current) + 1 : steps.filter((s) => s.state === 'done').length;
  return (
    <div className="flex items-center gap-2.5">
      <ol aria-label={`Step ${at} of ${steps.length}`} className="flex flex-1 gap-[3px]">
        {steps.map((s) => (
          <li
            key={s.id}
            title={`${s.id}${s.state === 'done' ? ' — done' : s.state === 'failed' ? ' — failed' : s.state === 'current' ? ' — now' : ''}`}
            aria-current={s.state === 'current' ? 'step' : undefined}
            className="h-[4px] flex-1 rounded-full"
            style={{
              background:
                s.state === 'done'
                  ? 'color-mix(in srgb, #34d399 70%, transparent)'
                  : s.state === 'failed'
                    ? '#f87171'
                    : s.state === 'current'
                      ? waiting
                        ? '#fbbf24'
                        : 'var(--c-accent, #8b7cf6)'
                      : 'var(--c-card-border)',
            }}
          />
        ))}
      </ol>
      <span className="shrink-0 text-[11px] text-ink-muted">
        <span className="font-medium text-ink">{current?.id ?? 'done'}</span>
        <span className="text-ink-faint"> · {at} of {steps.length}</span>
      </span>
    </div>
  );
}
