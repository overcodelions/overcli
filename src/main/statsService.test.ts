// The stats worker protocol, driven against a fake utilityProcess.
//
// What matters here is the main process never blocks and never loses a
// request: a reply resolves the right caller, a crashed or missing worker
// falls back to the in-process scan rather than leaving the stats page
// spinning, and two overlapping requests share one scan.
//
// The fallback assertions all aim `computeStats()` at an empty fixture home
// rather than the developer's real `~/.claude` — same reason stats.test.ts
// does (issue #269): the real one is gigabytes and takes tens of seconds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { forked } = vi.hoisted(() => ({ forked: [] as any[] }));

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn((entry: string) => {
      const listeners = new Map<string, (arg: any) => void>();
      const child = {
        entry,
        posted: [] as any[],
        killed: false,
        postMessage(m: any) {
          child.posted.push(m);
        },
        kill() {
          child.killed = true;
          return true;
        },
        on(event: string, fn: (arg: any) => void) {
          listeners.set(event, fn);
        },
        once(event: string, fn: (arg: any) => void) {
          listeners.set(event, fn);
        },
        emit(event: string, arg: any) {
          listeners.get(event)?.(arg);
        },
      };
      forked.push(child);
      return child;
    }),
  },
}));

import { computeStatsOffThread, stopStatsWorker } from './statsService';

let home: string;

beforeEach(() => {
  forked.length = 0;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-service-'));
});

afterEach(() => {
  stopStatsWorker();
  fs.rmSync(home, { recursive: true, force: true });
});

/// The one child the service forked, once it has forked one.
const child = () => forked[forked.length - 1];

describe('computeStatsOffThread', () => {
  it('forks a worker and resolves with the report it sends back', async () => {
    const pending = computeStatsOffThread();
    expect(forked).toHaveLength(1);
    expect(child().entry.endsWith(path.join('statsWorker.js'))).toBe(true);

    const req = child().posted[0];
    expect(req.dataDir).toBeTruthy();
    child().emit('message', { id: req.id, ok: true, report: { totalTurns: 7 } });

    await expect(pending).resolves.toMatchObject({ totalTurns: 7 });
  });

  it('reuses the worker across requests so the parse cache survives', async () => {
    const first = computeStatsOffThread();
    child().emit('message', { id: child().posted[0].id, ok: true, report: { totalTurns: 1 } });
    await first;

    const second = computeStatsOffThread();
    expect(forked).toHaveLength(1);
    child().emit('message', { id: child().posted[1].id, ok: true, report: { totalTurns: 2 } });
    await expect(second).resolves.toMatchObject({ totalTurns: 2 });
  });

  it('coalesces a request that arrives while a scan is in flight', async () => {
    const a = computeStatsOffThread();
    const b = computeStatsOffThread();
    expect(child().posted).toHaveLength(1);

    child().emit('message', { id: child().posted[0].id, ok: true, report: { totalTurns: 3 } });
    expect(await a).toBe(await b);
  });

  it('falls back to an in-process scan when the worker dies mid-request', async () => {
    const pending = computeStatsOffThread({ homeDir: home });
    child().emit('exit', 9);
    // A real report from the empty fixture home, not the worker's answer.
    await expect(pending).resolves.toMatchObject({ totalTurns: 0 });
  });

  it('falls back when the worker reports an error', async () => {
    const pending = computeStatsOffThread({ homeDir: home });
    child().emit('message', { id: child().posted[0].id, ok: false, error: 'boom' });
    await expect(pending).resolves.toMatchObject({ totalTurns: 0 });
  });

  it('forks a replacement after the worker is stopped', async () => {
    const first = computeStatsOffThread();
    child().emit('message', { id: child().posted[0].id, ok: true, report: { totalTurns: 1 } });
    await first;

    stopStatsWorker();
    expect(child().killed).toBe(true);

    void computeStatsOffThread();
    expect(forked).toHaveLength(2);
  });
});
