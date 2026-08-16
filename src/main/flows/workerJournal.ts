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
    return true;
  } catch (err) {
    log('error', 'flows.appendWorkerJournalEntry', `failed to append journal entry for ${entry.id}`, err);
    return false;
  }
}

/// This reads and parses the whole journal per call; acceptable because
/// WORKER_JOURNAL_MAX_ENTRIES bounds the file.
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
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, compacted.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    log('warn', 'flows.compactWorkerJournal', 'failed to compact', err);
  }
}
