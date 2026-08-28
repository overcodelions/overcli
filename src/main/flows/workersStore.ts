// Phase 1: not yet wired — see workerEngine (next phase).

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import { isSafeIdSegment } from '../../shared/flows/safeId';

import type { Worker } from '../../shared/flows/worker';
import type { Treasury } from '../../shared/flows/treasury';

function dir(): string {
  return path.join(host().dataDir(), 'workers');
}

function pathFor(id: string): string {
  if (!isSafeIdSegment(id)) throw new Error(`Unsafe worker id: ${id}`);
  return path.join(dir(), `${id}.json`);
}

/// The treasury sits beside the roster it funds rather than in the app store:
/// it is worthless without these files, and a backup that took one without
/// the other would restore a pool that funds nobody.
function treasuryPath(): string {
  return path.join(dir(), 'treasury.json');
}

function ensureDir(): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
  } catch {
    // best-effort — the write below surfaces the real error
  }
}

/// Persist atomically (temp file + rename) so a crash mid-write can't leave a
/// half-written JSON that kills the next boot's load.
export function saveWorker(w: Worker): void {
  writeAtomic(pathFor(w.id), JSON.stringify(w), w.id);
}

function writeAtomic(target: string, body: string, label: string): void {
  ensureDir();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'workers', `Failed to persist ${label}: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/// Load every persisted worker, newest first.
export function loadAllWorkers(): Worker[] {
  ensureDir();
  let names: string[] = [];
  try {
    // treasury.json shares the directory but is not a worker — excluded by
    // name rather than left to the shape guard below, so a malformed pool
    // file can never be mistaken for a corrupt worker.
    names = fs
      .readdirSync(dir())
      .filter((n) => n.endsWith('.json') && n !== 'treasury.json');
  } catch {
    return [];
  }
  const out: Worker[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir(), name), 'utf8');
      const w = JSON.parse(raw) as Worker;
      // `cadence: null` is a real, readable worker — one that works on
      // demand. Only an ABSENT cadence is a malformed record.
      if (!w || typeof w.id !== 'string' || w.cadence === undefined || !w.caps) continue;
      out.push({ ...w, flowIds: Array.isArray(w.flowIds) ? w.flowIds : [] });
    } catch (err) {
      log('warn', 'workers', `Skipping unreadable ${name}: ${String(err)}`);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/// The pool, or null on an install that has never had one — the engine seeds
/// it from the existing per-worker caps in that case, so an upgrade changes
/// nothing until the user says otherwise.
export function loadTreasury(): Treasury | null {
  try {
    const raw = fs.readFileSync(treasuryPath(), 'utf8');
    const parsed = JSON.parse(raw) as Treasury;
    if (!parsed || !Number.isFinite(parsed.monthlyUSD) || parsed.monthlyUSD <= 0) return null;
    return { monthlyUSD: parsed.monthlyUSD };
  } catch {
    return null;
  }
}

export function saveTreasury(t: Treasury): void {
  writeAtomic(treasuryPath(), JSON.stringify(t), 'treasury');
}

export function deleteWorker(id: string): void {
  try {
    fs.rmSync(pathFor(id), { force: true });
  } catch {
    // best-effort
  }
}
