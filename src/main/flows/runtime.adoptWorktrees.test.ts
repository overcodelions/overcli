// A team piece that has its stage to itself works straight in the task
// branch's own worktrees. The run must neither fork new ones nor take the
// borrowed ones down with it — they belong to the team task.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

useTestHost('/tmp/overcli-runtime-adopt-worktrees-tests');

vi.mock('./runsStore', () => ({ loadAllRuns: () => [], saveRun: vi.fn(), deleteRun: vi.fn() }));
vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'test-flow',
      name: 'Test Flow',
      input: 'user_prompt',
      participants: [{ id: 'primary', name: 'Sonnet', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' }],
      steps: [{ id: 'build', participantId: 'primary', role: 'implementer', inputs: [], tools: ['Read'], output: 'code.md' }],
      source: 'user',
      filePath: '/tmp/test.yaml',
    },
  ],
}));
vi.mock('./preflight', () => ({ preflightRun: async () => ({ ok: true, checks: [] }), formatPreflight: () => '' }));

const { mockCreateWorktree, mockEnsureRoot, mockRemoveCoordinator, mockRemoveWorktree } = vi.hoisted(() => ({
  mockCreateWorktree: vi.fn(),
  mockEnsureRoot: vi.fn(),
  mockRemoveCoordinator: vi.fn(),
  mockRemoveWorktree: vi.fn(),
}));

vi.mock('../workspace', () => ({
  ensureCoordinatorSymlinkRoot: mockEnsureRoot,
  removeCoordinatorSymlinkRoot: mockRemoveCoordinator,
}));
vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  createWorktreeAsync: mockCreateWorktree,
  detectBaseBranchAsync: vi.fn(async () => 'main'),
  removeWorktreeAsync: mockRemoveWorktree,
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: 'abc123\n', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, Project, Workspace } from '../../shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-adopt-'));
const WS_ROOT = '/tmp/acme-workspace';
const taskDir = path.join(tmp, 'task-1');
const apiTree = path.join(taskDir, 'api');
const webTree = path.join(taskDir, 'web');
fs.mkdirSync(apiTree, { recursive: true });
fs.mkdirSync(webTree, { recursive: true });

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PROJECTS = [
  { id: 'p1', name: 'api', path: '/repos/api' },
  { id: 'p2', name: 'web', path: '/repos/web' },
] as unknown as Project[];
const WORKSPACES = [{ id: 'w1', name: 'acme', rootPath: WS_ROOT, projectIds: ['p1', 'p2'] }] as unknown as Workspace[];

function runtime() {
  return new FlowRuntimeImpl(
    { send: () => ({ ok: true as const }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => PROJECTS,
    () => ({ backends: {}, agentBranchPrefix: 'agent/' }) as unknown as AppSettings,
    () => WORKSPACES,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureRoot.mockReturnValue({ ok: true, rootPath: '/tmp/coordinator-root' });
  mockRemoveCoordinator.mockReturnValue({ ok: true });
  mockRemoveWorktree.mockResolvedValue({ ok: true });
});

describe('a run on adopted worktrees', () => {
  it('works in the task branch checkout of a single project, owning nothing', async () => {
    const rt = runtime();
    const started = await rt.startRun({
      flowId: 'test-flow',
      projectPath: '/repos/api',
      userPrompt: 'Fix ABC-1234',
      runIn: 'worktree',
      adoptWorktrees: { branch: 'team/fix-login', repos: [{ name: 'api', projectPath: '/repos/api', worktreePath: apiTree }] },
    });
    if (!started.ok) throw new Error(started.error);
    const run = rt.getRun(started.runId)!;
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(run).toMatchObject({
      projectPath: apiTree,
      worktreePath: apiTree,
      branchName: 'team/fix-login',
      sourceProjectPath: '/repos/api',
      adoptedWorktree: true,
      baselineCommit: 'abc123',
    });
    expect(run.baseBranch).toBeUndefined();

    expect(rt.deleteRun({ runId: started.runId, force: true })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mockRemoveCoordinator).toHaveBeenCalledWith(started.runId));
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(apiTree)).toBe(true);
  });

  it('links every member of a workspace under one root, and leaves them be on delete', async () => {
    const rt = runtime();
    const started = await rt.startRun({
      flowId: 'test-flow',
      projectPath: WS_ROOT,
      userPrompt: 'Fix ABC-1234',
      runIn: 'worktree',
      adoptWorktrees: {
        branch: 'team/fix-login',
        repos: [
          { name: 'api', projectPath: '/repos/api', worktreePath: apiTree },
          { name: 'web', projectPath: '/repos/web', worktreePath: webTree },
        ],
      },
    });
    if (!started.ok) throw new Error(started.error);
    const run = rt.getRun(started.runId)!;
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockEnsureRoot).toHaveBeenCalledWith(started.runId, [
      { name: 'api', worktreePath: apiTree },
      { name: 'web', worktreePath: webTree },
    ]);
    expect(run.projectPath).toBe('/tmp/coordinator-root');
    expect(run.sourceProjectPath).toBe(WS_ROOT);
    expect(run.workspaceWorktrees?.map((m) => m.branchName)).toEqual(['team/fix-login', 'team/fix-login']);
    expect(run.adoptedWorktree).toBe(true);

    expect(rt.deleteRun({ runId: started.runId, force: true })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mockRemoveCoordinator).toHaveBeenCalledWith(started.runId));
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('refuses to start when the task branch checkout is gone', async () => {
    const rt = runtime();
    const started = await rt.startRun({
      flowId: 'test-flow',
      projectPath: '/repos/api',
      userPrompt: 'Fix it',
      runIn: 'worktree',
      adoptWorktrees: {
        branch: 'team/fix-login',
        repos: [{ name: 'api', projectPath: '/repos/api', worktreePath: path.join(tmp, 'missing') }],
      },
    });
    expect(started).toEqual({ ok: false, error: 'The team/fix-login checkout for api is gone.' });
  });

  it("a shared batch's run keeps its base, so it can review and merge the branch", async () => {
    // A batch forks every repo's worktree under the same folder name, so the
    // links are named after the projects instead.
    const apiShared = path.join(tmp, 'shared', 'api', 'batch-1');
    const webShared = path.join(tmp, 'shared', 'web', 'batch-1');
    fs.mkdirSync(apiShared, { recursive: true });
    fs.mkdirSync(webShared, { recursive: true });
    const rt = runtime();
    const started = await rt.startRun({
      flowId: 'test-flow',
      projectPath: WS_ROOT,
      userPrompt: 'Fix ABC-1234',
      runIn: 'worktree',
      adoptWorktrees: {
        branch: 'agent/batch-1',
        repos: [
          { name: 'api', projectPath: '/repos/api', worktreePath: apiShared },
          { name: 'web', projectPath: '/repos/web', worktreePath: webShared },
        ],
        batch: { baseBranch: 'develop' },
      },
    });
    if (!started.ok) throw new Error(started.error);
    const run = rt.getRun(started.runId)!;
    expect(mockCreateWorktree).not.toHaveBeenCalled();
    expect(mockEnsureRoot).toHaveBeenCalledWith(started.runId, [
      { name: 'api', worktreePath: apiShared },
      { name: 'web', worktreePath: webShared },
    ]);
    expect(run).toMatchObject({ adoptedWorktree: 'batch', baseBranch: 'develop' });

    expect(rt.deleteRun({ runId: started.runId, force: true })).toEqual({ ok: true });
    await vi.waitFor(() => expect(mockRemoveCoordinator).toHaveBeenCalledWith(started.runId));
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });
});
