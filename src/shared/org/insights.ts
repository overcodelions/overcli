// What the control plane tells a person about their workers, beyond the raw
// records: whether a worker has earned more trust, whether spend is on track,
// and what a worker is doing right now. Pure, so the console, Slack and MCP
// all say the same thing.

import type { FlowRun } from '../flows/schema';
import type { Worker, WorkerJournalEntry, WorkerTrustLevel } from '../flows/worker';

/// Clean runs a worker needs before the plane suggests promoting it, and the
/// window they must fall in. A month is long enough to see a pattern and
/// short enough that a worker which went quiet is not promoted on old form.
export const TRUST_CLEAN_RUNS: Record<Exclude<WorkerTrustLevel, 'autonomous'>, number> = {
  probation: 10,
  trusted: 30,
};
export const TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrustReadiness {
  level: WorkerTrustLevel;
  /// The next level, when the record supports it.
  readyFor?: WorkerTrustLevel;
  /// Clean runs in the window, and how many the next level needs.
  clean: number;
  needed?: number;
  /// Why, in a sentence, for the person deciding.
  reason: string;
}

const NEXT: Record<WorkerTrustLevel, WorkerTrustLevel | undefined> = {
  probation: 'trusted',
  trusted: 'autonomous',
  autonomous: undefined,
};

/// Whether a worker's recent record supports promoting it. A failure or a
/// rejection in the window resets the case: trust is about the run of form
/// since the last thing went wrong, not the total.
export function trustReadiness(
  worker: Pick<Worker, 'trust'>,
  journal: readonly Pick<WorkerJournalEntry, 'kind' | 'at'>[],
  now: number,
): TrustReadiness {
  const level = worker.trust;
  const next = NEXT[level];
  if (!next || level === 'autonomous') return { level, clean: 0, reason: 'Already fully trusted.' };
  const needed = TRUST_CLEAN_RUNS[level];
  const recent = journal.filter((e) => now - e.at <= TRUST_WINDOW_MS).sort((a, b) => a.at - b.at);
  let clean = 0;
  for (const e of recent) {
    if (e.kind === 'failed' || e.kind === 'rejected' || e.kind === 'demoted') clean = 0;
    else if (e.kind === 'completed') clean++;
  }
  if (clean >= needed) {
    return {
      level,
      readyFor: next,
      clean,
      needed,
      reason: `Its last ${clean} runs finished with nothing rejected or failed.`,
    };
  }
  return {
    level,
    clean,
    needed,
    reason: clean === 0 ? 'No clean run of form yet this month.' : `${clean} clean run${clean === 1 ? '' : 's'} in a row; ${needed} earn the next level.`,
  };
}

/// Spend at month end if the month carries on as it has gone.
export function projectMonthEnd(spent: number, now: Date): number {
  // Days gone so far: midnight on the 1st is zero. Under a day of history
  // is counted as one, so a busy first morning does not project a fortune.
  const elapsed = now.getDate() - 1 + (now.getHours() + now.getMinutes() / 60) / 24;
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return (spent / Math.max(elapsed, 1)) * days;
}

export type WorkerState = 'working' | 'waiting' | 'paused' | 'stuck' | 'idle';

/// What a worker is doing now, from its runs. Waiting on a person outranks
/// working: it is the one state somebody can do something about.
export function workerState(worker: Pick<Worker, 'id' | 'enabled'>, runs: readonly FlowRun[]): WorkerState {
  if (!worker.enabled) return 'paused';
  const mine = runs.filter((r) => r.workerId === worker.id);
  if (mine.some((r) => r.state.kind === 'paused' && (r.state.reason === 'needsInput' || r.state.reason === 'externalAction'))) {
    return 'waiting';
  }
  if (mine.some((r) => r.state.kind === 'paused' && r.state.reason === 'failure')) return 'stuck';
  if (mine.some((r) => r.state.kind === 'running')) return 'working';
  return 'idle';
}

/// Two choices offered as one question ("A or B?") become one-tap answers.
/// Only the plain shape: anything subtler is left to free text, where a wrong
/// guess costs nothing.
export function answerOptions(question: string): string[] {
  const last = question.trim().split(/(?<=[.!?])\s+/).filter((s) => s.endsWith('?')).pop();
  if (!last) return [];
  // Peel off the lead-in ("Should I call this …"), however many layers, so
  // only the choice itself is left to split.
  const LEAD = /^(?:.*?\b)?(?:should I|shall I|do I|would you|call (?:this|that|it)|is (?:this|it)|use|pick|choose|go with)\s+/i;
  let body = last;
  for (let guard = 0; guard < 4; guard++) {
    const next = body.replace(LEAD, '');
    if (next === body) break;
    body = next;
  }
  const m = /^(?:an?\s+|the\s+)?([^?,]{2,40}?)\s+or\s+(?:an?\s+|the\s+)?([^?,]{2,40}?)\?$/i.exec(body);
  if (!m) return [];
  const clean = (s: string) => s.trim().replace(/^["“']|["”']$/g, '');
  const a = clean(m[1]);
  const b = clean(m[2]);
  if (!a || !b || a.split(/\s+/).length > 6 || b.split(/\s+/).length > 6) return [];
  return [a.charAt(0).toUpperCase() + a.slice(1), b.charAt(0).toUpperCase() + b.slice(1)];
}
