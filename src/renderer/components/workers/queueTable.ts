// The work queue as a FIND SURFACE.
//
// It used to be the tab's landing page, and it was shaped like one: three
// framed bands answering "what is moving, what needs a decision, what landed
// today", two of which spent a bordered box announcing a zero on any normal
// day. That job now belongs to the Today spine, which can answer it in a
// column with a now-line in it.
//
// So this page changes question. Today is bounded by time and unbounded in
// depth — one day, every worker, at a glance. The queue is bounded by nothing
// and unbounded in reach — any day, any worker, found by searching rather
// than by scrolling to the hour it happened. Hold that line and the two never
// overlap; let the queue become "today's jobs, in a table" and it is the
// front page again with worse typography.
//
// Which is why everything here is a filter and nothing here is a band. The
// three bands survive as four pills, because a state you can switch to is
// worth a pill and a state you cannot is worth nothing at all — an empty
// band cost a header, a border, a count and forty pixels to say "none".

import { startOfDay } from './workerDeskSelectors';

import type { QueueRow, QueueStatus, WorkQueue } from './workQueue';

/// The four states a row can be in, as the page lets you filter them.
///
/// Mutually exclusive on purpose. `failed` is really a kind of finished, and
/// drawing it as a subset would give two pills whose counts overlap — a row
/// of numbers that does not add up is worse than a coarser split.
export type RowState = 'running' | 'needsYou' | 'done' | 'failed';

/// How far back the table reaches.
export type QueueRange = 'today' | '7d' | '30d' | 'all';

export const RANGES: Array<{ id: QueueRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'all', label: 'All' },
];

export interface QueueFilters {
  range: QueueRange;
  /// Null is "every state" — the resting position, because this page is
  /// reached to find something and you rarely know its state first.
  state: RowState | null;
  /// Free text, already lowercased by the caller or not — matched
  /// case-insensitively either way.
  query: string;
  workerId: string | null;
}

export const NO_FILTERS: QueueFilters = { range: 'today', state: null, query: '', workerId: null };

/// `orphaned` sits with the failures rather than with the done.
///
/// It means the run behind a finished-looking item is gone — deleted, pruned,
/// lost with its worktree. Nothing can be decided about it, which is why the
/// bands file it under finished; but it is not a success, and "failed" is
/// where a person goes looking for work that did not produce what it should
/// have.
export function stateOf(status: QueueStatus): RowState {
  if (status === 'running' || status === 'responding' || status === 'queued' || status === 'planning') {
    return 'running';
  }
  if (status === 'paused' || status === 'proposed') return 'needsYou';
  if (status === 'failed' || status === 'orphaned') return 'failed';
  return 'done';
}

/// Midnight of the oldest day the range includes. `all` reaches back to the
/// beginning of what the renderer holds, which is however many orchestrations
/// survived pruning — the page says so rather than implying it has everything.
export function rangeFrom(range: QueueRange, now: number): number {
  if (range === 'all') return 0;
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29;
  return startOfDay(now) - days * 86_400_000;
}

/// Every row the page could show, before any filter — running and waiting
/// rows first-class alongside the finished ones, because this is a list of
/// JOBS and a job that is still going is not a different species.
export function allRows(queue: WorkQueue): QueueRow[] {
  return [...queue.running, ...queue.needsYou, ...queue.finished].sort(
    (a, b) => b.at - a.at || a.key.localeCompare(b.key),
  );
}

/// Text match over what a person actually remembers about a job: what it was
/// called, who did it, and which flow it ran. Deliberately NOT the filed
/// deliverable's name — that arrives asynchronously per row, so searching it
/// would return different results depending on how long you had been looking
/// at the page.
export function matchesQuery(row: QueueRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    row.title.toLowerCase().includes(q) ||
    row.workerName.toLowerCase().includes(q) ||
    (row.flowName?.toLowerCase().includes(q) ?? false)
  );
}

export function tableRows(queue: WorkQueue, filters: QueueFilters, now: number): QueueRow[] {
  const from = rangeFrom(filters.range, now);
  return allRows(queue).filter(
    (row) =>
      row.at >= from &&
      (!filters.workerId || row.workerId === filters.workerId) &&
      (!filters.state || stateOf(row.status) === filters.state) &&
      matchesQuery(row, filters.query),
  );
}

/// What each pill says.
///
/// Counted with every filter applied EXCEPT the state one, so the numbers
/// answer "what would I get if I clicked this" rather than "what am I looking
/// at" — a pill reading 0 next to a list of eleven rows is the second
/// question answered where the first was asked.
export function stateCounts(
  queue: WorkQueue,
  filters: QueueFilters,
  now: number,
): Record<RowState, number> {
  const counts: Record<RowState, number> = { running: 0, needsYou: 0, done: 0, failed: 0 };
  for (const row of tableRows(queue, { ...filters, state: null }, now)) {
    counts[stateOf(row.status)] += 1;
  }
  return counts;
}

/// The workers with anything in the current reach, for the worker picker.
/// Built from the rows rather than from the roster so the menu never offers a
/// name that would filter the table to nothing.
export function workersInView(queue: WorkQueue, filters: QueueFilters, now: number) {
  const seen = new Map<string, { id: string; name: string; count: number }>();
  for (const row of tableRows(queue, { ...filters, workerId: null, state: null }, now)) {
    const found = seen.get(row.workerId);
    if (found) found.count += 1;
    else seen.set(row.workerId, { id: row.workerId, name: row.workerName, count: 1 });
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/// The page's opening line.
///
/// The original page led with a sentence and I deleted it, on the grounds
/// that it duplicated the three metric tiles beside it. It did — but the
/// right cut was the TILES. A page that opens with a search field opens with
/// chrome; a page that opens with a sentence opens with what happened, and
/// that is the difference between a tool and a form.
///
/// Counted from the rows actually in reach, so the sentence and the list
/// below it can never disagree about the same day.
export function describeState(counts: Record<RowState, number>, range: QueueRange): string {
  const finished = counts.done + counts.failed;
  const when =
    range === 'all'
      ? 'in all'
      : range === 'today'
        ? 'today'
        : `in the last ${RANGES.find((r) => r.id === range)!.label.toLowerCase()}`;
  if (counts.running === 0 && counts.needsYou === 0 && finished === 0) {
    return range === 'today' ? 'Nothing has run today.' : `Nothing has run ${when}.`;
  }

  const parts: string[] = [
    counts.running === 0
      ? 'Nothing running'
      : `${counts.running} job${counts.running === 1 ? '' : 's'} running`,
  ];
  if (counts.needsYou > 0) parts.push(`${counts.needsYou} waiting on you`);
  parts.push(
    finished === 0 ? `nothing finished ${when}` : `${finished} finished ${when}`,
  );
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
}

/// Work that is happening or waiting, split out from work that is over.
///
/// The table sorts by time, and for a while that was the whole contract:
/// Today was the page that reordered for attention, this one stayed honest
/// about the clock. That was wrong in one specific way — a job that started
/// six hours ago is still running NOW, and strict time order buries it six
/// hours down a list where you will never see it. A stamp is not the same
/// fact as a state.
///
/// So live and waiting work is hoisted, and it keeps its real stamp: the row
/// still says when it started, it is simply drawn where you can see it.
export function partitionLive(rows: QueueRow[]): { live: QueueRow[]; history: QueueRow[] } {
  const live: QueueRow[] = [];
  const history: QueueRow[] = [];
  for (const row of rows) {
    const state = stateOf(row.status);
    if (state === 'running' || state === 'needsYou') live.push(row);
    else history.push(row);
  }
  return { live, history };
}

/// What to call the hoisted block. Whichever is the more urgent thing in it
/// leads — a decision outranks a job that is merely working.
export function describeLive(rows: QueueRow[]): string {
  const waiting = rows.filter((r) => stateOf(r.status) === 'needsYou').length;
  const working = rows.length - waiting;
  if (waiting > 0 && working > 0) {
    return `${waiting} waiting on you · ${working} working`;
  }
  if (waiting > 0) return waiting === 1 ? 'Waiting on you' : `${waiting} waiting on you`;
  return working === 1 ? 'Working now' : `${working} working now`;
}

/// The next stop out on the range control.
export function widerRange(range: QueueRange): QueueRange | null {
  const i = RANGES.findIndex((r) => r.id === range);
  return RANGES[i + 1]?.id ?? null;
}

/// What widening the reach by one stop would actually get you.
///
/// A table that ends after twelve rows with half a screen below it reads as a
/// crew that has done nothing, when what it really means is that the range is
/// set to today. Naming the work just outside the window turns dead space
/// into the page's own answer to "is that all?" — and it is the cheapest
/// possible teacher for the range control, which otherwise has to be noticed
/// before it can be used.
export function moreBeyond(
  queue: WorkQueue,
  filters: QueueFilters,
  now: number,
): { range: QueueRange; label: string; count: number } | null {
  const wider = widerRange(filters.range);
  if (!wider) return null;
  const count =
    tableRows(queue, { ...filters, range: wider }, now).length -
    tableRows(queue, filters, now).length;
  if (count <= 0) return null;
  return { range: wider, label: RANGES.find((r) => r.id === wider)!.label, count };
}

/// One line under the table saying what you are actually looking at.
///
/// The table can be filtered four ways at once, and a list that has silently
/// dropped ninety rows looks exactly like a crew that did nothing. This is
/// the page admitting what it left out.
export function describeReach(shown: number, filters: QueueFilters, total: number): string {
  const scope =
    filters.range === 'all'
      ? 'everything still on disk'
      : filters.range === 'today'
        ? 'today'
        : `the last ${RANGES.find((r) => r.id === filters.range)!.label.toLowerCase()}`;
  const where = filters.range === 'today' ? scope : `in ${scope}`;
  if (shown === total) {
    return shown === 0
      ? `Nothing ${where}.`
      : `${shown} job${shown === 1 ? '' : 's'} ${where}.`;
  }
  return `${shown} of ${total} job${total === 1 ? '' : 's'} ${where}.`;
}
