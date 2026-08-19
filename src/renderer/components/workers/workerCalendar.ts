// Where the roster's shifts actually fall, across every worker at once.
//
// A worker's cadence is legible one worker at a time ("every weekday at
// 09:00") and illegible six workers at a time — you cannot tell from six such
// sentences that four of them land in the same ten minutes, or that Thursday
// is empty. This module turns cadences into occurrences on a day grid so the
// answer is a shape rather than an inference.
//
// Two kinds of entry share the grid. WORKED shifts are history, read off the
// orchestrations the renderer already has. PLANNED shifts are projection —
// `nextOccurrenceAfter` walked forward from now — and are therefore a forecast
// that a paused worker, an edited cadence or a missed window will invalidate.
// They are rendered differently for that reason; the distinction is not
// cosmetic.
//
// SCHEDULES share the grid too, and for the same reason the workers do: a
// schedule that fires every hour and a worker that wakes at 09:00 compete for
// the same machine, the same project and the same attention, so a week view
// that draws only half of the unattended work is answering "when does everyone
// work" with a partial roster. They stay a distinct species on the grid
// (`source`) rather than being flattened into fake workers — a schedule has no
// trust, no desk and no judgement, and drawing it as a worker would claim
// otherwise.

import { nextOccurrenceAfter } from '@shared/flows/schedule';
import type { Schedule, ScheduleTrigger } from '@shared/flows/schedule';
import type { Orchestration } from '@shared/flows/orchestration';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { Worker, WorkerTrustLevel } from '@shared/flows/worker';

import { orchestrationTask, startOfDay } from './workerDeskSelectors';

export interface CalendarEntry {
  /// Which mechanism put this block on the grid. Not cosmetic: it decides
  /// what clicking it can open, and whether `trust` means anything.
  source: 'worker' | 'schedule';
  /// The rule's id — a worker id or a schedule id.
  subjectId: string;
  subjectName: string;
  /// Workers only. A schedule has no standing to encode.
  trust?: WorkerTrustLevel;
  kind: 'worked' | 'planned';
  /// When the shift starts. Its length is SHIFT_MINUTES — a worker's shift
  /// has no recorded duration (the planning turn is quick, the runs it
  /// launches are not), so the block stands for "this worker is on at this
  /// hour" rather than claiming to measure anything.
  at: number;
  /// Worked entries only.
  title?: string;
  orchestrationId?: string;
  /// Set for a worked schedule firing that launched a flow run.
  runId?: string;
  /// Worked schedule firings record how they went; a worker's batch doesn't
  /// (its outcome is the items inside it).
  outcome?: 'launched' | 'done' | 'failed';
  needsReview?: boolean;
}

export interface CalendarDay {
  /// Local midnight, and the day's identity — the grid is keyed on it.
  at: number;
  entries: CalendarEntry[];
}

/// How much of the day one shift occupies on the grid. Nothing measures this
/// — see CalendarEntry.at — it is the block size that makes a rhythm legible
/// without pretending to be a duration.
export const SHIFT_MINUTES = 30;

export const MINUTES_IN_DAY = 24 * 60;

/// Hard stop on the forward walk, per worker per window. A cadence whose
/// occurrences never advance would otherwise loop; the cap makes that a
/// truncated column instead of a hung renderer.
const MAX_PROJECTED = 400;

/// `days` days starting at the local midnight of `from`.
export function calendarWindow(from: number, days: number): { start: number; end: number } {
  const start = startOfDay(from);
  const last = new Date(start);
  last.setDate(last.getDate() + days);
  return { start, end: last.getTime() };
}

/// Every occurrence of `trigger` inside [from, end).
///
/// `seed` is the engine's own answer for the next occurrence (`nextShiftAt` /
/// `nextFireAt`), which accounts for the last firing and the anchor. Without
/// it a projection re-derived from the trigger alone can disagree with the
/// number the subject's own page shows, and the calendar would be quietly
/// wrong about the one occurrence the user can check.
export function projectOccurrences(
  trigger: ScheduleTrigger,
  from: number,
  end: number,
  seed?: number | null,
): number[] {
  const out: number[] = [];
  let at = seed ?? nextOccurrenceAfter(trigger, from);
  // A seed in the past (a subject overdue for its turn, or a window opened
  // while the app was closed) still belongs on today's column: it is due.
  if (at < from) at = nextOccurrenceAfter(trigger, from);
  for (let i = 0; i < MAX_PROJECTED && at < end; i++) {
    if (at >= from) out.push(at);
    const next = nextOccurrenceAfter(trigger, at);
    if (next <= at) break; // never advanced — refuse to spin
    at = next;
  }
  return out;
}

/// Every occurrence of `worker`'s cadence inside [from, end).
export function projectShifts(
  worker: Pick<Worker, 'cadence' | 'enabled'>,
  from: number,
  end: number,
  seed?: number | null,
): number[] {
  if (!worker.enabled) return [];
  return projectOccurrences(worker.cadence, from, end, seed);
}

/// Shifts this roster already worked, inside the window. Errands are excluded:
/// an errand is something you asked for at a moment of your choosing, so it
/// says nothing about how the cadences lie against each other.
export function workedShifts(
  orchestrations: Record<string, Orchestration>,
  workers: Record<string, Worker>,
  start: number,
  end: number,
): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const o of Object.values(orchestrations)) {
    if (o.origin?.kind !== 'worker') continue;
    if (o.createdAt < start || o.createdAt >= end) continue;
    if (orchestrationTask(o) !== 'shift') continue;
    const w = workers[o.origin.workerId];
    // A fired worker's batches outlive it. They stay on the grid — the shift
    // did happen — but there is no trust level to tint them with.
    if (!w) continue;
    out.push({
      source: 'worker',
      subjectId: w.id,
      subjectName: w.name,
      trust: w.trust,
      kind: 'worked',
      at: o.createdAt,
      title: o.title,
      orchestrationId: o.id,
      needsReview: o.items.some((it) => it.status === 'proposed'),
    });
  }
  return out;
}

/// Firings each schedule already did, inside the window.
///
/// Read from `Schedule.history` rather than from the runs, because a schedule
/// has two target kinds — one mints a flow run, the other parks an
/// orchestration — and the history is the one record that covers both. It is
/// capped (SCHEDULE_HISTORY_LIMIT), so a busy schedule's older firings simply
/// fall off the back of the grid; the alternative is a second store of
/// per-firing rows that exists only to be drawn.
///
/// `skipped` firings are left off. A skip is a decision NOT to run, and a
/// block on a calendar says the opposite; the schedule's own page explains its
/// skips, where there is room to say why.
export function scheduleFirings(
  schedules: Record<string, Schedule>,
  orchestrations: Record<string, Orchestration>,
  start: number,
  end: number,
): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const s of Object.values(schedules)) {
    for (const record of s.history ?? []) {
      if (record.at < start || record.at >= end) continue;
      if (record.outcome === 'skipped') continue;
      const parked = record.orchestrationId
        ? orchestrations[record.orchestrationId]
        : undefined;
      out.push({
        source: 'schedule',
        subjectId: s.id,
        subjectName: s.name,
        kind: 'worked',
        at: record.at,
        title: record.note ?? s.name,
        runId: record.runId,
        orchestrationId: record.orchestrationId,
        outcome: record.outcome,
        needsReview: parked ? isOrchestrationAwaitingApproval(parked) : false,
      });
    }
  }
  return out;
}

/// The grid: `days` columns from the local midnight of `from`, each holding
/// what was worked and what is projected, in clock order.
export function workerCalendar(args: {
  workers: Record<string, Worker>;
  orchestrations: Record<string, Orchestration>;
  nextShiftAt: Record<string, number | null>;
  /// Omitted (or empty) draws workers only — which is what the calendar did
  /// before schedules joined it, and what the header's toggle asks for.
  schedules?: Record<string, Schedule>;
  nextFireAt?: Record<string, number | null>;
  from: number;
  days: number;
  now: number;
}): CalendarDay[] {
  const { start, end } = calendarWindow(args.from, args.days);
  const roster = Object.values(args.workers);
  const schedules = args.schedules ?? {};
  const nextFireAt = args.nextFireAt ?? {};

  const entries: CalendarEntry[] = [
    ...workedShifts(args.orchestrations, args.workers, start, end),
    ...scheduleFirings(schedules, args.orchestrations, start, end),
  ];

  // Projection only runs forward from now. Back-filling a past week with what
  // the cadence "would have" fired is a claim about history that the journal
  // already answers truthfully — and answers differently, whenever the app was
  // closed or the worker was paused.
  const projectFrom = Math.max(start, args.now);
  for (const w of roster) {
    for (const at of projectShifts(w, projectFrom, end, args.nextShiftAt[w.id])) {
      entries.push({
        source: 'worker',
        subjectId: w.id,
        subjectName: w.name,
        trust: w.trust,
        kind: 'planned',
        at,
      });
    }
  }
  for (const s of Object.values(schedules)) {
    if (!s.enabled) continue;
    for (const at of projectOccurrences(s.trigger, projectFrom, end, nextFireAt[s.id])) {
      entries.push({
        source: 'schedule',
        subjectId: s.id,
        subjectName: s.name,
        kind: 'planned',
        at,
      });
    }
  }

  const byDay = new Map<number, CalendarEntry[]>();
  for (let i = 0; i < args.days; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    byDay.set(d.getTime(), []);
  }
  for (const e of entries) {
    const key = startOfDay(e.at);
    byDay.get(key)?.push(e);
  }

  return [...byDay.entries()].map(([at, list]) => ({
    at,
    entries: list.sort((a, b) => a.at - b.at),
  }));
}

/// Where each of a day's shifts sits in its column, and how wide.
///
/// Two workers on at 09:00 must not be drawn on top of each other, so
/// overlapping blocks share the column's width the way a calendar app does:
/// cluster anything that overlaps, give each member its own lane, and let a
/// cluster of one keep the whole width. Greedy lane reuse (first lane whose
/// previous block has ended) is what keeps an hourly worker to one lane all
/// day instead of stepping sideways across the column.
export function layoutDay(
  entries: CalendarEntry[],
  minutes: number = SHIFT_MINUTES,
): PlacedEntry[] {
  const sorted = entries.slice().sort((a, b) => a.at - b.at);
  const placed: PlacedEntry[] = [];
  let group: PlacedEntry[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -1;

  const closeGroup = () => {
    for (const p of group) p.lanes = laneEnds.length;
    placed.push(...group);
    group = [];
    laneEnds = [];
    groupEnd = -1;
  };

  for (const entry of sorted) {
    const startMinutes = minutesIntoDay(entry.at);
    const endMinutes = Math.min(MINUTES_IN_DAY, startMinutes + minutes);
    // A block that starts at or after everything before it ended begins a new
    // cluster — nothing left to share width with.
    if (startMinutes >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(endMinutes);
    } else {
      laneEnds[lane] = endMinutes;
    }
    group.push({ entry, lane, lanes: 1, startMinutes, endMinutes });
    groupEnd = Math.max(groupEnd, endMinutes);
  }
  closeGroup();
  return placed;
}

export interface PlacedEntry {
  entry: CalendarEntry;
  /// Which sub-column of its cluster this block sits in.
  lane: number;
  /// How many sub-columns the cluster needs — the block's width is 1/lanes.
  lanes: number;
  startMinutes: number;
  endMinutes: number;
}

export function minutesIntoDay(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}

/// "09:00" — the only format a column this narrow has room for.
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayHeading(at: number): { weekday: string; day: string } {
  const d = new Date(at);
  return {
    weekday: d.toLocaleDateString([], { weekday: 'short' }),
    day: String(d.getDate()),
  };
}

export { startOfDay };

export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/// How many shifts land on that day.
export function dayLoad(day: CalendarDay): number {
  return day.entries.length;
}

/// The one entry a subject's next occurrence corresponds to, if it is on this
/// grid at all — how the up-next strip finds the block it is talking about, so
/// pointing at a chip can ring the block it names.
export function entryKey(entry: CalendarEntry): string {
  return `${entry.source}:${entry.subjectId}:${entry.kind}:${entry.orchestrationId ?? entry.at}`;
}

/// True when this block is the next occurrence of `subjectId` — the projected
/// one the up-next strip is counting down to.
export function isNextUp(
  entry: CalendarEntry,
  next: { source: string; id: string; at: number } | null,
): boolean {
  return (
    !!next &&
    entry.kind === 'planned' &&
    entry.source === next.source &&
    entry.subjectId === next.id &&
    entry.at === next.at
  );
}
