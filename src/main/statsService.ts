// Main-process side of the off-thread stats scan. Owns the utility process
// that statsWorker.ts runs in: spawns it on demand, correlates replies by id,
// and gets out of the way when nothing has asked for stats in a while.
//
// Why a process and not a worker thread: the scan's cost is `readFileSync` +
// `JSON.parse` over gigabytes of transcripts, and the parsed events it caches
// are a heap of their own. A separate process keeps both the CPU and that
// heap off the main process, and lets us hand the memory back by exiting.
//
// Three behaviours the callers depend on:
//
//   - Coalescing. Every caller wants the same global report, so a request
//     that arrives while a scan is in flight joins that scan instead of
//     queueing a second one. Being a few seconds stale is invisible; scanning
//     2 GB twice back to back is not.
//   - Fallback. If the fork fails — no Electron (tests, `overcli run`), a
//     missing `dist/main/statsWorker.js` during a partial dev build, a
//     sandbox that won't allow it — we run the scan in process rather than
//     failing the request. That is the old behaviour, beachball and all, but
//     a slow stats page beats a broken one.
//   - Idle exit. The worker's parse cache is what makes repeat visits fast,
//     so it stays alive between requests; after IDLE_EXIT_MS with nothing to
//     do it exits and gives the memory back. The next request pays for a cold
//     cache, which is the same price the first one paid.

import path from 'node:path';

import { utilityProcess } from 'electron';

import { logSilent } from './diagnostics';
import { host } from './host';
import { computeStats, type ComputeStatsOptions } from './stats';
import type { StatsWorkerRequest, StatsWorkerResponse } from './statsWorker';
import type { StatsReport } from '../shared/types';

/// How long the worker sticks around with no requests before exiting. Long
/// enough to cover "open stats, look away, come back"; short enough that a
/// stats page visited once in the morning isn't still holding a few hundred
/// megabytes at lunch.
const IDLE_EXIT_MS = 10 * 60_000;

/// Upper bound on a single scan. Nothing observed comes close — a cold scan
/// of a 2.5 GB history is tens of seconds — so this is purely so a wedged
/// worker surfaces as an error the stats page can stop spinning on instead of
/// a promise nobody ever settles.
const SCAN_TIMEOUT_MS = 5 * 60_000;

/// The subset of Electron's UtilityProcess this file uses. Written out rather
/// than imported because its `on('message')` overload types the payload as
/// `any`, and naming the response shape here is what makes `onMessage` safe.
interface WorkerHandle {
  postMessage(message: unknown): void;
  kill(): boolean;
  once(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message', listener: (message: StatsWorkerResponse) => void): void;
}

interface Pending {
  resolve: (report: StatsReport) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let worker: WorkerHandle | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let inFlight: Promise<StatsReport> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

/// Compute the stats report without blocking the main process.
///
/// Resolves with the same report `computeStats()` would have returned; falls
/// back to computing it in process when no worker can be had.
export function computeStatsOffThread(opts: ComputeStatsOptions = {}): Promise<StatsReport> {
  // `homeDir` only ever comes from a test pointing the scan at a fixture
  // tree, and a coalesced request would hand it the wrong tree's numbers.
  if (opts.homeDir) return requestScan(opts);
  if (inFlight) return inFlight;
  const run = requestScan(opts).finally(() => {
    inFlight = null;
    scheduleIdleExit();
  });
  inFlight = run;
  return run;
}

/// Stop the worker. Called on quit, and by the idle timer.
export function stopStatsWorker(): void {
  clearIdleTimer();
  const w = worker;
  worker = null;
  if (!w) return;
  try {
    w.kill();
  } catch (e) {
    logSilent('statsService.kill', e);
  }
}

function requestScan(opts: ComputeStatsOptions): Promise<StatsReport> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(computeStats(opts));

  const id = nextId++;
  const request: StatsWorkerRequest = { id, dataDir: host().dataDir(), opts };
  return new Promise<StatsReport>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A worker that missed one deadline has no credibility left; drop it so
      // the next request starts from a fresh process.
      settle(id, (p) => p.reject(new Error('stats scan timed out')));
      stopStatsWorker();
    }, SCAN_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage(request);
    } catch (e) {
      settle(id, (p) => p.reject(e instanceof Error ? e : new Error(String(e))));
      stopStatsWorker();
    }
  }).catch((e) => {
    // The page asked for stats; give it stats. Slowly beats not at all.
    logSilent('statsService.scan', e);
    return computeStats(opts);
  });
}

function settle(id: number, apply: (p: Pending) => void): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  clearTimeout(p.timer);
  apply(p);
}

function ensureWorker(): WorkerHandle | null {
  clearIdleTimer();
  if (worker) return worker;
  // Absent outside a real Electron run — under vitest and `overcli run` the
  // fallback path is the correct answer anyway.
  if (!utilityProcess) return null;
  try {
    // Sibling of `dist/main/index.js`, inside the asar in a packaged build —
    // utilityProcess resolves asar paths the same way the main process does.
    const entry = path.join(__dirname, 'statsWorker.js');
    const w = utilityProcess.fork(entry, [], { stdio: 'ignore' }) as unknown as WorkerHandle;
    w.on('message', onMessage);
    w.once('exit', (code) => {
      if (w === worker) worker = null;
      // Anything still waiting on a dead worker will never hear back. Fail
      // them now so `requestScan`'s catch can fall back in process.
      for (const id of [...pending.keys()]) {
        settle(id, (p) => p.reject(new Error(`stats worker exited (${code})`)));
      }
    });
    worker = w;
    return w;
  } catch (e) {
    logSilent('statsService.fork', e);
    return null;
  }
}

function onMessage(message: StatsWorkerResponse): void {
  if (!message || typeof message.id !== 'number') return;
  settle(message.id, (p) => {
    if (message.ok) p.resolve(message.report);
    else p.reject(new Error(message.error));
  });
}

function scheduleIdleExit(): void {
  clearIdleTimer();
  if (!worker) return;
  idleTimer = setTimeout(stopStatsWorker, IDLE_EXIT_MS);
  // Nothing about a cache eviction should hold the process open at quit.
  idleTimer.unref?.();
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}
