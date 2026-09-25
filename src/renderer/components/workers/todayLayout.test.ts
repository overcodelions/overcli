import { describe, expect, it } from 'vitest';

import { buildTodaySpine } from './todaySpine';
import { earlierDays, finishedJobs, hourBuckets } from './todayLayout';
import type { QueueRow, WorkQueue } from './workQueue';

const HOUR = 3_600_000;
const day = new Date('2026-08-24T00:00:00').getTime();
const at = (h: number, m = 0) => day + h * HOUR + m * 60_000;
const NOW = at(16, 30);

function row(key: string, when: number, over: Partial<QueueRow> = {}): QueueRow {
  return { key, workerId: 'w1', workerName: 'Triage', task: 'shift', status: 'done', title: key, steps: [], at: when, ...over } as QueueRow;
}
function spineOf(finished: QueueRow[]) {
  const queue: WorkQueue = { running: [], needsYou: [], finished };
  return buildTodaySpine(queue, [], NOW);
}

describe('hourBuckets', () => {
  it('counts the day by hour, tints by the latest job, and marks the hours still ahead', () => {
    const buckets = hourBuckets(
      spineOf([
        row('late', at(8, 40), { workerId: 'w2' }),
        row('early', at(8, 5)),
        row('broke', at(2, 27), { status: 'failed' }),
      ]),
      NOW,
    );
    expect(buckets).toHaveLength(24);
    expect(buckets[8]).toMatchObject({ count: 2, workerId: 'w2', failed: false, future: false });
    expect(buckets[2]).toMatchObject({ count: 1, failed: true });
    expect(buckets[16].future).toBe(false);
    expect(buckets[17].future).toBe(true);
  });

  it('leaves out anything from before today', () => {
    const buckets = hourBuckets(spineOf([row('yesterday', at(-2))]), NOW);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });
});

describe('finishedJobs', () => {
  it('lists the jobs, not the hour markers or quiet gaps between them', () => {
    const jobs = finishedJobs(spineOf([row('a', at(15)), row('b', at(9))]));
    expect(jobs.map((j) => j.key)).toEqual(['a', 'b']);
  });
});


describe('earlierDays', () => {
  it('groups the week before today by day, newest first, without empty shifts', () => {
    const groups = earlierDays(
      [
        row('today', at(9)),
        row('yday-late', at(-2)),
        row('yday-quiet', at(-3), { status: 'quiet', task: 'shift' }),
        row('yday-answer', at(-4), { status: 'quiet', task: 'errand' }),
        row('three-days', at(-60)),
        row('too-old', at(-24 * 9)),
      ],
      NOW,
    );
    expect(groups.map((g) => g.label)[0]).toBe('Yesterday');
    expect(groups[0].rows.map((r) => r.key)).toEqual(['yday-late', 'yday-answer']);
    expect(groups.flatMap((g) => g.rows.map((r) => r.key))).toEqual(['yday-late', 'yday-answer', 'three-days']);
  });

  it('stops at the limit, keeping the most recent', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`, at(-2 - i)));
    expect(earlierDays(rows, NOW, 7, 2).flatMap((g) => g.rows.map((r) => r.key))).toEqual(['r0', 'r1']);
  });
});
