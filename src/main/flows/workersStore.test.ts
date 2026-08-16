import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mockGetPath,
  },
}));

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
});
