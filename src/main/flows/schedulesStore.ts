// On-disk store for Schedule records. One file per schedule at
// <userData>/schedules/<id>.json, so a schedule the user armed months ago
// survives every restart — which is the entire point of a schedule.
//
// Mirrors orchestrationsStore's atomic-write + load-all shape. Unlike an
// orchestration, a schedule is NOT settled on load: a batch that was mid-
// flight when the app died has nothing left to do, but a schedule that was
// enabled when the app died is still enabled now. Reconciling the occurrences
// that passed in between is the scheduler's job (catch-up policy), not the
// loader's.

import fs from 'node:fs';
import path from 'node:path';
import { host } from '../host';
import { log } from '../diagnostics';
import { isSafeIdSegment } from '../../shared/flows/safeId';

import { SCHEDULE_HISTORY_LIMIT, type Schedule } from '../../shared/flows/schedule';

function dir(): string {
  return path.join(host().dataDir(), 'schedules');
}

function pathFor(id: string): string {
  if (!isSafeIdSegment(id)) throw new Error(`Unsafe schedule id: ${id}`);
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
export function saveSchedule(s: Schedule): void {
  ensureDir();
  const target = pathFor(s.id);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(trimHistory(s)), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'schedules', `Failed to persist ${s.id}: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
}

/// Keep history bounded. A schedule that fires every 15 minutes would
/// otherwise grow its record without limit for as long as it stays armed.
function trimHistory(s: Schedule): Schedule {
  if (s.history.length <= SCHEDULE_HISTORY_LIMIT) return s;
  return { ...s, history: s.history.slice(0, SCHEDULE_HISTORY_LIMIT) };
}

/// Load every persisted schedule, newest first.
///
/// `activeRunId` is cleared on the way in: it pointed at a subprocess that
/// died with the app, so leaving it set would make the overlap check believe
/// a run is still going and skip every firing forever.
export function loadAllSchedules(): Schedule[] {
  ensureDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Schedule[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir(), name), 'utf8');
      const s = JSON.parse(raw) as Schedule;
      if (!s || typeof s.id !== 'string' || !s.target || !s.trigger) continue;
      out.push({
        ...s,
        activeRunId: undefined,
        history: Array.isArray(s.history) ? s.history : [],
      });
    } catch (err) {
      log('warn', 'schedules', `Skipping unreadable ${name}: ${String(err)}`);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteSchedule(id: string): void {
  try {
    fs.rmSync(pathFor(id), { force: true });
  } catch {
    // best-effort
  }
}
