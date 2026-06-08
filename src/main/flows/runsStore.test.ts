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

import type { FlowRun } from '../../shared/flows/schema';
import { deleteRun, flushRuns, loadAllRuns, saveRun } from './runsStore';

const MAX_ARTIFACT_BYTES = 256 * 1024;

function makeRun(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    flowId: 'solve-ticket',
    flowSnapshot: {
      id: 'solve-ticket',
      name: 'Solve ticket',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Primary',
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'primary',
        },
      ],
      steps: [
        {
          id: 'plan',
          participantId: 'primary',
          role: 'planner',
          inputs: ['user_prompt'],
          tools: ['Read'],
          output: 'plan.md',
        },
      ],
      source: 'user',
      filePath: '/tmp/solve-ticket.yaml',
    },
    projectPath: '/tmp/project',
    userPrompt: 'Fix the bug',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: 1,
    attempts: [],
    ...overrides,
  };
}

function runDir(): string {
  return path.join(userDataDir, 'flow-runs');
}

function runPath(id: string): string {
  return path.join(runDir(), `${id}.json`);
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-runs-'));
  mockGetPath.mockReturnValue(userDataDir);
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('saveRun', () => {
  it('truncates oversized artifact bodies before writing them to disk', async () => {
    const bigBody = 'a'.repeat(MAX_ARTIFACT_BYTES + 17);
    saveRun(
      makeRun({
        artifacts: {
          diff: {
            name: 'diff',
            kind: 'diff',
            body: bigBody,
            producedByStepId: 'build',
            producedAt: 123,
          },
        },
      }),
    );
    await flushRuns();

    const stored = JSON.parse(fs.readFileSync(runPath('run-1'), 'utf8')) as FlowRun;
    expect(stored.artifacts.diff.body).toContain('truncated 17 characters when persisted');
    expect(stored.artifacts.diff.body.startsWith('a'.repeat(MAX_ARTIFACT_BYTES))).toBe(true);
  });
});

describe('deleteRun', () => {
  it('removes the persisted run file when it exists', async () => {
    saveRun(makeRun({ id: 'run-delete' }));
    await flushRuns();
    expect(fs.existsSync(runPath('run-delete'))).toBe(true);

    deleteRun('run-delete');

    expect(fs.existsSync(runPath('run-delete'))).toBe(false);
  });
});

describe('loadAllRuns', () => {
  it('returns runs sorted by newest createdAt first', () => {
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(runPath('old'), JSON.stringify(makeRun({ id: 'old', createdAt: 1 })));
    fs.writeFileSync(runPath('new'), JSON.stringify(makeRun({ id: 'new', createdAt: 20 })));
    fs.writeFileSync(runPath('mid'), JSON.stringify(makeRun({ id: 'mid', createdAt: 10 })));

    const runs = loadAllRuns();

    expect(runs.map((run) => run.id)).toEqual(['new', 'mid', 'old']);
  });

  it('marks paused and running runs as aborted before restoring them', async () => {
    fs.mkdirSync(runDir(), { recursive: true });
    fs.writeFileSync(
      runPath('running'),
      JSON.stringify(makeRun({ id: 'running', state: { kind: 'running', currentStepId: 'plan' } })),
    );
    fs.writeFileSync(
      runPath('paused'),
      JSON.stringify(makeRun({ id: 'paused', state: { kind: 'paused', nextStepId: 'plan', reason: 'failure' } })),
    );

    const runs = loadAllRuns();
    // loadAllRuns persists the corrected `aborted` state via the now-async
    // saveRun, so flush before asserting the on-disk write landed.
    await flushRuns();

    expect(runs.map((run) => run.state)).toEqual([
      { kind: 'aborted' },
      { kind: 'aborted' },
    ]);
    expect(JSON.parse(fs.readFileSync(runPath('running'), 'utf8')).state).toEqual({ kind: 'aborted' });
    expect(JSON.parse(fs.readFileSync(runPath('paused'), 'utf8')).state).toEqual({ kind: 'aborted' });
  });
});
