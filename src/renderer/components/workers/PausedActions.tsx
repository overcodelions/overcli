// The two buttons on a run that has stopped and is waiting on a person.
//
// Its own module because it is used from BOTH front pages now — the Today
// spine pins decisions above the now-line, the work queue lists them in its
// table — and REJECT IS DESTRUCTIVE. It deletes a run and its worktree
// through the shared dirty-worktree guard, then writes the journal entry that
// stops the idea being proposed again. Two copies of that sequence is one
// copy too many: the day they drift, one of the front pages quietly stops
// recording the rejection and the worker proposes the same job tomorrow.

import { useEffect, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { deleteFlowRunWithDirtyGuard } from '../flows/deleteRun';
import { PAUSE_ACTION, PAUSE_HINT, REJECT_CONFIRM, REJECT_HINT } from './pauseCopy';

import type { QueueRow } from './workQueue';

/// `tone` is the only thing the two callers disagree about. The queue draws
/// them as quiet outlines in a dense table; the spine's pinned card has
/// already gone amber around them, so there the primary action is solid and
/// carries the card's weight. `page` is the reader, where the decision is the
/// point of the page: full-size buttons, the hint spelled out beside them, and
/// a confirm that reads as a warning rather than a footnote.
export function PausedActions({
  row,
  tone = 'outline',
  rejectOnly = false,
}: {
  row: QueueRow;
  tone?: 'outline' | 'solid' | 'page';
  /// Reject alone — for a card that brings its own way forward (the answer
  /// box on a question), where a bare "resume" beside it would offer to go
  /// on without the answer.
  rejectOnly?: boolean;
}) {
  const runId = row.runId!;
  const reason = row.pausedReason ?? 'preStep';
  const pendingContinue = useFlowsStore((s) => !!s.runs[runId]?.pendingContinue);
  const removeRun = useFlowsStore((s) => s.removeRun);
  const [resuming, setResuming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  // The store's own flag is the truth once main has taken the resume; the
  // local one only covers the round trip before that lands. Clearing on the
  // flag's change is what stops a row that came back paused again — a second
  // checkpoint one step later — from being stuck showing "resuming…".
  useEffect(() => {
    setResuming(false);
  }, [pendingContinue, reason]);
  // The reader reuses this component when a decision clears and it moves on
  // to the next one. Everything local here was about the LAST run — without
  // this, the next item opened already saying "resuming…" for a run nobody
  // had touched.
  useEffect(() => {
    setResuming(false);
    setConfirming(false);
    setRejecting(false);
  }, [runId]);

  const inFlight = resuming || pendingContinue;

  const resume = () => {
    if (inFlight) return;
    setResuming(true);
    void window.overcli.invoke('flows:resumeRun', { runId }).then((res) => {
      if (!res || res.ok === false) setResuming(false);
    });
  };

  // Order matters and is the desk's order: the run and its worktree go first,
  // through the same dirty-worktree confirm every other delete uses, so
  // declining THAT prompt leaves the item exactly as it was. Only once the run
  // is gone does the item settle to rejected, which is what writes the journal
  // entry that keeps the idea from being proposed again.
  const reject = async () => {
    if (rejecting) return;
    setRejecting(true);
    const res = await deleteFlowRunWithDirtyGuard(runId);
    if (res.deleted) {
      removeRun(runId);
      if (row.orchestrationId && row.candidateId) {
        const r = await window.overcli.invoke('orchestrator:rejectItem', {
          id: row.orchestrationId,
          candidateId: row.candidateId,
        });
        if (r && r.ok === false) window.alert(`Couldn't decline this item: ${r.error}`);
      }
    }
    setRejecting(false);
    setConfirming(false);
  };

  const pad = tone === 'outline' ? ' pt-2' : '';
  const label = PAUSE_ACTION[reason].charAt(0).toUpperCase() + PAUSE_ACTION[reason].slice(1);

  if (tone === 'page') {
    // One row whose height doesn't change between asking and confirming, so
    // the buttons don't jump under the pointer.
    if (confirming) {
      return (
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-red-500/40 bg-red-500/[0.06] px-3 py-2">
          <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink">{REJECT_CONFIRM}</span>
          <button
            onClick={() => setConfirming(false)}
            disabled={rejecting}
            className="shrink-0 rounded-md border border-card-strong px-3.5 py-1.5 text-[12.5px] text-ink hover:bg-card-strong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void reject()}
            disabled={rejecting}
            className="shrink-0 rounded-md bg-red-500 px-3.5 py-1.5 text-[12.5px] font-medium text-white hover:bg-red-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-red-300 disabled:opacity-50"
          >
            {rejecting ? 'Rejecting…' : 'Reject and delete'}
          </button>
        </div>
      );
    }
    return (
      <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-transparent py-2">
        {!rejectOnly && (
          <button
            onClick={resume}
            disabled={inFlight}
            className="shrink-0 rounded-md bg-amber-400 px-4 py-1.5 text-[12.5px] font-medium text-[#1c1c21] hover:bg-amber-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-200 disabled:opacity-50"
          >
            {inFlight ? 'Resuming…' : label}
          </button>
        )}
        <button
          onClick={() => setConfirming(true)}
          disabled={inFlight}
          title={REJECT_HINT}
          className={
            'shrink-0 rounded-md border border-card-strong px-3.5 py-1.5 text-[12.5px] text-ink-muted hover:border-red-400/60 hover:text-red-400 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:opacity-50'
          }
        >
          Reject
        </button>
        {!rejectOnly && (
          <span className="min-w-0 flex-1 text-[12px] leading-snug text-ink-faint">{PAUSE_HINT[reason]}</span>
        )}
      </div>
    );
  }

  if (confirming) {
    return (
      <span className={'flex shrink-0 items-center gap-1.5' + pad}>
        <span className="max-w-[16rem] text-[10px] text-ink-muted">{REJECT_CONFIRM}</span>
        <button
          onClick={() => void reject()}
          disabled={rejecting}
          className="shrink-0 rounded bg-red-500/80 px-1.5 py-[1px] text-[10px] text-white focus:outline-none disabled:opacity-50"
        >
          {rejecting ? 'rejecting…' : 'Reject'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="shrink-0 text-[10px] text-ink-faint hover:text-ink focus:outline-none"
        >
          Cancel
        </button>
      </span>
    );
  }

  const solid = tone === 'solid';
  return (
    <span className={'flex shrink-0 items-center gap-1.5' + pad}>
      {!rejectOnly && (
      <button
        onClick={resume}
        disabled={inFlight}
        title={PAUSE_HINT[reason]}
        className={
          'shrink-0 focus:outline-none disabled:opacity-50 ' +
          (solid
            ? 'rounded-[5px] bg-amber-400 px-3 py-1 text-[11px] font-medium text-[#1c1c21] hover:bg-amber-300'
            : 'rounded border border-amber-500/40 px-1.5 py-[1px] text-[10px] text-amber-600 hover:bg-amber-500/10 dark:text-amber-300')
        }
      >
        {inFlight ? 'resuming…' : PAUSE_ACTION[reason]}
      </button>
      )}
      <button
        onClick={() => setConfirming(true)}
        disabled={inFlight}
        title={REJECT_HINT}
        className={
          'shrink-0 focus:outline-none disabled:opacity-50 ' +
          (solid
            ? 'rounded-[5px] border border-card-strong px-3 py-1 text-[11px] text-ink-muted hover:text-ink'
            : 'rounded border border-red-500/40 px-1.5 py-[1px] text-[10px] text-red-500 hover:bg-red-500/10 dark:text-red-400')
        }
      >
        {solid ? 'Reject' : 'reject'}
      </button>
    </span>
  );
}

