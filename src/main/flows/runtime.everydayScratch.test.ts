import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const scratchBase = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-scratch-'));

vi.mock('./runsStore', () => ({ loadAllRuns: () => [], saveRun: vi.fn(), deleteRun: vi.fn() }));
vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'flow-1',
      name: 'Trip brief',
      input: 'user_prompt',
      participants: [{ id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' }],
      steps: [{ id: 'write', participantId: 'primary', role: 'implementer', inputs: [], tools: ['Read'], output: 'brief.md' }],
      source: 'user',
      filePath: '/tmp/brief.yaml',
    },
  ],
}));
vi.mock('./preflight', () => ({ preflightRun: async () => ({ ok: true, problems: [] }), formatPreflight: () => '' }));
const createWorktreeAsync = vi.fn();
vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  createWorktreeAsync: (...a: unknown[]) => createWorktreeAsync(...a),
  detectBaseBranchAsync: vi.fn(async () => 'main'),
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));
vi.mock('../everydayProject', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../everydayProject')>()),
  hasEverydayMarker: (p: string) => p === '/docs/trips',
}));
vi.mock('../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace')>()),
  coordinatorRootPath: (id: string) => path.join(scratchBase, id),
}));

import { FlowRuntimeImpl } from './runtime';

afterAll(() => fs.rmSync(scratchBase, { recursive: true, force: true }));

function runtime() {
  return new FlowRuntimeImpl(
    { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as never,
  );
}

describe('a worker run on an everyday project', () => {
  it('runs in a plain throwaway folder, not a git worktree', async () => {
    const rt = runtime();
    const result = await rt.startRun({
      flowId: 'flow-1',
      projectPath: '/docs/trips',
      userPrompt: 'Brief the Norwalk trip.',
      runIn: 'worktree',
      workerId: 'worker-1',
      workerName: 'Soraya',
    });
    if (!result.ok) throw new Error(result.error);
    const run = rt.getRun(result.runId)!;
    expect(createWorktreeAsync).not.toHaveBeenCalled();
    expect(run).toMatchObject({ scratchRoot: true, sourceProjectPath: '/docs/trips' });
    expect(run.projectPath).toBe(path.join(scratchBase, result.runId));
    expect(run.branchName).toBeUndefined();
    expect(fs.existsSync(run.projectPath)).toBe(true);
  });
});
