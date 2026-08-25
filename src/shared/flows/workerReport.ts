// The roster's report card: what the workers did, and what it cost.
//
// Pure and derived, like the treasury — main assembles the inputs (journal,
// batches, run summaries) and this decides what they mean, so the numbers on
// screen cannot drift from the numbers a test asserts.

import type { Orchestration } from './orchestration';
import type { Worker, WorkerJournalEntry } from './worker';

/// Estimated human effort replaced by one measured hour of agent runtime.
/// This is deliberately a single, visible assumption: unlike a flat estimate
/// per completed item, it scales with the size and duration of the work.
export const WORKER_HUMAN_TIME_SAVED_MULTIPLIER = 1.5;

/// One terminal run, as the report needs it. Structurally the subset of
/// main's `RunSummary` — declared here so shared owns no main imports.
export interface WorkerRunFact {
  workerId?: string;
  completed: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  wallClockMs: number;
  terminalAt: number;
}

export interface WorkerReportRow {
  workerId: string;
  name: string;
  enabled: boolean;
  /// Shifts whose planning turn actually ran (missed and defunded ones are
  /// counted separately — they are not work).
  shifts: number;
  /// Ran, and found nothing worth launching. A success, not a blank.
  quietShifts: number;
  /// Ran and spawned at least one item.
  workingShifts: number;
  failedShifts: number;
  /// Never ran: missed while the app was closed, or out of budget.
  skippedShifts: number;
  errands: number;
  proposed: number;
  approved: number;
  rejected: number;
  itemsDone: number;
  itemsFailed: number;
  itemsInFlight: number;
  runs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /// Measured: how long this worker's runs actually spent working.
  workedMs: number;
  /// Estimated: measured agent runtime in minutes ×
  /// `WORKER_HUMAN_TIME_SAVED_MULTIPLIER`.
  savedMinutes: number;
  lastShiftAt: number | null;
  /// This worker's own day-by-day, on the report's shared axis — same length
  /// and same days as `WorkerReport.daily`, so a row's sparkline and the
  /// roster chart above it line up column for column.
  daily: WorkerReportDay[];
}

/// One local day of the window. Every measure the report can plot over time
/// lives on the same bucket, so the chart's metric switch never has to change
/// which axis it is drawing against.
export interface WorkerReportDay {
  /// Local `YYYY-MM-DD`. Local rather than UTC because "did they work
  /// Saturday" is a question about the user's calendar, not about GMT.
  day: string;
  shifts: number;
  itemsDone: number;
  costUSD: number;
  workedMs: number;
  tokens: number;
}

/// The window's day axis, gap-filled: a day nobody worked is a zero bucket
/// and not a missing one, or a fortnight off would draw as a continuous run
/// of activity with a shorter axis.
export const WORKER_REPORT_MAX_DAYS = 180;

export type WorkerReportTotals = Omit<
  WorkerReportRow,
  'workerId' | 'name' | 'enabled' | 'lastShiftAt' | 'daily'
>;

export interface WorkerReport {
  generatedAt: number;
  /// Epoch ms floor for everything counted. 0 means all time.
  sinceMs: number;
  byWorker: WorkerReportRow[];
  totals: WorkerReportTotals;
  /// The whole roster, day by day — the same axis every row's `daily` uses.
  daily: WorkerReportDay[];
}

export interface WorkerReportInput {
  workers: Worker[];
  journal: (workerId: string) => WorkerJournalEntry[];
  orchestrations: Orchestration[];
  runs: WorkerRunFact[];
  sinceMs: number;
  generatedAt: number;
}

export function emptyWorkerReportTotals(): WorkerReportTotals {
  return {
    shifts: 0, quietShifts: 0, workingShifts: 0, failedShifts: 0, skippedShifts: 0,
    errands: 0, proposed: 0, approved: 0, rejected: 0,
    itemsDone: 0, itemsFailed: 0, itemsInFlight: 0,
    runs: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUSD: 0,
    workedMs: 0, savedMinutes: 0,
  };
}

const DAY_MS = 86_400_000;

/// Local `YYYY-MM-DD` for an instant.
export function reportDayKey(ts: number): string {
  const d = new Date(ts);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function emptyDay(day: string): WorkerReportDay {
  return { day, shifts: 0, itemsDone: 0, costUSD: 0, workedMs: 0, tokens: 0 };
}

/// A running per-day tally. Kept sparse while accumulating and gap-filled
/// against the shared axis at the end — a worker that worked twice in a
/// hundred days should not carry ninety-eight empty objects around until
/// the moment something actually needs them in order.
type DayLedger = Map<string, WorkerReportDay>;

function tally(ledger: DayLedger, ts: number, patch: Partial<WorkerReportDay>): void {
  const key = reportDayKey(ts);
  const bucket = ledger.get(key) ?? emptyDay(key);
  bucket.shifts += patch.shifts ?? 0;
  bucket.itemsDone += patch.itemsDone ?? 0;
  bucket.costUSD += patch.costUSD ?? 0;
  bucket.workedMs += patch.workedMs ?? 0;
  bucket.tokens += patch.tokens ?? 0;
  ledger.set(key, bucket);
}

function fillDays(ledger: DayLedger, axis: string[]): WorkerReportDay[] {
  return axis.map((day) => ledger.get(day) ?? emptyDay(day));
}

export function buildWorkerReport(input: WorkerReportInput): WorkerReport {
  const { workers, journal, orchestrations, runs, sinceMs, generatedAt } = input;

  const batchesById = new Map<string, Orchestration>();
  const batchesByWorker = new Map<string, Orchestration[]>();
  for (const o of orchestrations) {
    if (o.origin?.kind !== 'worker') continue;
    batchesById.set(o.id, o);
    const list = batchesByWorker.get(o.origin.workerId) ?? [];
    list.push(o);
    batchesByWorker.set(o.origin.workerId, list);
  }

  const runsByWorker = new Map<string, WorkerRunFact[]>();
  for (const r of runs) {
    if (!r.workerId || r.terminalAt < sinceMs) continue;
    const list = runsByWorker.get(r.workerId) ?? [];
    list.push(r);
    runsByWorker.set(r.workerId, list);
  }

  // The day axis can only be drawn once every event has been seen (all-time
  // has to start at the first thing that ever happened), so each worker's
  // days are tallied sparsely here and gap-filled against the shared axis
  // below.
  const ledgers = new Map<string, DayLedger>();
  let earliest = Infinity;
  const mark = (ts: number) => {
    if (ts < earliest) earliest = ts;
  };

  const byWorker = workers.map((w) => {
    const row: WorkerReportRow = {
      workerId: w.id,
      name: w.name,
      enabled: w.enabled,
      ...emptyWorkerReportTotals(),
      lastShiftAt: null,
      daily: [],
    };
    const ledger: DayLedger = new Map();
    ledgers.set(w.id, ledger);

    for (const e of journal(w.id)) {
      if (e.at < sinceMs) continue;
      if (e.kind === 'shift') {
        if (!e.title.trim()) {
          row.skippedShifts++;
          continue;
        }
        row.shifts++;
        tally(ledger, e.at, { shifts: 1 });
        mark(e.at);
        if (row.lastShiftAt === null || e.at > row.lastShiftAt) row.lastShiftAt = e.at;
        if ((e.note ?? '').startsWith('Failed:')) row.failedShifts++;
        else if ((batchesById.get(e.orchestrationId ?? '')?.items.length ?? 0) > 0)
          row.workingShifts++;
        else row.quietShifts++;
      } else if (e.kind === 'errand') row.errands++;
      else if (e.kind === 'proposed') row.proposed++;
      else if (e.kind === 'approved') row.approved++;
      else if (e.kind === 'rejected') row.rejected++;
    }

    for (const o of batchesByWorker.get(w.id) ?? []) {
      for (const item of o.items) {
        // An item belongs to the window it LANDED in, not the window its
        // batch was opened in. A shift proposed five weeks ago whose work
        // finished yesterday is work you got yesterday — and its run is
        // already counted that way (runs window on `terminalAt`), so dating
        // the item by its batch would show a week with cost and agent time
        // against zero jobs done.
        const at = item.finishedAt ?? o.createdAt;
        if (at < sinceMs) continue;
        if (item.status === 'done') {
          row.itemsDone++;
          tally(ledger, at, { itemsDone: 1 });
          mark(at);
        } else if (item.status === 'failed') row.itemsFailed++;
        else if (item.status !== 'cancelled' && item.status !== 'proposed') row.itemsInFlight++;
      }
    }

    for (const r of runsByWorker.get(w.id) ?? []) {
      row.runs++;
      row.turns += r.turns;
      row.inputTokens += r.inputTokens;
      row.outputTokens += r.outputTokens;
      row.costUSD += r.costUSD;
      row.workedMs += r.wallClockMs;
      tally(ledger, r.terminalAt, {
        costUSD: r.costUSD,
        workedMs: r.wallClockMs,
        tokens: r.inputTokens + r.outputTokens,
      });
      mark(r.terminalAt);
    }
    row.savedMinutes = (row.workedMs / 60_000) * WORKER_HUMAN_TIME_SAVED_MULTIPLIER;
    return row;
  });

  // A fixed window draws its whole span, empty days and all — "they worked
  // two of the last seven days" is the answer, and a chart that quietly
  // shortened its axis to the busy days would hide it. All-time has no floor
  // to start from, so it starts at the first thing that ever happened.
  const lastDay = startOfDay(generatedAt);
  const firstDay =
    sinceMs > 0
      ? startOfDay(sinceMs)
      : startOfDay(Number.isFinite(earliest) ? earliest : generatedAt);
  const axis: string[] = [];
  let cursor = startOfDay(Math.max(firstDay, lastDay - (WORKER_REPORT_MAX_DAYS - 1) * DAY_MS));
  while (cursor <= lastDay) {
    axis.push(reportDayKey(cursor));
    // Hop 27 hours and snap back to midnight. A flat +24h drifts across a
    // daylight-saving boundary (one local day is 23 or 25 hours), which
    // eventually emits a day twice or skips one; 27h is far enough past
    // either shift to always land on the next calendar day and no further.
    cursor = startOfDay(cursor + DAY_MS + 3 * 60 * 60 * 1000);
  }

  for (const row of byWorker) {
    row.daily = fillDays(ledgers.get(row.workerId) ?? new Map(), axis);
  }

  const totals = emptyWorkerReportTotals();
  for (const row of byWorker) {
    for (const key of Object.keys(totals) as Array<keyof WorkerReportTotals>) {
      totals[key] += row[key];
    }
  }

  const daily = axis.map((day, i) => {
    const bucket = emptyDay(day);
    for (const row of byWorker) {
      const d = row.daily[i];
      bucket.shifts += d.shifts;
      bucket.itemsDone += d.itemsDone;
      bucket.costUSD += d.costUSD;
      bucket.workedMs += d.workedMs;
      bucket.tokens += d.tokens;
    }
    return bucket;
  });

  return { generatedAt, sinceMs, byWorker, totals, daily };
}

/// "3h 12m" / "48m" / "—". For durations, not clock times.
export function formatWorkedTime(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins <= 0) return '—';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

/// "1.2M" / "48.3k" / "912".
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}
