// `releaseWorktree` flags a row orphaned only when the tree couldn't be
// removed by accident. A `kept:` answer is a deliberate refusal (its chat is
// running, or it has new changes) and leaves the row as it is. A branch that
// survived the remove keeps its pointer.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Project } from '@shared/types';

type InvokeResult = { ok: boolean; error?: string; warning?: string; branchKept?: boolean };

const releaseResult = { current: { ok: true } as InvokeResult };

function stubBridge(): void {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'git:releaseWorktree') return releaseResult.current;
    return undefined;
  });
  (globalThis as unknown as { window: unknown }).window = {
    overcli: { invoke, onMainEvent: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

stubBridge();

const { useStore } = await import('./store');

function agent(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'agent-1',
    name: 'add tests',
    worktreePath: '/Users/x/.overcli/worktrees/proj/add-tests',
    branchName: 'feature/add-tests',
    baseBranch: 'main',
    ...over,
  } as Conversation;
}

function seed(conversations: Conversation[]): void {
  useStore.setState({
    projects: [{ id: 'proj-1', name: 'proj', path: '/Users/x/git/proj', conversations } as Project],
    workspaces: [],
    colosseums: [],
    selectedConversationId: null,
  } as never);
}

const row = () => useStore.getState().projects[0].conversations[0];

beforeEach(() => {
  releaseResult.current = { ok: true };
});

describe('releaseWorktree', () => {
  it('leaves a row alone when the release was deliberately kept', async () => {
    releaseResult.current = { ok: false, error: 'kept: its chat is running' };
    seed([agent()]);
    const res = await useStore.getState().releaseWorktree('agent-1', { unattended: true });
    expect(res.ok).toBe(false);
    expect(row().orphaned).toBeUndefined();
    expect(row().worktreePath).toBe('/Users/x/.overcli/worktrees/proj/add-tests');
  });

  it('flags the row orphaned when git failed for another reason', async () => {
    releaseResult.current = { ok: false, error: 'worktree is locked' };
    seed([agent()]);
    await useStore.getState().releaseWorktree('agent-1', { unattended: true });
    expect(row().orphaned).toBe(true);
  });

  it('keeps the branch pointer when the branch survived a delete that was asked for', async () => {
    releaseResult.current = { ok: true, branchKept: true, warning: "couldn't delete branch" };
    seed([agent()]);
    await useStore.getState().releaseWorktree('agent-1', { keepBranch: false });
    expect(row().worktreePath).toBeUndefined();
    expect(row().branchName).toBe('feature/add-tests');
  });

  it('drops the branch pointer when the branch is really gone', async () => {
    seed([agent()]);
    await useStore.getState().releaseWorktree('agent-1', { keepBranch: false });
    expect(row().branchName).toBeUndefined();
  });
});
