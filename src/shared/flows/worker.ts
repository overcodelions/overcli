// A Worker is a standing persona hired against a job description, not a saved
// prompt. Where a Schedule replays one frozen prompt, a Worker plans each
// shift freshly from its job description plus its own journal (what it already
// proposed, what the user approved or rejected), under a trust level that
// bounds how much may launch unattended and a monthly budget that stops the
// meter. The engine lives in src/main/flows/workerEngine.ts; this module is
// the shared contract both main and renderer validate against.

import type { UUID } from '../types';
import type { ScheduleTrigger } from './schedule';
import { SCHEDULE_AUTO_APPROVE_MAX, parseTimeOfDay } from './schedule';

export type WorkerTrustLevel = 'probation' | 'trusted' | 'autonomous';

export interface WorkerCaps {
  maxItemsPerShift: number;
  runIn: 'worktree' | 'cwd';
}

export interface Worker {
  id: UUID;
  name: string;
  jobDescription: string;
  projectPath: string;
  cadence: ScheduleTrigger;
  trust: WorkerTrustLevel;
  caps: WorkerCaps;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  flowIds: string[];
  enabled: boolean;
  createdAt: number;
  /// Point the cadence measures from when the worker has never worked a
  /// shift (or was re-enabled / had its cadence edited). Mirrors
  /// `Schedule.anchorAt` — without it, editing "daily 09:00" to "every hour"
  /// against a stale anchor would fire the instant the edit saves.
  anchorAt?: number;
  lastShiftAt?: number;
  shiftCount?: number;
}

// ---- Journal ------------------------------------------------------------

/// One line of a worker's episodic memory. Lives in shared (not main) because
/// the renderer renders the journal and the scorecard is computed from it.
/// Persistence is src/main/flows/workerJournal.ts.
export type WorkerJournalKind =
  | 'shift'
  | 'proposed'
  | 'launched'
  | 'approved'
  | 'rejected'
  | 'completed'
  | 'failed'
  /// A trust demotion landed. Its own kind (not a 'shift' note) because the
  /// rejection streak must treat it as a terminator — the rejections that
  /// caused a demotion are spent, and must not count toward the next one.
  | 'demoted';

export interface WorkerJournalEntry {
  id: string; // unique per entry, caller-supplied
  workerId: string;
  kind: WorkerJournalKind;
  at: number; // ms epoch
  title: string; // candidate/shift title, '' for shift entries
  note?: string;
  runId?: string;
  orchestrationId?: string;
  costUSD?: number;
}

// ---- Caps and trust -----------------------------------------------------

export const WORKER_MAX_ITEMS_PER_SHIFT = 5;
export const WORKER_MIN_JOB_DESCRIPTION = 20;
export const WORKER_MIN_INTERVAL_MINUTES = 15;
/// This many consecutive rejections demote the worker one trust level. The
/// streak counts only explicit verdicts (approved/rejected) — completed runs
/// and shift notes don't interrupt it, and one approval resets it.
export const WORKER_DEMOTE_REJECTION_STREAK = 3;

/// Probation means nothing runs unattended — the cap is literally zero.
/// SCHEDULE_AUTO_APPROVE_MAX is dominated by WORKER_MAX_ITEMS_PER_SHIFT today;
/// it stays in the Math.min so raising the worker cap can never silently
/// exceed the app-wide unattended-launch ceiling.
export function workerAutoApproveCap(w: Pick<Worker, 'trust' | 'caps'>): number {
  if (w.trust === 'probation') return 0;
  if (w.trust === 'trusted') return Math.min(2, w.caps.maxItemsPerShift);
  return Math.min(w.caps.maxItemsPerShift, WORKER_MAX_ITEMS_PER_SHIFT, SCHEDULE_AUTO_APPROVE_MAX);
}

/// One step down the ladder. Probation is the floor — there is nothing below
/// "everything parks for approval".
export function demotedTrust(level: WorkerTrustLevel): WorkerTrustLevel {
  if (level === 'autonomous') return 'trusted';
  return 'probation';
}

/// Leading run of 'rejected' among the explicit verdicts, newest first.
/// This is the number the auto-demotion rule watches. An approval OR a
/// prior demotion ends the streak — rejections that already cost a trust
/// level are spent, or a worker would fall two rungs off one bad patch.
export function rejectionStreak(entries: Array<Pick<WorkerJournalEntry, 'kind'>>): number {
  let streak = 0;
  for (const e of entries) {
    if (e.kind === 'approved' || e.kind === 'demoted') return streak;
    if (e.kind === 'rejected') streak++;
  }
  return streak;
}

export function describeWorker(w: Worker): string {
  return `${w.name} — ${w.trust}, ${w.caps.maxItemsPerShift} items/shift`;
}

// ---- Scorecard ----------------------------------------------------------

/// The performance review: everything the promote/demote/fire decision needs,
/// derived entirely from the journal plus the run-summary cost rollup. Never
/// stored — recomputed so it can't drift from the journal it summarizes.
export interface WorkerScorecard {
  proposed: number;
  approved: number;
  rejected: number;
  completed: number;
  failed: number;
  spentThisMonthUSD: number;
  /// Spend divided by completed items; null until something completed.
  costPerCompletedUSD: number | null;
  rejectionStreak: number;
}

export function computeWorkerScorecard(
  entries: Array<Pick<WorkerJournalEntry, 'kind'>>,
  spentThisMonthUSD: number,
): WorkerScorecard {
  const count = (kind: WorkerJournalKind) => entries.filter((e) => e.kind === kind).length;
  const completed = count('completed');
  return {
    proposed: count('proposed'),
    approved: count('approved'),
    rejected: count('rejected'),
    completed,
    failed: count('failed'),
    spentThisMonthUSD,
    costPerCompletedUSD: completed > 0 ? spentThisMonthUSD / completed : null,
    rejectionStreak: rejectionStreak(entries),
  };
}

// ---- Validation ---------------------------------------------------------

/// `parseTimeOfDay` (shared with the scheduler) accepts what the scheduler
/// can execute — including a single-digit hour like "9:30" — so the worker
/// editor can never reject a time the engine would happily fire on.
function validTimeOfDay(time: string): boolean {
  return parseTimeOfDay(time) !== null;
}

export function validateWorker(w: Partial<Worker>): string | null {
  if (!w.name?.trim()) return 'Give the worker a name.';
  if ((w.jobDescription ?? '').trim().length < WORKER_MIN_JOB_DESCRIPTION)
    return 'A job description needs at least 20 characters — the worker plans its own shifts from it.';
  if (!w.projectPath?.trim()) return 'Pick a project for this worker.';
  if (!w.flowIds || w.flowIds.length === 0) return 'A worker needs at least one flow to run.';
  if (!w.heartbeatModel?.trim()) return 'Pick a heartbeat model.';
  if (!Number.isFinite(w.budgetUSDPerMonth) || (w.budgetUSDPerMonth ?? 0) <= 0)
    return 'Set a monthly budget above zero.';

  const caps = w.caps;
  if (!caps) return 'Set the worker caps.';
  if (!Number.isInteger(caps.maxItemsPerShift) || caps.maxItemsPerShift < 1)
    return 'A shift must allow at least one item.';
  if (caps.maxItemsPerShift > WORKER_MAX_ITEMS_PER_SHIFT)
    return `A shift is capped at ${WORKER_MAX_ITEMS_PER_SHIFT} items.`;
  if (w.trust !== 'autonomous' && caps.runIn === 'cwd')
    return 'Only an autonomous worker may run in the working copy.';

  const cadence = w.cadence;
  if (!cadence) return 'Pick when this worker works.';
  if (cadence.days && cadence.days.length === 0)
    return 'Pick at least one day, or leave every day selected.';
  if (cadence.kind === 'interval') {
    if (!Number.isFinite(cadence.everyMinutes) || cadence.everyMinutes < WORKER_MIN_INTERVAL_MINUTES)
      return `A worker shift can be no more often than every ${WORKER_MIN_INTERVAL_MINUTES} minutes.`;
    const win = cadence.window;
    if (win) {
      if (!validTimeOfDay(win.start) || !validTimeOfDay(win.end) || win.start === win.end)
        return 'Active hours must look like 08:00 and 17:00.';
      // Same rule validateSchedule enforces: an interval longer than the
      // window silently means "once a day", which is never what was typed.
      const start = parseTimeOfDay(win.start)!;
      const end = parseTimeOfDay(win.end)!;
      const startMinutes = start.hours * 60 + start.minutes;
      const endMinutes = end.hours * 60 + end.minutes;
      if (startMinutes < endMinutes && cadence.everyMinutes > endMinutes - startMinutes)
        return `That interval is longer than the ${endMinutes - startMinutes}-minute window, so it would only fire once a day.`;
    }
  } else if (!validTimeOfDay(cadence.time)) {
    return 'Time must look like 09:30.';
  }
  return null;
}

// ---- Hire contract ------------------------------------------------------

/// What the hire drafter proposes and the user reviews before clicking Hire.
/// Everything a `Worker` needs except identity and bookkeeping — plus an
/// optional request to draft a new flow when none of the existing ones fit.
export interface WorkerContract {
  name: string;
  jobDescription: string;
  cadence: ScheduleTrigger;
  maxItemsPerShift: number;
  budgetUSDPerMonth: number;
  heartbeatModel: string;
  /// One of the flow ids the drafter was shown, when one fit.
  flowId?: string;
  /// Set when no existing flow fit: a description for the flow drafter to
  /// turn into a new flow, reviewed alongside the contract.
  flowRequest?: string;
  /// One of the project/workspace paths the drafter was shown — set only
  /// when the job description clearly concerns one of them. The hire screen
  /// uses it as a suggestion, never over an explicit user choice.
  projectPath?: string;
}

/// Pull the `<worker>…</worker>` JSON block out of a hire-drafter reply and
/// coerce it into a WorkerContract. Tolerant like `parseCandidates` — the
/// model is told to emit clean JSON, but a near-miss is clamped into range
/// rather than thrown away. Returns null only when nothing parseable exists.
/// Trust is NOT part of the contract: every worker is hired on probation.
export function parseWorkerContract(
  reply: string,
  opts: {
    knownFlowIds: string[];
    defaultHeartbeatModel: string;
    knownProjectPaths?: string[];
  },
): WorkerContract | null {
  const block =
    reply.match(/<worker>([\s\S]*?)<\/worker>/i)?.[1] ??
    reply.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const e = parsed as Record<string, unknown>;

  const name = typeof e.name === 'string' ? e.name.trim() : '';
  const jobDescription = typeof e.jobDescription === 'string' ? e.jobDescription.trim() : '';
  if (!name && !jobDescription) return null;

  const flowId =
    typeof e.flowId === 'string' && opts.knownFlowIds.includes(e.flowId.trim())
      ? e.flowId.trim()
      : undefined;
  const flowRequest =
    typeof e.flowRequest === 'string' && e.flowRequest.trim() ? e.flowRequest.trim() : undefined;
  const projectPath =
    typeof e.projectPath === 'string' && opts.knownProjectPaths?.includes(e.projectPath.trim())
      ? e.projectPath.trim()
      : undefined;

  const rawItems = Number(e.maxItemsPerShift);
  const maxItemsPerShift = Number.isFinite(rawItems)
    ? Math.max(1, Math.min(WORKER_MAX_ITEMS_PER_SHIFT, Math.floor(rawItems)))
    : 3;
  const rawBudget = Number(e.budgetUSDPerMonth);
  const budgetUSDPerMonth = Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 10;
  const heartbeatModel =
    typeof e.heartbeatModel === 'string' && e.heartbeatModel.trim()
      ? e.heartbeatModel.trim()
      : opts.defaultHeartbeatModel;

  return {
    name: name || 'Worker',
    jobDescription,
    cadence: coerceCadence(e.cadence),
    maxItemsPerShift,
    budgetUSDPerMonth,
    heartbeatModel,
    flowId,
    flowRequest,
    projectPath,
  };
}

/// Weekday-mornings is the fallback cadence: frequent enough to feel alive,
/// bounded enough to never surprise anyone with a 2am shift.
const DEFAULT_CADENCE: ScheduleTrigger = { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] };

function coerceCadence(raw: unknown): ScheduleTrigger {
  if (!raw || typeof raw !== 'object') return DEFAULT_CADENCE;
  const c = raw as Record<string, unknown>;
  const days = Array.isArray(c.days)
    ? c.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
    : undefined;
  if (c.kind === 'interval') {
    const every = Number(c.everyMinutes);
    if (!Number.isFinite(every)) return DEFAULT_CADENCE;
    const win = c.window as { start?: unknown; end?: unknown } | undefined;
    const window =
      win &&
      typeof win.start === 'string' &&
      typeof win.end === 'string' &&
      parseTimeOfDay(win.start) &&
      parseTimeOfDay(win.end) &&
      win.start !== win.end
        ? { start: win.start, end: win.end }
        : undefined;
    return {
      kind: 'interval',
      everyMinutes: Math.max(WORKER_MIN_INTERVAL_MINUTES, Math.floor(every)),
      days: days && days.length > 0 ? days : undefined,
      window,
    };
  }
  if (c.kind === 'daily') {
    const time = typeof c.time === 'string' && parseTimeOfDay(c.time) ? c.time : '09:00';
    return { kind: 'daily', time, days: days && days.length > 0 ? days : undefined };
  }
  return DEFAULT_CADENCE;
}
