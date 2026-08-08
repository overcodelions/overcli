// `removeAgent` must never drop a conversation whose worktree it failed to
// remove. The conversation row is the ONLY thing recording that path — once
// it's gone the tree is unreachable from the app, which is how installs
// accumulate orphaned worktrees. On failure we keep the row, flag it
// `orphaned`, and let the user retry.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Project } from '@shared/types';

type InvokeResult = { ok: boolean; error?: string; warning?: string };

const removeWorktreeResult = { current: { ok: true } as InvokeResult };
const invoked: Array<{ channel: string; args: unknown }> = [];

function stubBridge(): void {
  const invoke = vi.fn(async (channel: string, args: unknown) => {
    invoked.push({ channel, args });
    if (channel === 'git:removeWorktree') return removeWorktreeResult.current;
    if (channel === 'store:saveProjects' || channel === 'store:saveWorkspaces') return undefined;
    if (channel === 'runner:release') return undefined;
    return undefined;
  });
  // store.ts registers a `beforeunload` flush at module scope, so the stub
  // needs the listener surface as well as the bridge.
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

function project(conversations: Conversation[]): Project {
  return {
    id: 'proj-1',
    name: 'proj',
    path: '/Users/x/git/proj',
    conversations,
  } as Project;
}

function seed(conversations: Conversation[]): void {
  useStore.setState({
    projects: [project(conversations)],
    workspaces: [],
    colosseums: [],
    selectedConversationId: null,
  } as never);
}

beforeEach(() => {
  invoked.length = 0;
  removeWorktreeResult.current = { ok: true };
});

describe('removeAgent when the worktree removal fails', () => {
  it('keeps the conversation and flags it orphaned', async () => {
    removeWorktreeResult.current = { ok: false, error: 'worktree is locked' };
    seed([agent()]);

    const res = await useStore.getState().removeAgent('agent-1');

    expect(res.ok).toBe(false);
    expect(res.error).toContain('locked');
    const rows = useStore.getState().projects[0].conversations;
    expect(rows).toHaveLength(1);
    expect(rows[0].orphaned).toBe(true);
    // The path must survive verbatim — it's what a retry and the Storage
    // sweep both key off.
    expect(rows[0].worktreePath).toBe('/Users/x/.overcli/worktrees/proj/add-tests');
  });

  it('releases the backend session so the kept row is not left running', async () => {
    removeWorktreeResult.current = { ok: false, error: 'permission denied' };
    seed([agent()]);

    await useStore.getState().removeAgent('agent-1');

    expect(invoked.some((c) => c.channel === 'runner:release')).toBe(true);
  });

  it('persists the orphan flag rather than leaving it only in memory', async () => {
    removeWorktreeResult.current = { ok: false, error: 'nope' };
    seed([agent()]);

    await useStore.getState().removeAgent('agent-1');

    expect(invoked.some((c) => c.channel === 'store:saveProjects')).toBe(true);
  });
});

describe('removeAgent on success', () => {
  it('removes the conversation as before', async () => {
    seed([agent()]);

    const res = await useStore.getState().removeAgent('agent-1');

    expect(res.ok).toBe(true);
    expect(useStore.getState().projects[0].conversations).toHaveLength(0);
  });

  it('still deletes the row when git only warns', async () => {
    removeWorktreeResult.current = { ok: true, warning: 'branch was force-deleted' };
    seed([agent()]);

    const res = await useStore.getState().removeAgent('agent-1');

    expect(res.ok).toBe(true);
    expect(res.warning).toContain('force-deleted');
    expect(useStore.getState().projects[0].conversations).toHaveLength(0);
  });

  it('retrying an orphaned conversation removes it once git succeeds', async () => {
    removeWorktreeResult.current = { ok: false, error: 'locked' };
    seed([agent()]);
    await useStore.getState().removeAgent('agent-1');
    expect(useStore.getState().projects[0].conversations[0].orphaned).toBe(true);

    removeWorktreeResult.current = { ok: true };
    const res = await useStore.getState().removeAgent('agent-1');

    expect(res.ok).toBe(true);
    expect(useStore.getState().projects[0].conversations).toHaveLength(0);
  });

  it('leaves an adopted worktree alone and never calls git', async () => {
    seed([agent({ adoptedWorktree: true })]);

    const res = await useStore.getState().removeAgent('agent-1');

    expect(res.ok).toBe(true);
    expect(invoked.some((c) => c.channel === 'git:removeWorktree')).toBe(false);
    expect(useStore.getState().projects[0].conversations).toHaveLength(0);
  });
});
