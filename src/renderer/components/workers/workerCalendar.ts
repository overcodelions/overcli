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

import { nextOccurrenceAfter } from '@shared/flows/schedule';
import type { Orchestration } from '@shared/flows/orchestration';
import type { Worker, WorkerTrustLevel } from '@shared/flows/worker';

import { orchestrationTask, startOfDay } from './workerDeskSelectors';

export interface CalendarEntry {
  workerId: string;
  workerName: string;
  trust: WorkerTrustLevel;
  kind: 'worked' | 'planned';
  /// When the shift starts. Its length is SHIFT_MINUTES — a worker's shift
  /// has no recorded duration (the planning turn is quick, the runs it
  /// launches are not), so the block stands for "this worker is on at this
  /// hour" rather than claiming to measure anything.
  at: number;
  /// Worked entries only.
  title?: string;
  orchestrationId?: string;
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

/// Every occurrence of `worker`'s cadence inside [from, end).
///
/// `seed` is the engine's own answer for the next shift (`nextShiftAt`), which
/// accounts for the last shift worked and the anchor. Without it a projection
/// re-derived from the cadence alone can disagree with the number the worker's
/// own page shows, and the calendar would be quietly wrong about the one
/// occurrence the user can check.
export function projectShifts(
  worker: Pick<Worker, 'cadence' | 'enabled'>,
  from: number,
  end: number,
  seed?: number | null,
): number[] {
  if (!worker.enabled) return [];
  const out: number[] = [];
  let at = seed ?? nextOccurrenceAfter(worker.cadence, from);
  // A seed in the past (a worker overdue for its shift, or a window opened
  // while the app was closed) still belongs on today's column: it is due.
  if (at < from) at = nextOccurrenceAfter(worker.cadence, from);
  for (let i = 0; i < MAX_PROJECTED && at < end; i++) {
    if (at >= from) out.push(at);
    const next = nextOccurrenceAfter(worker.cadence, at);
    if (next <= at) break; // never advanced — refuse to spin
    at = next;
  }
  return out;
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
      workerId: w.id,
      workerName: w.name,
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

/// The grid: `days` columns from the local midnight of `from`, each holding
/// what was worked and what is projected, in clock order.
export function workerCalendar(args: {
  workers: Record<string, Worker>;
  orchestrations: Record<string, Orchestration>;
  nextShiftAt: Record<string, number | null>;
  from: number;
  days: number;
  now: number;
}): CalendarDay[] {
  const { start, end } = calendarWindow(args.from, args.days);
  const roster = Object.values(args.workers);

  const entries: CalendarEntry[] = workedShifts(
    args.orchestrations,
    args.workers,
    start,
    end,
  );

  // Projection only runs forward from now. Back-filling a past week with what
  // the cadence "would have" fired is a claim about history that the journal
  // already answers truthfully — and answers differently, whenever the app was
  // closed or the worker was paused.
  const projectFrom = Math.max(start, args.now);
  for (const w of roster) {
    for (const at of projectShifts(w, projectFrom, end, args.nextShiftAt[w.id])) {
      entries.push({
        workerId: w.id,
        workerName: w.name,
        trust: w.trust,
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
