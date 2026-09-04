// Which of a worker's runs get a row in the roster, and where each one is
// inside its flow.
//
// The sidebar used to spend a single amber dot on this: "a flow is paused"
// told you THAT a worker was stopped but not which ticket or how far it got,
// so every blocked run cost a click into the desk and a scan down the chat to
// find the card holding Continue. These two functions are what a row needs to
// say it in place — pure, so the roster's rules can be tested without a
// renderer.

import { flowRunActivityAt, type FlowRun } from '@shared/flows/schema';

/// How many run rows hang under a FOLDED worker. Three: a worker that stalled
/// three flows is worth three rows; one that stalled nine is a desk visit,
/// and the roster still has twelve other workers to draw. Nothing is lost by
/// the cut: the worker's own second line still says "5 flows paused" (see
/// `boardReasons`), so the rail thins the rows without thinning the count.
export const RAIL_RUNS = 3;
/// And under an open one, where running and just-finished rows join the
/// blocked ones. Five, the same ceiling `NESTED_TURNS` gives the turns below
/// them — an opened worker is a worker you are reading.
export const RAIL_RUNS_OPEN = 5;

/// A run stopped with nothing left to do but ask you. Deliberately just
/// `paused` — the same test `boardReasons` counts for the amber dot and the
/// "Needs you" group, so a worker can never show a blocked row while sitting
/// in a group that says nothing is blocked.
export function isBlockedRun(run: FlowRun): boolean {
  return run.state.kind === 'paused';
}

/// How long a finished run keeps its row. An hour: long enough that a job
/// which landed while you were in another app is still there when you come
/// back, short enough that the roster is about now rather than about today —
/// the desk and the queue both hold the full day.
export const RECENT_DONE_MS = 60 * 60 * 1000;

/// Finished, and finished recently. `watching` is excluded on purpose: a
/// watched run has a tail of its own and is not over.
export function isRecentlyFinished(run: FlowRun, now: number): boolean {
  if (run.state.kind !== 'done' && run.state.kind !== 'aborted') return false;
  const at = flowRunActivityAt(run);
  // A clock that disagrees with a timestamp from the future would otherwise
  // hide the run rather than show it, which is the wrong way to be wrong.
  return at > 0 && now - at <= RECENT_DONE_MS;
}

/// The runs worth drawing under a worker.
///
/// Folded, only the blocked ones: the disclosure hides a worker's HISTORY,
/// and a run waiting on you is not history — it is the reason the row is in
/// "Needs you" at all. Opening the worker adds what is running and what just
/// finished, neither of which needs a decision.
///
/// Ordered by claim on your attention rather than by clock, because the cut
/// at `max` has to fall on the least important row: a worker with three live
/// runs must not be able to push its stopped one off the list. Inside each
/// class, newest first.
export function railRuns(
  runs: FlowRun[],
  expanded: boolean,
  now: number,
  max = expanded ? RAIL_RUNS_OPEN : RAIL_RUNS,
): FlowRun[] {
  const newestFirst = (a: FlowRun, b: FlowRun) => flowRunActivityAt(b) - flowRunActivityAt(a);
  const blocked = runs.filter(isBlockedRun).sort(newestFirst);
  if (!expanded) return blocked.slice(0, max);
  const running = runs.filter((run) => run.state.kind === 'running').sort(newestFirst);
  const finished = runs.filter((run) => isRecentlyFinished(run, now)).sort(newestFirst);
  return [...blocked, ...running, ...finished].slice(0, max);
}

/// Where a run is inside its flow: the live step and its position. Null for a
/// flow with no steps, and for the run states that have no live step at all
/// (done, aborted, watching) the index falls back to the first step, which is
/// why callers only ask this of running and paused runs.
export function runStepPosition(
  run: FlowRun,
): { step: string; index: number; position: number; total: number } | null {
  const steps = run.flowSnapshot.steps;
  if (steps.length === 0) return null;
  const state = run.state;
  const liveId =
    state.kind === 'running'
      ? state.currentStepId
      : state.kind === 'paused'
        ? state.nextStepId
        : null;
  // A step id the snapshot doesn't carry (an edited flow, a renamed step)
  // reads as the beginning rather than as -1, which would render "step 0".
  const index = Math.max(
    0,
    steps.findIndex((step) => step.id === liveId),
  );
  return {
    step: steps[index]?.id ?? liveId ?? 'Starting',
    index,
    position: Math.min(steps.length, index + 1),
    total: steps.length,
  };
}

/// Why a paused run stopped, in the words the sidebar tooltip uses. The row
/// itself shows the step; this says what the step is waiting FOR, which is
/// the difference between "click Continue" and "go and answer a question".
export function pauseReasonLabel(run: FlowRun): string | null {
  if (run.state.kind !== 'paused') return null;
  switch (run.state.reason) {
    case 'needsInput':
      return 'needs an answer';
    case 'externalAction':
    case 'riskyStep':
      return 'needs approval';
    case 'failure':
      return 'a step failed';
    case 'interrupted':
      return 'interrupted — continue re-runs the step';
    case 'preStep':
      return 'paused before this step';
  }
}

/// The step line a rail row shows, or null when there isn't one.
///
/// Only a running or paused run has a live step. `runStepPosition` falls back
/// to the first step for every other state, and "plan 1/3" under a finished
/// run would read as a claim about where it is now rather than where it got
/// to.
export function railStepPosition(run: FlowRun): ReturnType<typeof runStepPosition> {
  if (run.state.kind !== 'running' && run.state.kind !== 'paused') return null;
  return runStepPosition(run);
}
