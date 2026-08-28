import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

useTestHost(mockGetPath);

vi.mock('../diagnostics', () => ({
  log: vi.fn(),
}));

import type { Worker } from '../../shared/flows/worker';
import { deleteWorker, loadAllWorkers, saveWorker } from './workersStore';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: 'worker-1',
    name: 'Scout',
    jobDescription: 'Review incoming work and prioritize useful maintenance.',
    projectPath: '/tmp/project',
    cadence: { kind: 'daily', time: '09:00' },
    trust: 'autonomous',
    caps: { maxItemsPerShift: 3, runIn: 'worktree' },
    budgetUSDPerMonth: 25,
    heartbeatModel: 'gpt-5',
    flowIds: ['flow-1'],
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function workersDir(): string {
  return path.join(userDataDir, 'workers');
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-workers-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('workersStore', () => {
  it('round-trips a saved worker unchanged', () => {
    const worker = makeWorker({ lastShiftAt: 20, shiftCount: 4 });

    saveWorker(worker);

    expect(loadAllWorkers()).toEqual([worker]);
  });

  it('returns workers newest first', () => {
    saveWorker(makeWorker({ id: 'old', createdAt: 1 }));
    saveWorker(makeWorker({ id: 'new', createdAt: 2 }));

    expect(loadAllWorkers().map((worker) => worker.id)).toEqual(['new', 'old']);
  });

  it('repairs a persisted worker with no flow IDs to an empty list', () => {
    fs.mkdirSync(workersDir(), { recursive: true });
    const { flowIds: _flowIds, ...withoutFlowIds } = makeWorker();
    fs.writeFileSync(path.join(workersDir(), 'legacy.json'), JSON.stringify(withoutFlowIds));

    expect(loadAllWorkers()).toEqual([{ ...withoutFlowIds, flowIds: [] }]);
  });

  it('deletes a persisted worker by ID', () => {
    saveWorker(makeWorker());

    deleteWorker('worker-1');

    expect(loadAllWorkers()).toEqual([]);
  });

  it('refuses an id that would escape the workers directory', () => {
    // A compromised renderer calling workers:save with a traversal id would
    // otherwise write, and then delete, an arbitrary path outside userData.
    const escapee = path.join(userDataDir, 'evil.json');
    expect(() => saveWorker(makeWorker({ id: '../evil' }))).toThrow(/Unsafe worker id/);
    expect(fs.existsSync(escapee)).toBe(false);
    // `deleteWorker` is best-effort and swallows the guard's throw — what
    // matters is that the traversal delete never reaches `rmSync`.
    const bystander = path.join(userDataDir, 'evil.json');
    fs.writeFileSync(bystander, 'not mine to delete');
    expect(() => deleteWorker('../evil')).not.toThrow();
    expect(fs.existsSync(bystander)).toBe(true);
    expect(() => saveWorker(makeWorker({ id: 'a/b' }))).toThrow(/Unsafe worker id/);
    expect(() => saveWorker(makeWorker({ id: '..' }))).toThrow(/Unsafe worker id/);
    expect(() => saveWorker(makeWorker({ id: '.' }))).toThrow(/Unsafe worker id/);
    // A real id is a UUID, so the guard costs nothing legitimate.
    expect(() => saveWorker(makeWorker({ id: '3f2a1c4e-0b7d-4f9a-8c21-5e6d7a8b9c01' }))).not.toThrow();
  });
});
