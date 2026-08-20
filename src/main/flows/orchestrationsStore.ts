// On-disk store for Orchestration (batch) records. Each batch is written to
// <userData>/orchestrations/<id>.json so a batch the user kicked off survives
// an app restart and its ledger ("what did this ProductBoard pull produce")
// stays around. Mirrors runsStore's atomic-write + load-all shape, but a
// batch record is tiny (a handful of items, each a pointer to a child run),
// so there's no artifact-size compaction to do.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';
import { isSafeIdSegment } from '../../shared/flows/safeId';

import type { Orchestration } from '../../shared/flows/orchestration';

/// Worker batches are exempt from the residue sweep by design, so nothing
/// else bounds this directory. Completed batches past this count are dropped
/// at hydrate time — the worker journal keeps the durable history.
const MAX_RETAINED_ORCHESTRATIONS = 600;

/// Throttle for the write-time prune below — a burst of saves (a shift
/// dispatching several items in a row) should not re-scan and re-evict the
/// whole directory on every single one of them.
let lastPruneAt = 0;

function dir(): string {
  return path.join(app.getPath('userData'), 'orchestrations');
}

function pathFor(id: string): string {
  if (!isSafeIdSegment(id)) throw new Error(`Unsafe orchestration id: ${id}`);
  return path.join(dir(), `${id}.json`);
}

function ensureDir(): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
  } catch {
    // best-effort — write below surfaces the real error
  }
}

/// Persist a batch atomically (temp file + rename) so a crash mid-write
/// can't leave a half-written JSON the next startup chokes on.
export function saveOrchestration(o: Orchestration): void {
  ensureDir();
  const target = pathFor(o.id);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(o), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    log('warn', 'orchestrations', `Failed to persist ${o.id}: ${String(err)}`);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
  }
  // Evicted at boot already, but a long-running session that never restarts
  // would otherwise grow this directory without bound. At most once a minute.
  const now = Date.now();
  if (now - lastPruneAt > 60_000) {
    lastPruneAt = now;
    pruneOrchestrations(loadAllOrchestrations());
  }
}

/// Load every persisted batch. Down-converts any item still marked
/// `running` to `failed` — its child run's subprocess is dead after a
/// restart, mirroring how runsStore demotes in-flight runs to `aborted`.
///
/// `proposed` items pass through untouched. A schedule can park a batch at
/// 8am and the user might not open the app until the afternoon; settling the
/// proposal on boot would throw away the entire point of scheduling it.
export function loadAllOrchestrations(): Orchestration[] {
  ensureDir();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Orchestration[] = [];
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir(), name), 'utf8');
      const o = JSON.parse(raw) as Orchestration;
      if (!o || typeof o.id !== 'string' || !Array.isArray(o.items)) continue;
      let mutated = false;
      for (const item of o.items) {
        if (item.status === 'running') {
          item.status = 'failed';
          item.note = item.note ?? 'Interrupted by app restart.';
          item.finishedAt = item.finishedAt ?? Date.now();
          mutated = true;
        } else if (item.status === 'queued') {
          // Orchestrations do NOT auto-resume on restart: relaunching a child
          // flow run forks a worktree and spawns an AI subprocess (burning
          // tokens) with no user present to approve it. Settle anything that
          // never launched so the batch becomes a read-only ledger instead of
          // re-pumping on every boot.
          item.status = 'cancelled';
          item.note = item.note ?? 'Not resumed after app restart.';
          item.finishedAt = item.finishedAt ?? Date.now();
          mutated = true;
        }
      }
      if (
        mutated &&
        o.items.every(
          (i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled',
        )
      ) {
        o.completedAt = o.completedAt ?? Date.now();
      }
      out.push(o);
    } catch (err) {
      log('warn', 'orchestrations', `Skipping unreadable ${name}: ${String(err)}`);
    }
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return pruneOrchestrations(out);
}

/// Evict completed batches past `MAX_RETAINED_ORCHESTRATIONS`, oldest first.
/// Never evicts a batch still holding proposals or live items. Shared by the
/// loader (every boot) and `saveOrchestration` (every write, throttled), so a
/// session that never restarts still gets bounded.
export function pruneOrchestrations(all: Orchestration[]): Orchestration[] {
  if (all.length <= MAX_RETAINED_ORCHESTRATIONS) return all;
  const kept: Orchestration[] = [];
  all.forEach((o, index) => {
    if (index < MAX_RETAINED_ORCHESTRATIONS || !o.completedAt) {
      kept.push(o);
      return;
    }
    deleteOrchestration(o.id);
  });
  log('info', 'orchestrations', `Pruned ${all.length - kept.length} completed batches`);
  return kept;
}

export function deleteOrchestration(id: string): void {
  try {
    fs.rmSync(pathFor(id), { force: true });
  } catch {
    // best-effort
  }
}
