// On-disk store for FlowRun history. Every state transition writes the
// run JSON atomically to <userData>/flow-runs/<runId>.json so completed
// runs survive an app restart and the user can review their plan/diff/
// review artifacts later. In-flight runs (running, paused) are persisted
// too. On startup a `running` run can't keep going — its step subprocess
// is dead — so we down-convert it to `paused` with `reason: 'interrupted'`
// pointing at the step it died on, which Continue re-runs from scratch.
// (It used to become `aborted`, which stranded the work; the artifacts of
// earlier steps are intact, so re-running the interrupted step forward is
// safe and far more useful than abandoning the run.)

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';
import { appendRunSummary } from './runSummaryLog';

import type { FlowRun } from '../../shared/flows/schema';

/// Hard cap on artifact body size we persist. Memory is bounded by the
/// runtime's MAX_RETAINED_RUNS, but a single huge `diff` artifact (a 50
/// MB git diff, say) would blow up the per-run JSON. We truncate
/// persistently in those cases — the renderer surfaces the truncation
/// note alongside the artifact.
const MAX_ARTIFACT_BYTES = 256 * 1024;

function dir(): string {
  return path.join(app.getPath('userData'), 'flow-runs');
}

function pathFor(runId: string): string {
  return path.join(dir(), `${runId}.json`);
}

function ensureDir(): void {
  try {
    fs.mkdirSync(dir(), { recursive: true });
  } catch {
    // best-effort — write below will surface the real error
  }
}

/// Compress a run for on-disk storage. Truncates oversized artifacts so
/// a single huge output can't poison the directory listing or balloon
/// JSON parse times on startup.
function compact(run: FlowRun): FlowRun {
  const artifacts: typeof run.artifacts = {};
  for (const [name, art] of Object.entries(run.artifacts)) {
    if (art.body.length <= MAX_ARTIFACT_BYTES) {
      artifacts[name] = art;
    } else {
      const dropped = art.body.length - MAX_ARTIFACT_BYTES;
      artifacts[name] = {
        ...art,
        body:
          art.body.slice(0, MAX_ARTIFACT_BYTES) +
          `\n\n[…truncated ${dropped.toLocaleString()} characters when persisted…]`,
      };
    }
  }
  return { ...run, artifacts };
}

// Per-run async write chain. Checkpoints fire on every state transition —
// including every watch tick — and a synchronous fs.writeFileSync of a large
// run JSON blocks the main process event loop (and thus the renderer's IPC),
// which surfaced as a macOS beachball on watched flows. We move the write off
// the synchronous path and serialize per run id so two checkpoints can't race
// on the shared .tmp file. Writes coalesce: only the latest run state queued
// for a given id is actually written, so a burst of checkpoints collapses to
// one disk write of the newest state.
const writeChains = new Map<string, Promise<void>>();
const latestPending = new Map<string, FlowRun>();

/// Atomic write. Writes to .tmp then renames so a crash mid-write can't
/// leave a half-baked JSON file that fails to parse on next load.
async function writeRunFile(run: FlowRun): Promise<void> {
  ensureDir();
  const file = pathFor(run.id);
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(compact(run)), 'utf-8');
  await fs.promises.rename(tmp, file);
}

/// Schedule an atomic, coalesced async write of `run`. Returns immediately;
/// the write happens on a microtask so it never blocks the caller.
export function saveRun(run: FlowRun): void {
  // Remember the newest state for this id; the queued write picks it up.
  latestPending.set(run.id, run);
  const prev = writeChains.get(run.id) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      const pending = latestPending.get(run.id);
      if (!pending) return; // an earlier link in the chain already wrote it
      latestPending.delete(run.id);
      await writeRunFile(pending);
    })
    .catch((err) => {
      log('error', 'flows.persistRun', `failed to persist run ${run.id}`, err);
    })
    .finally(() => {
      // Drop the chain once it has drained so the map can't grow unbounded.
      if (writeChains.get(run.id) === next) writeChains.delete(run.id);
    });
  writeChains.set(run.id, next);
  // Mirror terminal runs into the all-time summary log so their totals
  // outlive the LRU eviction of <userData>/flow-runs/<id>.json. The
  // append is idempotent — same id never lands twice.
  if (run.state.kind === 'done' || run.state.kind === 'archived') {
    appendRunSummary(run);
  }
}

/// Await all in-flight run writes. Call before app quit so the latest
/// checkpoints are durably on disk despite the async write path.
export async function flushRuns(): Promise<void> {
  await Promise.allSettled([...writeChains.values()]);
}

/// Delete a run's JSON file. Called when the runtime evicts a run from
/// its in-memory map (the MAX_RETAINED_RUNS LRU cap) — we don't want the on-disk
/// store to grow unbounded either.
export function deleteRun(runId: string): void {
  const file = pathFor(runId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    log('error', 'flows.deleteRun', `failed to delete run ${runId}`, err);
  }
}

/// Load every persisted run from disk. Called once at startup. A
/// `running` run is NOT restored as-is — it died mid-step, its subprocess
/// and in-flight tool calls are gone. Rather than abandon it as `aborted`,
/// we demote it to `paused` with `reason: 'interrupted'` and `nextStepId`
/// set to the step it died on: earlier steps' artifacts are intact, so
/// `resumeRun` can re-run the interrupted step from scratch and roll
/// forward. The corrected state is persisted so a second restart is a
/// no-op. A run already `paused` is left untouched — it sits BETWEEN steps
/// with no live subprocess to lose, exactly like a restored `watching` run
/// resumes its watcher.
export function loadAllRuns(): FlowRun[] {
  const d = dir();
  if (!fs.existsSync(d)) return [];
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return [];
  }
  const out: FlowRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(d, name);
    try {
      const body = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(body) as FlowRun;
      if (!parsed?.id || !parsed?.flowSnapshot) continue; // skip corrupt entries
      if (parsed.state.kind === 'running') {
        const interruptedStepId = parsed.state.currentStepId;
        // Close out the dangling attempt for the step that was in flight —
        // its subprocess is gone, so it neither succeeded nor will it ever.
        // Marking it `aborted` keeps the attempts timeline honest (the UI
        // shows the interrupted step as failed, then a fresh attempt on
        // resume) instead of leaving an open-ended "still running" entry.
        const open = parsed.attempts.find(
          (a) => a.stepId === interruptedStepId && !a.endedAt,
        );
        if (open) {
          open.endedAt = Date.now();
          open.outcome = 'aborted';
        }
        parsed.state = {
          kind: 'paused',
          nextStepId: interruptedStepId,
          reason: 'interrupted',
        };
        saveRun(parsed); // write the corrected state back so this is idempotent
      }
      out.push(parsed);
    } catch (err) {
      log('warn', 'flows.parseRun', `failed to parse persisted run ${name}`, err);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
