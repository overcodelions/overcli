// Phase 1: not yet wired — see workerEngine (next phase).

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';

import type { Worker } from '../../shared/flows/worker';

function dir(): string {
  return path.join(app.getPath('userData'), 'workers');
}

function pathFor(id: string): string {
  return path.join(dir(), `${id}.json`);
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
  ensureDir();
  const target = pathFor(w.id);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(w), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'workers', `Failed to persist ${w.id}: ${String(err)}`);
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
    names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Worker[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir(), name), 'utf8');
      const w = JSON.parse(raw) as Worker;
      if (!w || typeof w.id !== 'string' || !w.cadence || !w.caps) continue;
      out.push({ ...w, flowIds: Array.isArray(w.flowIds) ? w.flowIds : [] });
    } catch (err) {
      log('warn', 'workers', `Skipping unreadable ${name}: ${String(err)}`);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteWorker(id: string): void {
  try {
    fs.rmSync(pathFor(id), { force: true });
  } catch {
    // best-effort
  }
}
