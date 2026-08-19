// Append-only episodic memory for Workers — one JSONL line per event
// (shift worked, candidate proposed, verdict, outcome). The workerEngine
// writes it and feeds a digest of it into every shift-planning turn.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';

import type { WorkerJournalEntry } from '../../shared/flows/worker';

// The entry types live in shared (the renderer renders the journal); re-export
// so main-side callers and tests keep importing them from here.
export type { WorkerJournalEntry, WorkerJournalKind } from '../../shared/flows/worker';

export const WORKER_JOURNAL_MAX_ENTRIES = 2000;
export const WORKER_JOURNAL_DIGEST_LIMIT = 40;

const COMPACT_BYTES = 1024 * 1024;

function filePath(): string {
  try {
    return path.join(app.getPath('userData'), 'worker-journal.jsonl');
  } catch {
    return path.join(process.cwd(), '.overcli-test-worker-journal.jsonl');
  }
}

let journalIds: Set<string> | null = null;
let appendsSinceCompaction = 0;

function ensureIndex(): Set<string> {
  if (journalIds) return journalIds;
  const loaded = loadWorkerJournalRaw();
  maybeCompact(loaded);
  journalIds = new Set(loaded.map((entry) => entry.id));
  return journalIds;
}

/// Idempotent. Appends an entry if it isn't already in the journal. Returns
/// whether this call actually wrote — the engine keys exactly-once side
/// effects (a demotion, a notification) off a first-time append.
export function appendWorkerJournalEntry(entry: WorkerJournalEntry): boolean {
  const ids = ensureIndex();
  if (ids.has(entry.id)) return false;
  try {
    fs.appendFileSync(filePath(), JSON.stringify(entry) + '\n', 'utf-8');
    ids.add(entry.id);
    if (++appendsSinceCompaction >= 200) {
      appendsSinceCompaction = 0;
      journalIds = null;
      ensureIndex();
    }
    return true;
  } catch (err) {
    log('error', 'flows.appendWorkerJournalEntry', `failed to append journal entry for ${entry.id}`, err);
    return false;
  }
}

/// This reads and parses the whole journal per call; acceptable because the
/// file is re-compacted every 200 appends, not only at launch.
export function loadWorkerJournal(workerId: string): WorkerJournalEntry[] {
  ensureIndex();
  const byId = new Map<string, WorkerJournalEntry>();
  for (const entry of loadWorkerJournalRaw()) byId.set(entry.id, entry);
  return Array.from(byId.values())
    .filter((entry) => entry.workerId === workerId)
    .sort((a, b) => b.at - a.at);
}

/// This is what stops a worker re-proposing what was already turned down.
export function workerRejectedTitles(workerId: string): string[] {
  const titles = loadWorkerJournal(workerId)
    .filter((entry) => entry.kind === 'rejected')
    .map((entry) => entry.title.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(titles));
}

export function digestWorkerJournal(workerId: string): string {
  const entries = loadWorkerJournal(workerId).slice(0, WORKER_JOURNAL_DIGEST_LIMIT);
  if (entries.length === 0) return '';
  return entries
    .map((entry) => `${new Date(entry.at).toISOString().slice(0, 10)} ${entry.kind}: ${entry.title || entry.note || ''}`)
    .join('\n');
}

function loadWorkerJournalRaw(): WorkerJournalEntry[] {
  const p = filePath();
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log('warn', 'flows.loadWorkerJournal', 'failed to read journal', err);
    return [];
  }
  const out: WorkerJournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as WorkerJournalEntry;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      // skip a corrupt line — the next compaction drops it
    }
  }
  return out;
}

/// Forget everything this worker has done. The journal is one shared file, so
/// this is a filtered rewrite: every OTHER worker's entries survive verbatim.
/// Returns how many entries were dropped, and THROWS if the rewrite could not
/// land: a caller that resets shift numbering on the strength of a clear that
/// silently failed would leave the worker's next shift #1 colliding with the
/// old one's journal id, and idempotent append would drop it on the floor.
///
/// This is the whole of a worker's episodic memory, so it is also what bans
/// re-proposing a rejected title (`workerRejectedTitles`) and what feeds the
/// demotion streak. A reset therefore un-bans old rejections by design — the
/// caller is asking the worker to start fresh, not to keep its grudges. Trust
/// level lives on the worker record and is deliberately left alone: it was the
/// user's explicit act, not a memory.
export function clearWorkerJournal(workerId: string): number {
  const loaded = loadWorkerJournalRaw();
  const kept = loaded.filter((entry) => entry.workerId !== workerId);
  const dropped = loaded.length - kept.length;
  if (dropped === 0) return 0;
  if (!rewrite(kept)) throw new Error('Could not rewrite the worker journal.');
  // The append-dedupe index is keyed by entry id with no worker dimension, so
  // it cannot be filtered in place — drop it and let the next append reload.
  journalIds = null;
  return dropped;
}

/// Atomic whole-file replacement, shared by the entry-cap compaction and
/// reset. Returns
/// whether the swap landed — a failed rewrite must leave the index alone.
function rewrite(entries: WorkerJournalEntry[]): boolean {
  const p = filePath();
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (err) {
    log('warn', 'flows.rewriteWorkerJournal', 'failed to rewrite journal', err);
    return false;
  }
}

function maybeCompact(loaded: WorkerJournalEntry[]): void {
  const p = filePath();
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return;
  }
  if (size <= COMPACT_BYTES && loaded.length <= WORKER_JOURNAL_MAX_ENTRIES) return;
  // Journal ids are unique by construction, so dedupe alone can never shrink
  // the file — the entry cap is what bounds it, matching SCHEDULE_HISTORY_LIMIT
  // (src/shared/flows/schedule.ts:177).
  const byId = new Map<string, WorkerJournalEntry>();
  for (const entry of loaded) byId.set(entry.id, entry);
  const compacted = Array.from(byId.values())
    .sort((a, b) => a.at - b.at)
    .slice(-WORKER_JOURNAL_MAX_ENTRIES);
  rewrite(compacted);
}
