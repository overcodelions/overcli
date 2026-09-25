// The facts the Today page's columns need, derived from the same spine the
// page has always read. Pure so the arithmetic — what counts as today, which
// hour a job lands in, what a headline says — is tested rather than eyeballed.

import type { QueueRow } from './workQueue';
import type { SpineItem, TodaySpine } from './todaySpine';
import { startOfDay } from './workerDeskSelectors';

/// One bar of the rail's day chart.
export interface HourBucket {
  hour: number;
  count: number;
  /// Whose work the bar is tinted by: the latest job in that hour.
  workerId?: string;
  failed: boolean;
  /// Still ahead of now — drawn fainter, since nothing can have happened.
  future: boolean;
}

/// The day as 24 hourly buckets, counting the jobs that finished in each.
export function hourBuckets(spine: TodaySpine, now: number): HourBucket[] {
  const day = startOfDay(now);
  const currentHour = Math.floor((now - day) / 3_600_000);
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0,
    failed: false,
    future: hour > currentHour,
  }));
  // `below` is newest first, so the first job seen in a bucket is its latest.
  for (const item of spine.below) {
    if (item.kind !== 'job' || item.row.at < day) continue;
    const b = buckets[Math.min(23, Math.floor((item.row.at - day) / 3_600_000))];
    b.count += 1;
    b.workerId ??= item.row.workerId;
    if (item.row.status === 'failed') b.failed = true;
  }
  return buckets;
}

/// The finished jobs of the day, newest first.
export function finishedJobs(spine: TodaySpine): QueueRow[] {
  return spine.below
    .filter((item): item is Extract<SpineItem, { kind: 'job' }> => item.kind === 'job')
    .map((item) => item.row);
}


/// Completed work from before today, grouped by day — "Yesterday", then the
/// weekday names — so the inbox keeps what landed while you were away instead
/// of forgetting it at midnight. Shifts that found nothing are left out: they
/// are a fact about the day, not something to go back and read.
export function earlierDays(
  finished: QueueRow[],
  now: number,
  days = 7,
  limit = 40,
): Array<{ label: string; rows: QueueRow[] }> {
  const today = startOfDay(now);
  const cutoff = today - days * 86_400_000;
  const groups = new Map<number, QueueRow[]>();
  let taken = 0;
  // `finished` is newest first, so the limit keeps the most recent.
  for (const row of finished) {
    if (row.at >= today || row.at < cutoff) continue;
    if (row.status === 'quiet' && row.task === 'shift') continue;
    if (taken >= limit) break;
    const day = startOfDay(row.at);
    const list = groups.get(day) ?? [];
    list.push(row);
    groups.set(day, list);
    taken += 1;
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([day, rows]) => ({
      label:
        day === startOfDay(today - 1)
          ? 'Yesterday'
          : new Date(day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }),
      rows,
    }));
}
