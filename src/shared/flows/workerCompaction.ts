// Weekly compaction of a worker's filing cabinet — schedule arithmetic and
// the retention window, nothing else. Compaction is mechanical, not
// model-driven: moving stale filed work into `archive/` is plain code, on
// purpose, so the pass that exists to make shifts cheaper does not itself
// spend a model turn.
//
// Only FILES are compacted. The journal is deliberately left alone: its
// prompt digest is already capped at WORKER_JOURNAL_DIGEST_LIMIT entries, so
// folding it would not shrink a single shift prompt, and the orchestration
// projection reads meaning into an entry's absence.

export const WORKER_COMPACTION_KEEP_DAYS = 14;
export const WORKER_COMPACTION_DAY = 0; // Sunday
export const WORKER_COMPACTION_HOUR = 3; // 03:00 local
export const WORKER_ARCHIVE_DIR = 'archive';

export function compactionCutoff(now: number): number {
  return now - WORKER_COMPACTION_KEEP_DAYS * 24 * 60 * 60 * 1000;
}

/// The most recent Sunday 03:00 local at or before `now`.
export function lastCompactionSlot(now: number): number {
  const d = new Date(now);
  d.setHours(WORKER_COMPACTION_HOUR, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - WORKER_COMPACTION_DAY + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/// A worker that has never compacted is due: it is the one with the backlog.
export function isCompactionDue(lastCompactedAt: number | undefined, now: number): boolean {
  if (lastCompactedAt === undefined) return true;
  return lastCompactedAt < lastCompactionSlot(now);
}
