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

import { runExists } from './runsStore';

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

/// What a restart does to one item that never reached a terminal state.
///
/// Pure and separately exported because these three rules are the whole
/// difference between a batch that reads as history and one that lies about
/// itself on every launch — and because `loadAllOrchestrations` around them
/// is all electron paths and fs, which is why they went untested for as long
/// as they did. `exists` answers whether a child run's file is still there.
/// `settledAt` stands in for a finish time the item never recorded. It is the
/// batch's own `createdAt`, NOT the clock: stamping boot time onto a week-old
/// item files it as having finished the moment you launched the app, which
/// puts last Tuesday's abandoned work at the top of today's list and counts
/// it in "finished today". The item's own `startedAt` is better still when it
/// has one — that is at least the right era, and usually the right hour.
export function settleItemOnLoad(
  item: Orchestration['items'][number],
  exists: (runId: string) => boolean,
  settledAt: number = Date.now(),
): boolean {
  const ended = () => item.finishedAt ?? item.startedAt ?? settledAt;
  if (item.status === 'running') {
    // Its subprocess died with the app, mirroring how runsStore demotes
    // in-flight runs.
    item.status = 'failed';
    item.note = item.note ?? 'Interrupted by app restart.';
    item.finishedAt = ended();
    return true;
  }
  if (item.status === 'paused' && item.runId && !exists(item.runId)) {
    // A parked item whose child run has been deleted (evicted by the
    // retention cap, cleaned up with its worktree, removed by hand).
    // `paused` promises the user can continue it, and there is nothing left
    // to continue — so it sat in the Workers work queue asking for a decision
    // that could never be taken, for as long as the batch survived.
    //
    // `failed`, deliberately, and NOT `cancelled`: a cancelled item is
    // journaled as a REJECTION and counts toward the worker's demotion streak
    // (see workerEngine's reconcile). Losing a run file is the app's doing,
    // not a verdict on the worker's judgement.
    item.status = 'failed';
    item.note = item.note ?? 'Run no longer exists.';
    item.finishedAt = ended();
    return true;
  }
  if (item.status === 'queued') {
    // Orchestrations do NOT auto-resume on restart: relaunching a child flow
    // run forks a worktree and spawns an AI subprocess (burning tokens) with
    // no user present to approve it. Settle anything that never launched so
    // the batch becomes a read-only ledger instead of re-pumping on boot.
    item.status = 'cancelled';
    item.note = item.note ?? 'Not resumed after app restart.';
    item.finishedAt = ended();
    // Not a verdict on the work: the app closed, that is all. Without this
    // the worker journal reads the cancellation as a rejection and counts it
    // toward a demotion.
    item.settledByRestart = true;
    return true;
  }
  return false;
}

/// Load every persisted batch, settling anything a restart has invalidated
/// (see `settleItemOnLoad` for the three rules and why each one is what it
/// is).
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
        if (settleItemOnLoad(item, runExists, o.createdAt)) mutated = true;
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
