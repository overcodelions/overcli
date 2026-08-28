import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

import type { FlowRun } from '../../shared/flows/schema';
import type { AppSettings } from '../../shared/types';

const mocks = vi.hoisted(() => ({
  checkout: vi.fn(),
  currentBranch: vi.fn(),
  migrateSession: vi.fn(),
  restoredRuns: [] as FlowRun[],
  saveRun: vi.fn(),
}));

useTestHost('/tmp/overcli-flow-local-tests');

vi.mock('./runsStore', () => ({
  loadAllRuns: () => mocks.restoredRuns,
  saveRun: mocks.saveRun,
  deleteRun: vi.fn(),
}));

vi.mock('./storage', () => ({ loadAllFlows: () => [] }));
vi.mock('./preflight', () => ({
  preflightRun: async () => ({ ok: true, checks: [] }),
  formatPreflight: () => '',
}));
vi.mock('../history', () => ({ migrateClaudeSessionCwd: mocks.migrateSession }));
vi.mock('../workspace', () => ({
  ensureCoordinatorSymlinkRoot: () => ({ ok: true, rootPath: '/tmp/coordinator' }),
  removeCoordinatorSymlinkRoot: () => ({ ok: true }),
}));
vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  checkoutAgentLocally: mocks.checkout,
  createWorktreeAsync: vi.fn(),
  currentBranch: mocks.currentBranch,
  detectBaseBranchAsync: vi.fn(),
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';

function flowRun(projectPath: string, sourceProjectPath: string): FlowRun {
  return {
    id: 'run-1',
    flowId: 'flow-1',
    flowSnapshot: {
      id: 'flow-1',
      name: 'Build and verify',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Claude',
          backend: 'claude',
          model: 'claude-opus-5',
          kind: 'primary',
        },
        {
          id: 'reviewer',
          name: 'Codex',
          backend: 'codex',
          model: 'gpt-5.4',
          kind: 'worker',
        },
      ],
      steps: [],
      source: 'user',
      filePath: '/tmp/flow.yaml',
    },
    projectPath,
    sourceProjectPath,
    worktreePath: projectPath,
    branchName: 'feature/local-flow',
    userPrompt: 'build it',
    conversationIds: { primary: 'conv-1', reviewer: 'conv-2' },
    sessionIdsByParticipant: { primary: 'claude-session', reviewer: 'codex-session' },
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: 1,
    attempts: [],
  };
}

function runtime() {
  return new FlowRuntimeImpl(
    {} as never,
    vi.fn(),
    () => [],
    () => ({}) as AppSettings,
  );
}

beforeEach(() => {
  mocks.restoredRuns.length = 0;
  vi.clearAllMocks();
  mocks.currentBranch.mockReturnValue({ isRepo: true, branch: 'feature/local-flow' });
  mocks.checkout.mockReturnValue({
    ok: true,
    message: 'checked out',
    stashed: false,
    autoCommitted: false,
  });
});

describe('flow local checkout rebinding', () => {
  it('repairs a persisted run whose worktree is gone and branch is already local', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-flow-local-'));
    const source = path.join(root, 'repo');
    fs.mkdirSync(source);
    const run = flowRun(path.join(root, 'gone-worktree'), source);
    mocks.restoredRuns.push(run);

    const restored = runtime().getRun(run.id)!;

    expect(restored.projectPath).toBe(source);
    expect(restored.worktreePath).toBeUndefined();
    expect(restored.checkedOutLocally).toBe(true);
    expect(mocks.migrateSession).toHaveBeenCalledOnce();
    expect(mocks.migrateSession).toHaveBeenCalledWith({
      worktreePath: path.join(root, 'gone-worktree'),
      projectPath: source,
      sessionId: 'claude-session',
    });
    expect(mocks.saveRun).toHaveBeenCalledWith(restored);
  });

  it('checks out, migrates Claude sessions, persists, and emits the rebound run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-flow-local-'));
    const source = path.join(root, 'repo');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(source);
    fs.mkdirSync(worktree);
    const run = flowRun(worktree, source);
    mocks.restoredRuns.push(run);
    const emitted = vi.fn();
    const rt = new FlowRuntimeImpl(
      {} as never,
      emitted,
      () => [],
      () => ({}) as AppSettings,
    );

    expect(
      rt.checkoutRunLocally({ runId: run.id, commitSubject: 'Keep working locally' }),
    ).toMatchObject({ ok: true, message: 'checked out' });
    expect(mocks.checkout).toHaveBeenCalledWith({
      projectPath: source,
      worktreePath: worktree,
      branchName: 'feature/local-flow',
      commitSubject: 'Keep working locally',
      commitBody: undefined,
    });
    expect(mocks.migrateSession).toHaveBeenCalledOnce();
    expect(rt.getRun(run.id)).toMatchObject({
      projectPath: source,
      checkedOutLocally: true,
    });
    expect(rt.getRun(run.id)?.worktreePath).toBeUndefined();
    expect(mocks.saveRun).toHaveBeenCalledWith(rt.getRun(run.id));
    expect(emitted).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'flowRunUpdate' }),
    );
  });
});
