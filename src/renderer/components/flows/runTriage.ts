// One place that decides what a set of runs wants from the user.
//
// The counts drive four surfaces now — the Runs segment badge, the library's
// one-line strip, the Runs page's own sections, and the Flows tab badge in
// the title bar. Splitting the rule across them is how two places end up
// disagreeing about whether anything is waiting, so it lives here and they
// all import it.

import { flowRunActivityAt, type FlowRun } from '@shared/flows/schema';

/// A paused run this quiet isn't waiting for a decision — it's been left
/// behind. Five days keeps a long weekend's worth of honest "I'll get to it"
/// out of the stalled pile.
export const STALL_AFTER_DAYS = 5;
export const STALL_AFTER_MS = STALL_AFTER_DAYS * 24 * 60 * 60 * 1000;

export interface RunTriage {
  running: number;
  needsYou: number;
  stalled: number;
}

export function triageRunCounts(
  runs: Record<string, FlowRun>,
  now: number = Date.now(),
): RunTriage {
  let running = 0;
  let needsYou = 0;
  let stalled = 0;
  for (const r of Object.values(runs)) {
    if (r.state.kind === 'running' || r.state.kind === 'watching') running++;
    else if (r.state.kind === 'paused') {
      if (now - flowRunActivityAt(r) <= STALL_AFTER_MS) needsYou++;
      else stalled++;
    }
  }
  return { running, needsYou, stalled };
}

/// The live count worn by both the Runs segment and the Flows tab.
///
/// `waiting` outranks `running`: one is blocked on the user, the other is
/// just working and will say so when it's done. Stalled runs are deliberately
/// not counted — a badge you can't clear stops being a signal.
export function runAttentionBadge(
  runs: Record<string, FlowRun>,
  now: number = Date.now(),
): { count: number; tone: 'waiting' | 'running' } | undefined {
  const t = triageRunCounts(runs, now);
  if (t.needsYou > 0) return { count: t.needsYou, tone: 'waiting' };
  if (t.running > 0) return { count: t.running, tone: 'running' };
  return undefined;
}

/// Which segment the Flows tab should open on.
///
/// Only ever `runs` on the session's FIRST visit, and only when something is
/// actually live: opening the app to three paused runs and being shown the
/// list of flow definitions instead is the case this exists for. Every later
/// click is unconditional, because the Flows tab carries no badge from the
/// other tabs — a click that lands somewhere different depending on run state
/// you can't see from where you clicked is the ambiguity `navigateToTab`
/// exists to remove. Once you're in the tab the segment badge is visible and
/// choosing Runs is a click away, which is the honest version of the same
/// nudge.
export function flowsLandingSegment(
  runs: Record<string, FlowRun>,
  firstVisitThisSession: boolean,
  now: number = Date.now(),
): 'flows' | 'runs' {
  if (!firstVisitThisSession) return 'flows';
  return runAttentionBadge(runs, now) ? 'runs' : 'flows';
}
