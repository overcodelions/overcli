// The stats scan, in its own process.
//
// `computeStats()` is synchronous from end to end — it walks
// `~/.claude/projects`, `~/.codex/sessions` and `~/.gemini`, reads every
// transcript with `readFileSync` and `JSON.parse`s it line by line. On a
// machine with a couple of gigabytes of history that is tens of seconds of
// straight-line CPU, and running it on the main process meant the whole app
// stopped answering window events for the duration: opening the stats page
// beachballed (issue: "pinwheel when loading usage stats").
//
// So it runs here instead, under `utilityProcess.fork` from statsService.ts.
// Nothing about the scan changed — this file is a message loop around it.
//
// Two things matter about the seam:
//   - No electron import. The `ParentPort` type is `import type` only, so it
//     is erased at compile time; this file is plain Node at runtime, which is
//     also what lets a test require it without booting Electron.
//   - The host is installed from the parent's data directory (`hostNode`
//     rather than `hostElectron`, since `app.getPath()` doesn't exist here).
//     `computeStats()` reaches for it through `loadAllRuns()`, `Store.load()`
//     and `recordDailyHistory()`, and the last of those WRITES the daily
//     snapshot, so pointing it anywhere but the app's real userData would
//     quietly fork the history file.
//
// The worker is long-lived: stats.ts keeps an mtime-keyed parse cache at
// module level, and staying alive between requests is what makes the second
// visit to the stats page fast. statsService.ts decides when to let it go.

import type { ParentPort } from 'electron';

import { setHost } from './host';
import { nodeHost } from './hostNode';
import { computeStats, type ComputeStatsOptions } from './stats';
import type { StatsReport } from '../shared/types';

export interface StatsWorkerRequest {
  id: number;
  /// `host().dataDir()` as the parent sees it — the app's userData directory.
  dataDir: string;
  /// Passed straight to `computeStats()`. Empty in production; a test uses it
  /// to aim the scan at a fixture tree instead of the developer's real
  /// `~/.claude`.
  opts: ComputeStatsOptions;
}

export type StatsWorkerResponse =
  | { id: number; ok: true; report: StatsReport }
  | { id: number; ok: false; error: string };

/// Electron hands a utility process its channel to the parent on
/// `process.parentPort`. It is absent everywhere else, which is the check
/// statsService.ts's fallback path relies on.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

let hostDataDir: string | null = null;

/// Install the host once, on the first request. Later requests carry the same
/// directory (the parent reads it from one place), so a changed value would
/// mean the parent was reconfigured mid-run and the worker should follow.
function ensureHost(dataDir: string): void {
  if (hostDataDir === dataDir) return;
  setHost(nodeHost({ dataDir }));
  hostDataDir = dataDir;
}

if (parentPort) {
  parentPort.on('message', (event: { data: StatsWorkerRequest }) => {
    const req = event.data;
    let response: StatsWorkerResponse;
    try {
      ensureHost(req.dataDir);
      response = { id: req.id, ok: true, report: computeStats(req.opts ?? {}) };
    } catch (e) {
      // Errors travel as strings: an Error doesn't survive structured clone
      // with anything the parent can use, and the parent only ever logs it.
      response = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    parentPort.postMessage(response);
  });
}
