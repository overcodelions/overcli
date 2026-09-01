// The Workers tab's front page: one day, every worker, in the order it
// happened.
//
// The work queue answered three questions in three framed bands — what is
// moving, what needs a decision, what landed — and on a normal day two of
// them were empty boxes announcing a zero. Worse, the three bands each sorted
// their own rows, so the day arrived as three lists and never as a day: you
// could not see that four jobs landed inside twelve minutes at 10am and then
// nothing happened until noon.
//
// So this is a SPINE and not a set of bands. One column, in time order, with
// the now-line in the middle of it: what is about to start above, what has
// happened below. An idle crew costs a short spine rather than three empty
// sections — the absence of work is drawn as the absence of rows, which is
// the only honest way to draw it.
//
// TWO THINGS ARE DELIBERATELY OUT OF TIME ORDER, and both for the same
// reason: a page whose reading order is the clock will bury the one row that
// was asking for something. A decision is lifted out of the day and pinned
// over the now-line, and live work is held at the now-line rather than at the
// hour it started. Both keep their own stamps ("asked at 11:52", "6m"), so
// the page never pretends they happened when they are drawn.
//
// It reads the SAME `WorkQueue` the queue page reads. Two front pages over
// one dataset is a maintenance bill; two selectors over one dataset is two
// answers, which is worse.

import type { QueueRow, UpcomingRow, WorkQueue } from './workQueue';

import { SOON_HORIZON_MS } from './workQueue';

import { startOfDay } from './workerDeskSelectors';

/// A gap worth drawing. Below this, the space between two rows is just the
/// gap between two rows; above it, it is a fact about the day — the crew was
/// idle, or asleep, or nobody had scheduled anything.
export const QUIET_GAP_MS = 45 * 60 * 1000;

/// What hangs off the spine below the now-line.
export type SpineItem =
  /// The hour changed. Drawn as a marker rather than as a row per hour,
  /// because an hour nothing happened in has no row to hang a label on.
  | { kind: 'hour'; key: string; at: number; label: string }
  /// A stretch with nothing in it, named ("2h 39m quiet"). The alternative
  /// is a proportional axis, which spends most of a night's height on
  /// nothing and squeezes the ten minutes that actually mattered.
  | { kind: 'quiet'; key: string; label: string }
  | { kind: 'job'; key: string; row: QueueRow };

export interface TodaySpine {
  /// Shifts about to start. Ordered FURTHEST FIRST so the column reads
  /// downward toward the now-line — up the page is further into the future.
  upcoming: UpcomingRow[];
  /// Decisions, lifted out of the day and pinned directly above the
  /// now-line. Newest first: the most recent question is the one still warm.
  pinned: QueueRow[];
  /// Work in flight, held at the now-line whatever hour it started. A job
  /// six hours in is not a fact about six hours ago.
  live: QueueRow[];
  /// Today, behind the now-line, newest first.
  below: SpineItem[];
  /// What the headline counts. `done` is every job that finished today,
  /// including the quiet shifts that finished nothing — they are still the
  /// crew having looked.
  done: number;
  /// Of those, how many failed. Called out separately because a failure is
  /// the one finished row you might have to do something about.
  failed: number;
}

/// Which pending shifts the spine draws.
///
/// Everything inside `SOON_HORIZON_MS`, AND ALWAYS THE SOONEST ONE, however far
/// off it is. That second clause is the difference between a band and a
/// spine. A band could be absent and mean "nothing soon", because a band that
/// is present is a framed box you have to look at either way. Above a
/// now-line, an absent row means nothing at all — it reads exactly like a
/// page that forgot to load, which is precisely how it was first reported.
///
/// And "when does anything next happen" is a question the crew's front page
/// should always answer. One dimmed line at the top is a cheap way to always
/// answer it; silence is not an answer, it is an ambiguity.
export function trimUpcoming(upcoming: UpcomingRow[], now: number): UpcomingRow[] {
  const near = upcoming.filter((row) => row.at - now <= SOON_HORIZON_MS);
  return near.length > 0 ? near : upcoming.slice(0, 1);
}

/// One mark on the day bar — the strip that replaced the metric tiles.
///
/// Positions are a PERCENTAGE of the span actually worked, not of the 24-hour
/// day: a crew that ran from 02:25 to noon should fill the bar, not huddle in
/// the left third of a midnight-to-midnight axis nobody asked about.
export interface DayTick {
  key: string;
  workerId: string;
  /// 0-100, left to right.
  pct: number;
  /// A failure is drawn differently — see the pane.
  failed: boolean;
}

export function buildTodaySpine(
  queue: WorkQueue,
  /// EVERY pending shift, soonest first — `upcomingShifts(..., Infinity)`.
  /// The spine does its own trimming, because it can afford a different
  /// answer than a band could: see `trimUpcoming`.
  upcoming: UpcomingRow[],
  now: number,
): TodaySpine {
  const midnight = startOfDay(now);
  const today = queue.finished.filter((row) => row.at >= midnight);

  const below: SpineItem[] = [];
  let lastHour: string | null = null;
  today.forEach((row, i) => {
    const previous = today[i - 1];
    // Measured against the row ABOVE, which is the later one — the list runs
    // backwards through the day.
    if (previous && previous.at - row.at >= QUIET_GAP_MS) {
      below.push({
        kind: 'quiet',
        key: `quiet:${row.key}`,
        label: `${describeGap(previous.at - row.at)} quiet`,
      });
    }
    const label = hourLabel(row.at);
    if (label !== lastHour) {
      below.push({ kind: 'hour', key: `hour:${label}:${row.key}`, at: row.at, label });
      lastHour = label;
    }
    below.push({ kind: 'job', key: row.key, row });
  });

  return {
    // `upcomingShifts` hands them over soonest-first; the spine reads the
    // other way, so this is the one place the order is flipped.
    upcoming: trimUpcoming(upcoming, now).reverse(),
    pinned: queue.needsYou,
    live: queue.running,
    below,
    done: today.length,
    failed: today.filter((row) => row.status === 'failed').length,
  };
}

/// The day bar's marks. Separate from the spine because it answers a
/// different question — the SHAPE of the day, which is the one thing a list
/// of rows cannot show however well it is sorted.
export function dayTicks(spine: TodaySpine, now: number): { ticks: DayTick[]; from: number } {
  const jobs = spine.below.filter((item): item is Extract<SpineItem, { kind: 'job' }> =>
    item.kind === 'job',
  );
  if (jobs.length === 0) return { ticks: [], from: now };
  // The span starts at the first thing that happened, not at midnight.
  const from = jobs[jobs.length - 1].row.at;
  const span = Math.max(now - from, 1);
  return {
    from,
    ticks: jobs.map(({ row }) => ({
      key: row.key,
      workerId: row.workerId,
      pct: Math.min(100, Math.max(0, ((row.at - from) / span) * 100)),
      failed: row.status === 'failed',
    })),
  };
}

/// The hour labels that fit under a bar of this width, evenly spaced and on
/// the hour. Computed rather than hardcoded because the span is the day so
/// far — at 06:00 it is four hours wide and at 23:00 it is twenty.
export function barHours(from: number, now: number, wanted = 4): Array<{ at: number; label: string; pct: number }> {
  const span = Math.max(now - from, 1);
  const hours = span / 3_600_000;
  // Step up through the sensible dial gradations rather than dividing the
  // span: labels that read 04:37, 07:12, 09:47 are a ruler nobody can use.
  const step = [1, 2, 3, 4, 6, 12].find((s) => hours / s <= wanted) ?? 24;
  // Phased from MIDNIGHT, not from where the crew happened to start. Stepping
  // out from 02:14 gives 5 AM, 8 AM, 11 AM — a ruler with its own private
  // idea of where the hours are. Aligning to the day gives 3, 6, 9, 12.
  const midnight = new Date(from);
  midnight.setHours(0, 0, 0, 0);
  const out: Array<{ at: number; label: string; pct: number }> = [];
  for (let h = 0; ; h += step) {
    const at = midnight.getTime() + h * 3_600_000;
    if (at > now) break;
    if (at < from) continue;
    out.push({ at, label: hourLabel(at), pct: ((at - from) / span) * 100 });
  }
  return out;
}

/// "2h 39m", "44m". Never "0m" — anything under the threshold is not drawn.
export function describeGap(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

/// "10 AM", "12 PM". The hour alone: the minute is on the row.
export function hourLabel(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${h < 12 ? 'AM' : 'PM'}`;
}

/// "10:26" — the row's own stamp, always two digits, never a meridiem. The
/// hour marker above it has already said AM or PM, and repeating it on every
/// row is eleven words of noise down a column that has to stay a column.
export function clockStamp(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours() % 12 === 0 ? 12 : d.getHours() % 12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
