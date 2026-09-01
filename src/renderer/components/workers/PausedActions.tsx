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
/// carries the card's weight.
export function PausedActions({ row, tone = 'outline' }: { row: QueueRow; tone?: 'outline' | 'solid' }) {
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

  const pad = tone === 'solid' ? '' : ' pt-2';

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

