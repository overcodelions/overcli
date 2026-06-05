// All-time lightweight summary of every flow run that has ever reached a
// terminal state. The full `flow-runs/<id>.json` files are LRU-evicted by
// the runtime (artifacts, transcripts — the heavy stuff), but the Usage
// page wants accurate all-time totals. This append-only JSONL keeps one
// ~200-byte record per run forever so the totals never regress when an
// old run gets evicted.
//
// Bloat guards:
//   - one line per run id; we guard append on a Set built at first read
//   - read-time dedup by id (last write wins), so a duplicate line from a
//     crashed write doesn't double-count
//   - lazy compaction on first read: if the file is > 1 MB or carries
//     more lines than unique ids × 2, rewrite it deduped

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from '../diagnostics';
import type { FlowRun } from '../../shared/flows/schema';

export interface RunSummary {
  id: string;
  flowId: string;
  flowName: string;
  completed: boolean;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  wallClockMs: number;
  /// ms epoch when the run first reached `done`/`archived`.
  terminalAt: number;
}

const COMPACT_BYTES = 1024 * 1024;
const COMPACT_RATIO = 2;

function filePath(): string {
  try {
    return path.join(app.getPath('userData'), 'flow-run-summaries.jsonl');
  } catch {
    // Tests / CLI runs without Electron's `app`. Returning a path the
    // process can't write to is fine — the append wraps in try/catch.
    return path.join(process.cwd(), '.overcli-test-summaries.jsonl');
  }
}

let summarizedIds: Set<string> | null = null;

function ensureIndex(): Set<string> {
  if (summarizedIds) return summarizedIds;
  const loaded = loadRunSummariesRaw();
  maybeCompact(loaded);
  summarizedIds = new Set(loaded.map((s) => s.id));
  return summarizedIds;
}

export function summarizeRun(run: FlowRun): RunSummary | null {
  const isDone = run.state.kind === 'done' || run.state.kind === 'archived';
  if (!isDone) return null;
  const flowId = run.flowId || 'unknown';
  const flowName = run.flowSnapshot?.name || flowId;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUSD = 0;
  let wallClockMs = 0;
  let terminalAt = run.createdAt ?? 0;
  for (const a of run.attempts ?? []) {
    turns += 1;
    if (a.usage) {
      inputTokens += a.usage.inputTokens;
      outputTokens += a.usage.outputTokens;
    }
    // costUSD on an attempt is the CLI's cumulative-per-conversation
    // snapshot, so the run's true cost is the MAX across attempts, not
    // the sum. Same rule the FlowImpact aggregator uses.
    if (typeof a.costUSD === 'number' && a.costUSD > costUSD) costUSD = a.costUSD;
    if (a.endedAt && a.startedAt && a.endedAt > a.startedAt) {
      wallClockMs += a.endedAt - a.startedAt;
      if (a.endedAt > terminalAt) terminalAt = a.endedAt;
    }
  }
  return {
    id: run.id,
    flowId,
    flowName,
    completed: true,
    turns,
    inputTokens,
    outputTokens,
    costUSD,
    wallClockMs,
    terminalAt,
  };
}

/// Idempotent. Appends a summary line for `run` if it isn't already in
/// the log. Callers wire this into the runs-store save path so terminal
/// runs are captured exactly once per id, even across restarts.
export function appendRunSummary(run: FlowRun): void {
  const ids = ensureIndex();
  if (ids.has(run.id)) return;
  const summary = summarizeRun(run);
  if (!summary) return;
  try {
    fs.appendFileSync(filePath(), JSON.stringify(summary) + '\n', 'utf-8');
    ids.add(run.id);
  } catch (err) {
    log('error', 'flows.appendRunSummary', `failed to append summary for ${run.id}`, err);
  }
}

/// Deduped, authoritative all-time list. Last write wins per id, so a
/// run that gets resaved (rare — only via a manual surgery) reflects the
/// latest snapshot rather than the first.
export function loadRunSummaries(): RunSummary[] {
  ensureIndex();
  const all = loadRunSummariesRaw();
  const byId = new Map<string, RunSummary>();
  for (const s of all) byId.set(s.id, s);
  return Array.from(byId.values());
}

function loadRunSummariesRaw(): RunSummary[] {
  const p = filePath();
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch (err) {
    log('warn', 'flows.loadRunSummaries', 'failed to read summaries', err);
    return [];
  }
  const out: RunSummary[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as RunSummary;
      if (parsed && typeof parsed.id === 'string') out.push(parsed);
    } catch {
      // skip a corrupt line — the next compaction drops it
    }
  }
  return out;
}

function maybeCompact(loaded: RunSummary[]): void {
  const p = filePath();
  let size = 0;
  try {
    size = fs.statSync(p).size;
  } catch {
    return;
  }
  const uniqueIds = new Set(loaded.map((s) => s.id));
  const overSize = size > COMPACT_BYTES;
  const overRatio = loaded.length > uniqueIds.size * COMPACT_RATIO;
  if (!overSize && !overRatio) return;
  const byId = new Map<string, RunSummary>();
  for (const s of loaded) byId.set(s.id, s);
  const compacted = Array.from(byId.values());
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, compacted.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  } catch (err) {
    log('warn', 'flows.compactRunSummaries', 'failed to compact', err);
  }
}
