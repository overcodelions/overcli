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

import type { FlowRun } from '../../shared/flows/schema';

// Fresh module per test so the in-memory cache doesn't bleed between cases.
async function freshLog(): Promise<typeof import('./workLog')> {
  vi.resetModules();
  return import('./workLog');
}

function makeRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    flowId: 'flow-1',
    flowSnapshot: { name: 'Ticket to PR' },
    projectPath: '/code/acme',
    userPrompt: 'Add the login page',
    state: { kind: 'aborted' },
    createdAt: 1,
    attempts: [{ stepId: 's1', costUSD: 1, startedAt: 1, endedAt: 10 }],
    ...overrides,
  } as unknown as FlowRun;
}

const logFile = () => path.join(userDataDir, 'work-log.jsonl');
const lineCount = () => fs.readFileSync(logFile(), 'utf-8').split('\n').filter(Boolean).length;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-work-log-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('appendWorkLog', () => {
  it('replaces an aborted entry when the run is re-run and finishes', async () => {
    const { appendWorkLog, loadWorkLog } = await freshLog();
    appendWorkLog(makeRun());
    appendWorkLog(
      makeRun({
        state: { kind: 'done', success: true } as FlowRun['state'],
        attempts: [{ stepId: 's1', costUSD: 1, startedAt: 20, endedAt: 30 }] as FlowRun['attempts'],
      }),
    );
    const entries = await loadWorkLog();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ runId: 'run-1', outcome: 'done', at: 30 });

    // And a fresh process reading the file agrees: last write wins.
    const reread = await freshLog();
    expect((await reread.loadWorkLog())[0].outcome).toBe('done');
  });

  it('does not append again when a terminal run is saved unchanged', async () => {
    const { appendWorkLog } = await freshLog();
    appendWorkLog(makeRun());
    appendWorkLog(makeRun());
    // No attempts: `at` would be "now" each time, which must not count as a change.
    appendWorkLog(makeRun({ id: 'run-2', attempts: [] as FlowRun['attempts'] }));
    appendWorkLog(makeRun({ id: 'run-2', attempts: [] as FlowRun['attempts'] }));
    expect(lineCount()).toBe(2);
  });

  it('serves repeat loads from memory but sees a write from elsewhere', async () => {
    const { appendWorkLog, loadWorkLog } = await freshLog();
    appendWorkLog(makeRun());
    await loadWorkLog();
    const read = vi.spyOn(fs, 'readFileSync');
    await loadWorkLog();
    expect(read.mock.calls.some(([f]) => f === logFile())).toBe(false);

    const other = { ...JSON.parse(fs.readFileSync(logFile(), 'utf-8').trim()), runId: 'run-x' };
    fs.appendFileSync(logFile(), JSON.stringify(other) + '\n');
    expect((await loadWorkLog()).map((e) => e.runId).sort()).toEqual(['run-1', 'run-x']);
    read.mockRestore();
  });

  it('compacts once superseded lines pile up', async () => {
    const { appendWorkLog, loadWorkLog } = await freshLog();
    for (let i = 0; i < 260; i++) {
      appendWorkLog(
        makeRun({ attempts: [{ stepId: 's1', costUSD: 1, startedAt: 1, endedAt: 10 + i }] as FlowRun['attempts'] }),
      );
    }
    expect(lineCount()).toBeLessThan(260);
    const entries = await loadWorkLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].at).toBe(269);
  });
});
