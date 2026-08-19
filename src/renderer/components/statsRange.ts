import { DailyBucket } from '@shared/types';

export type RangeKey = '7d' | '30d' | '90d' | '1y';
export const RANGE_KEYS: RangeKey[] = ['7d', '30d', '90d', '1y'];
export const RANGE_DAYS: Record<RangeKey, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

export function bucketTokens(d: DailyBucket): number {
  return d.inputTokens + d.outputTokens;
}

/// Trailing `days` buckets with leading empty days dropped. Claude prunes
/// its transcripts after ~30 days, so a fixed 90-day window otherwise
/// opens on a wall of zeroes that reads as "you did nothing".
export function sliceRange(daily: DailyBucket[], days: number): DailyBucket[] {
  const tail = daily.slice(Math.max(0, daily.length - days));
  let start = 0;
  while (start < tail.length - 1 && bucketTokens(tail[start]) === 0 && tail[start].turns === 0) {
    start += 1;
  }
  return tail.slice(start);
}

/// Trailing mean over `window` points, so the trend line reads through
/// day-to-day spikes.
export function movingAverage(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - window + 1);
    const slice = values.slice(from, i + 1);
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}
