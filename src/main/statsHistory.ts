// Daily activity snapshots.
//
// computeStats() re-derives the activity chart from whatever transcripts are
// still on disk, but Claude Code prunes its own after ~30 days — so a day's
// real numbers vanish from the chart a month after it happened, and the left
// half of the chart reads as "you did nothing" when it should read "we no
// longer know". Every scan merges its per-day totals into this file and the
// chart reads the merge, so a day outlives the transcripts it came from.
//
// The merge is max(), not overwrite and not sum:
//   - re-scanning a day whose transcripts survive returns the same or a higher
//     number (a later session landed that day) — max takes the newer one
//   - re-scanning a pruned day returns 0 — max keeps what we already stored
//   - max is idempotent, so two scans a minute apart can't double-count
// Day totals are recomputed as the sum of the merged per-backend buckets
// rather than max'd independently, so `turns` always equals the sum of its
// parts even when two backends' transcripts age out at different times.
//
// One JSON file at <userData>/stats-daily.json, atomic write (temp + rename)
// like the sibling stores. Only ever written from inside the Electron app —
// the stats CLI harness runs without `app`, and a read-only harness has no
// business rewriting history.

import fs from 'node:fs';
import path from 'node:path';
import { host } from './host';
import { Backend, DailyBackendBucket, DailyBucket } from '../shared/types';
import { logSilent } from './diagnostics';

/// Two years of rows is ~150KB and outlives any range the chart offers.
/// Older days are dropped on write.
const MAX_DAYS = 730;

/// Keyed by the same YYYY-MM-DD local-time key `dayKey()` produces.
export type DailyHistory = Record<string, DailyBucket>;

function emptyBackendBucket(): DailyBackendBucket {
  return { turns: 0, inputTokens: 0, outputTokens: 0, linesAdded: 0, linesDeleted: 0 };
}

function maxBackendBucket(
  a: DailyBackendBucket | undefined,
  b: DailyBackendBucket | undefined,
): DailyBackendBucket {
  const x = a ?? emptyBackendBucket();
  const y = b ?? emptyBackendBucket();
  return {
    turns: Math.max(x.turns, y.turns),
    inputTokens: Math.max(x.inputTokens, y.inputTokens),
    outputTokens: Math.max(x.outputTokens, y.outputTokens),
    linesAdded: Math.max(x.linesAdded, y.linesAdded),
    linesDeleted: Math.max(x.linesDeleted, y.linesDeleted),
  };
}

/// High-water-mark merge of one scanned day into its stored counterpart.
export function mergeDay(stored?: DailyBucket, scanned?: DailyBucket): DailyBucket {
  const day = scanned?.day ?? stored?.day ?? '';
  const backends = new Set<Backend>([
    ...(Object.keys(stored?.byBackend ?? {}) as Backend[]),
    ...(Object.keys(scanned?.byBackend ?? {}) as Backend[]),
  ]);

  // A row with no per-backend breakdown can only be an older or hand-edited
  // file. Fall back to a flat per-field max so its totals still survive.
  if (backends.size === 0) {
    return {
      day,
      turns: Math.max(stored?.turns ?? 0, scanned?.turns ?? 0),
      inputTokens: Math.max(stored?.inputTokens ?? 0, scanned?.inputTokens ?? 0),
      outputTokens: Math.max(stored?.outputTokens ?? 0, scanned?.outputTokens ?? 0),
      linesAdded: Math.max(stored?.linesAdded ?? 0, scanned?.linesAdded ?? 0),
      linesDeleted: Math.max(stored?.linesDeleted ?? 0, scanned?.linesDeleted ?? 0),
      byBackend: {},
    };
  }

  const byBackend: Partial<Record<Backend, DailyBackendBucket>> = {};
  const total = emptyBackendBucket();
  for (const b of backends) {
    const merged = maxBackendBucket(stored?.byBackend?.[b], scanned?.byBackend?.[b]);
    byBackend[b] = merged;
    total.turns += merged.turns;
    total.inputTokens += merged.inputTokens;
    total.outputTokens += merged.outputTokens;
    total.linesAdded += merged.linesAdded;
    total.linesDeleted += merged.linesDeleted;
  }
  return { day, ...total, byBackend };
}

export function mergeDailyHistory(stored: DailyHistory, scanned: Iterable<DailyBucket>): DailyHistory {
  const out: DailyHistory = { ...stored };
  for (const d of scanned) {
    if (!d.day) continue;
    out[d.day] = mergeDay(stored[d.day], d);
  }
  return out;
}

/// Keep the newest `maxDays` rows. Day keys are zero-padded, so a lexical
/// sort is chronological.
export function trimHistory(history: DailyHistory, maxDays = MAX_DAYS): DailyHistory {
  const days = Object.keys(history).sort();
  if (days.length <= maxDays) return history;
  const out: DailyHistory = {};
  for (const d of days.slice(days.length - maxDays)) out[d] = history[d];
  return out;
}

function historyPath(): string | null {
  try {
    return path.join(host().dataDir(), 'stats-daily.json');
  } catch {
    // No Electron app around — a test or the stats CLI harness. Read-only.
    return null;
  }
}

export function loadDailyHistory(): DailyHistory {
  const target = historyPath();
  if (!target) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DailyHistory = {};
    for (const [day, row] of Object.entries(parsed as Record<string, unknown>)) {
      if (row && typeof row === 'object') out[day] = { ...(row as DailyBucket), day };
    }
    return out;
  } catch {
    // Missing or unreadable — start empty rather than lose this scan.
    return {};
  }
}

function saveDailyHistory(next: DailyHistory, prev: DailyHistory): void {
  const target = historyPath();
  if (!target) return;
  const json = JSON.stringify(next);
  if (json === JSON.stringify(prev)) return; // this scan added nothing
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    logSilent('stats.saveDailyHistory', e);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/// Fold this scan into the stored history and hand back the merged day map for
/// the report. When history can't be persisted this is just the scan, remapped
/// through the same merge so the numbers are identical either way.
export function recordDailyHistory(scanned: Map<string, DailyBucket>): Map<string, DailyBucket> {
  const stored = loadDailyHistory();
  const merged = trimHistory(mergeDailyHistory(stored, scanned.values()));
  saveDailyHistory(merged, stored);
  return new Map(Object.entries(merged));
}
