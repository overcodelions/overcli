// The worker's message loop, driven through a stubbed `process.parentPort`.
//
// This file exists because the worker fails silently: statsService.ts catches
// anything the child does wrong and falls back to scanning in process, so a
// regression here doesn't break the stats page — it just quietly puts the
// 15-second main-thread freeze back. Nothing else would go red.
//
// The scan is aimed at an empty fixture home for the reason stats.test.ts
// gives (issue #269): the real `~/.claude` is gigabytes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { host } from './host';
import type { StatsWorkerRequest, StatsWorkerResponse } from './statsWorker';

/// A scan that fails has no natural trigger — `computeStats()` is written to
/// survive a missing home, an unreadable transcript and an unusable data
/// directory, and returns an empty report rather than throwing. So the one
/// thing that can reach the worker's catch is a throw from the scan itself,
/// and the real implementation is kept for every other case.
const { THROW_HOME } = vi.hoisted(() => ({ THROW_HOME: '::throw::' }));

vi.mock('./stats', async () => {
  const actual = await vi.importActual<typeof import('./stats')>('./stats');
  return {
    ...actual,
    computeStats: (opts: { homeDir?: string } = {}) => {
      if (opts.homeDir === THROW_HOME) throw new Error('scan exploded');
      return actual.computeStats(opts);
    },
  };
});

const posted: StatsWorkerResponse[] = [];
let deliver: (event: { data: StatsWorkerRequest }) => void;

beforeAll(async () => {
  // Installed before the import: the module wires its listener at load time,
  // and reads `process.parentPort` exactly once while doing it.
  (process as unknown as { parentPort: unknown }).parentPort = {
    on(event: string, fn: (e: { data: StatsWorkerRequest }) => void) {
      if (event === 'message') deliver = fn;
    },
    postMessage(m: StatsWorkerResponse) {
      posted.push(m);
    },
  };
  await import('./statsWorker');
});

beforeEach(() => {
  posted.length = 0;
});

/// An empty home, so the scan finds no transcripts and returns fast.
function emptyHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worker-home-'));
}

function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'worker-data-'));
}

describe('statsWorker', () => {
  it('answers a request with the report, tagged with the request id', () => {
    deliver({ data: { id: 11, dataDir: tmpDataDir(), opts: { homeDir: emptyHome() } } });

    expect(posted).toHaveLength(1);
    const reply = posted[0];
    expect(reply.id).toBe(11);
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.report).toMatchObject({ totalTurns: 0, totalSessions: 0 });
  });

  it('installs the host at the data directory the parent sent', () => {
    const dataDir = tmpDataDir();
    deliver({ data: { id: 12, dataDir, opts: { homeDir: emptyHome() } } });

    // `fs.realpathSync` because macOS hands out `/var/…` symlinks for temp
    // directories and `nodeHost` resolves the path it was given.
    expect(fs.realpathSync(host().dataDir())).toBe(fs.realpathSync(dataDir));
  });

  it('stays attached across requests, and follows a changed data directory', () => {
    const second = tmpDataDir();
    deliver({ data: { id: 13, dataDir: tmpDataDir(), opts: { homeDir: emptyHome() } } });
    deliver({ data: { id: 14, dataDir: second, opts: { homeDir: emptyHome() } } });

    expect(posted.map((m) => m.id)).toEqual([13, 14]);
    expect(posted.every((m) => m.ok)).toBe(true);
    expect(fs.realpathSync(host().dataDir())).toBe(fs.realpathSync(second));
  });

  it('reports a failed scan as an error instead of taking the worker down', () => {
    expect(() =>
      deliver({ data: { id: 15, dataDir: tmpDataDir(), opts: { homeDir: THROW_HOME } } }),
    ).not.toThrow();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: 15, ok: false, error: 'scan exploded' });

    // And the port is still live for the next request.
    deliver({ data: { id: 16, dataDir: tmpDataDir(), opts: { homeDir: emptyHome() } } });
    expect(posted[1]).toMatchObject({ id: 16, ok: true });
  });
});
