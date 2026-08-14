// Base-branch handling when a workspace run forks a worktree per member.
//
// The shared base is a hint across N independent repos, not a contract. A
// schedule stores whatever branch was picked when it was last edited, and
// that name outlives the target it was picked against — so main has to cope
// with a base branch that some (or every) member has never heard of, rather
// than failing the whole launch on the first repo that doesn't have it.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));

vi.mock('./storage', () => ({
  loadAllFlows: () => [
    {
      id: 'test-flow',
      name: 'Test Flow',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Sonnet',
          backend: 'claude',
          model: 'claude-sonnet-4-6',
          kind: 'primary',
        },
      ],
      steps: [
        {
          id: 'build',
          participantId: 'primary',
          role: 'implementer',
          inputs: [],
          tools: ['Read'],
          output: 'code.md',
        },
      ],
      source: 'user',
      filePath: '/tmp/test.yaml',
    },
  ],
}));

vi.mock('./preflight', () => ({
  preflightRun: async () => ({ ok: true, checks: [] }),
  formatPreflight: () => '',
}));

vi.mock('../workspace', () => ({
  ensureCoordinatorSymlinkRoot: () => ({ ok: true, rootPath: '/tmp/coordinator-root' }),
}));

const { mockCreateWorktree, mockDetect, mockExists } = vi.hoisted(() => ({
  mockCreateWorktree: vi.fn(),
  mockDetect: vi.fn(),
  mockExists: vi.fn(),
}));

vi.mock('../git', () => ({
  baseBranchExistsAsync: mockExists,
  createWorktreeAsync: mockCreateWorktree,
  detectBaseBranchAsync: mockDetect,
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';
import type { AppSettings, MainToRendererEvent, Project, Workspace } from '../../shared/types';

const WS_ROOT = '/tmp/workspace-root';

/// Two members that disagree about their default branch — the exact shape
/// that made a single shared base unworkable in the first place.
const PROJECTS = [
  { id: 'p1', name: 'has-the-branch', path: '/repos/has-the-branch' },
  { id: 'p2', name: 'never-had-it', path: '/repos/never-had-it' },
] as unknown as Project[];

const WORKSPACES = [
  { id: 'w1', name: 'unifyr', rootPath: WS_ROOT, projectIds: ['p1', 'p2'] },
] as unknown as Workspace[];

function harness() {
  const runner = { send: () => ({ ok: true as const }) };
  const emitted: MainToRendererEvent[] = [];
  const rt = new FlowRuntimeImpl(
    runner as never,
    (e) => emitted.push(e),
    () => PROJECTS,
    () => ({ backends: {}, agentBranchPrefix: 'agent/' }) as unknown as AppSettings,
    () => WORKSPACES,
  );
  return { rt };
}

/// Which base branch each member's worktree was actually forked off.
function basesByRepo(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const call of mockCreateWorktree.mock.calls) {
    out[call[0].projectPath] = call[0].baseBranch;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDetect.mockImplementation(async (p: string) =>
    p === '/repos/never-had-it' ? 'master' : 'main',
  );
  mockCreateWorktree.mockImplementation(async (args: { projectPath: string; agentName: string }) => ({
    ok: true,
    worktreePath: `${args.projectPath}/wt`,
    branchName: `agent/${args.agentName}`,
  }));
});

describe('workspace worktree base branch', () => {
  it('falls back to a member\'s own default when the shared base is missing there', async () => {
    mockExists.mockImplementation(async (p: string) => p === '/repos/has-the-branch');

    const res = await harness().rt.startRun({
      flowId: 'test-flow',
      projectPath: WS_ROOT,
      userPrompt: 'write a cypress spec',
      runIn: 'worktree',
      baseBranch: 'feature/from-another-repo',
    } as never);

    expect(res.ok).toBe(true);
    expect(basesByRepo()).toEqual({
      // Present here, so the user's pick still wins.
      '/repos/has-the-branch': 'feature/from-another-repo',
      // Never had it — forked off its own default instead of failing.
      '/repos/never-had-it': 'master',
    });
  });

  it('fails no member when the shared base exists in none of them', async () => {
    mockExists.mockResolvedValue(false);

    const res = await harness().rt.startRun({
      flowId: 'test-flow',
      projectPath: WS_ROOT,
      userPrompt: 'write a cypress spec',
      runIn: 'worktree',
      baseBranch: 'feature/im-not-seeing-the-latest-branches',
    } as never);

    expect(res.ok).toBe(true);
    expect(basesByRepo()).toEqual({
      '/repos/has-the-branch': 'main',
      '/repos/never-had-it': 'master',
    });
  });

  it('does not consult git at all when no shared base was given', async () => {
    const res = await harness().rt.startRun({
      flowId: 'test-flow',
      projectPath: WS_ROOT,
      userPrompt: 'write a cypress spec',
      runIn: 'worktree',
    } as never);

    expect(res.ok).toBe(true);
    expect(mockExists).not.toHaveBeenCalled();
    expect(basesByRepo()).toEqual({
      '/repos/has-the-branch': 'main',
      '/repos/never-had-it': 'master',
    });
  });
});
