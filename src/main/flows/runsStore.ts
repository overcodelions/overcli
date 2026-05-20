// On-disk store for FlowRun history. Every state transition writes the
// run JSON atomically to <userData>/flow-runs/<runId>.json so completed
// runs survive an app restart and the user can review their plan/diff/
// review artifacts later. In-flight runs (running, paused) are persisted
// too, but on startup the runtime down-converts them to `aborted` —
// their underlying step subprocesses are dead by then and there's no
// safe resume path.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

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

/// Atomic write. Writes to .tmp then renames so a crash mid-write can't
/// leave a half-baked JSON file that fails to parse on next load.
export function saveRun(run: FlowRun): void {
  ensureDir();
  const file = pathFor(run.id);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(compact(run)), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[flows] failed to persist run', run.id, err);
  }
}

/// Delete a run's JSON file. Called when the runtime evicts a run from
/// its in-memory map (the 20-run LRU cap) — we don't want the on-disk
/// store to grow unbounded either.
export function deleteRun(runId: string): void {
  const file = pathFor(runId);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('[flows] failed to delete run', runId, err);
  }
}

/// Load every persisted run from disk. Called once at startup. Runs
/// whose state is `running` or `paused` are NOT restored as-is — their
/// underlying step subprocesses are gone, so we mark them `aborted` and
/// persist the corrected state so a second restart doesn't keep
/// re-aborting them.
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
      if (parsed.state.kind === 'running' || parsed.state.kind === 'paused') {
        parsed.state = { kind: 'aborted' };
        saveRun(parsed); // write the corrected state back so this is idempotent
      }
      out.push(parsed);
    } catch (err) {
      console.warn('[flows] failed to parse persisted run', name, err);
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
