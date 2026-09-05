// The start page has no conversation to warm while you type, so it registers
// the one it is ABOUT to create (`setPendingNewConversation`), `setDraft`
// warms a process against that id, and `newConversation` is then born with
// it. These tests pin the seam: the id has to survive from the keystroke that
// warmed it to the conversation that uses it, and an id that was never warmed
// must not be adopted — it would buy nothing and mask a broken warm.
//
// The second half guards the other half of the same path: nothing slow is
// allowed to sit between the user hitting enter and the conversation opening.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Workspace } from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

const invoked: Array<{ channel: string; args: unknown }> = [];
const currentBranchResult = { current: { isRepo: true, branch: 'master' } };

function stubBridge(): void {
  const invoke = vi.fn(async (channel: string, args: unknown) => {
    invoked.push({ channel, args });
    if (channel === 'git:commitStatus') return { isRepo: true, currentBranch: 'main' };
    if (channel === 'git:currentBranch') return currentBranchResult.current;
    // `newConversation` selects what it created, and selection loads history.
    if (channel === 'runner:loadHistory') return [];
    return undefined;
  });
  (globalThis as unknown as { window: unknown }).window = {
    overcli: { invoke, onMainEvent: () => () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

stubBridge();

const { useStore, setPendingNewConversation } = await import('./store');

const WELCOME_KEY = '__welcome__';
/// `setDraft` only warms past this many characters, so every test types more.
const TYPED = 'refactor the parser';

function prewarms(): Array<Record<string, unknown>> {
  return invoked
    .filter((i) => i.channel === 'runner:prewarm')
    .map((i) => i.args as Record<string, unknown>);
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'proj',
    path: '/Users/x/git/proj',
    conversations: [],
    ...over,
  } as Project;
}

function target(over: Record<string, unknown> = {}) {
  return {
    draftKey: WELCOME_KEY,
    projectId: 'proj-1',
    backend: 'claude' as const,
    model: 'claude-opus-5',
    permissionMode: 'default' as const,
    effortLevel: 'medium' as const,
    ...over,
  };
}

function channels(): string[] {
  return invoked.map((i) => i.channel);
}

/// `captureBaseBranch` is fired but not awaited, so let its microtasks run.
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  invoked.length = 0;
  currentBranchResult.current = { isRepo: true, branch: 'master' };
  setPendingNewConversation(null);
  useStore.setState({
    projects: [project()],
    workspaces: [],
    conversationDrafts: {},
    settings: { ...DEFAULT_SETTINGS },
    backendHealth: {},
  } as never);
});

describe('start-page prewarm', () => {
  it('warms the project cwd while the user types, before any conversation exists', () => {
    setPendingNewConversation(target());
    useStore.getState().setDraft(WELCOME_KEY, TYPED);

    expect(prewarms()).toHaveLength(1);
    expect(prewarms()[0]).toMatchObject({
      backend: 'claude',
      cwd: '/Users/x/git/proj',
      model: 'claude-opus-5',
      permissionMode: 'default',
      effortLevel: 'medium',
    });
    // Nothing is in `projects` yet — the id is minted ahead of the row.
    expect(useStore.getState().projects[0].conversations).toHaveLength(0);
  });

  it('creates the conversation with the id it warmed', async () => {
    setPendingNewConversation(target());
    useStore.getState().setDraft(WELCOME_KEY, TYPED);
    const warmedId = prewarms()[0].conversationId;

    const conv = await useStore.getState().newConversation('proj-1');

    expect(conv.id).toBe(warmedId);
  });

  it('does not adopt an id that was never warmed', async () => {
    // Registered, but the user hit "+" without typing — no process exists
    // behind the pending id, so it must not be spent.
    setPendingNewConversation(target());

    const conv = await useStore.getState().newConversation('proj-1');

    expect(prewarms()).toHaveLength(0);
    expect(conv.id).toBeTruthy();
  });

  it('spends a warmed id only once', async () => {
    setPendingNewConversation(target());
    useStore.getState().setDraft(WELCOME_KEY, TYPED);
    const warmedId = prewarms()[0].conversationId;

    const first = await useStore.getState().newConversation('proj-1');
    const second = await useStore.getState().newConversation('proj-1');

    expect(first.id).toBe(warmedId);
    expect(second.id).not.toBe(warmedId);
  });

  it('does not hand a project-warmed id to a different container', async () => {
    setPendingNewConversation(target());
    useStore.getState().setDraft(WELCOME_KEY, TYPED);
    const warmedId = prewarms()[0].conversationId;
    useStore.setState({
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws',
          projectIds: [],
          rootPath: '/root',
          conversations: [],
          createdAt: 0,
        } as Workspace,
      ],
    } as never);

    const conv = await useStore.getState().newConversationInWorkspace('ws-1');

    expect(conv?.id).not.toBe(warmedId);
  });

  it('keeps the warm across pill edits but re-mints when the container moves', () => {
    setPendingNewConversation(target());
    useStore.getState().setDraft(WELCOME_KEY, TYPED);
    const first = prewarms()[0].conversationId;

    // A model change is argv the runner can respawn for — the id, and the
    // process behind it, stay.
    setPendingNewConversation(target({ model: 'claude-sonnet-5' }));
    useStore.getState().setDraft(WELCOME_KEY, `${TYPED} again`);
    expect(prewarms()).toHaveLength(1);

    // A different project means a different cwd, so the warm is void.
    useStore.setState({
      projects: [project(), project({ id: 'proj-2', path: '/Users/x/git/other' })],
    } as never);
    setPendingNewConversation(target({ projectId: 'proj-2' }));
    useStore.getState().setDraft(WELCOME_KEY, `${TYPED} elsewhere`);

    expect(prewarms()).toHaveLength(2);
    expect(prewarms()[1].conversationId).not.toBe(first);
    expect(prewarms()[1].cwd).toBe('/Users/x/git/other');
  });

  it('passes workspace member repos as allowedDirs so the send reuses the warm', () => {
    // `allowedDirs` shapes `--add-dir` but is not part of LaunchParams, so a
    // warm spawned without the members would be reused rather than respawned.
    useStore.setState({
      projects: [project(), project({ id: 'proj-2', path: '/Users/x/git/other' })],
      workspaces: [
        {
          id: 'ws-1',
          name: 'ws',
          projectIds: ['proj-1', 'proj-2'],
          rootPath: '/root/ws',
          conversations: [],
          createdAt: 0,
        } as Workspace,
      ],
    } as never);
    setPendingNewConversation(target({ projectId: undefined, workspaceId: 'ws-1' }));

    useStore.getState().setDraft(WELCOME_KEY, TYPED);

    expect(prewarms()[0]).toMatchObject({
      cwd: '/root/ws',
      allowedDirs: ['/root/ws', '/Users/x/git/proj', '/Users/x/git/other'],
    });
  });

  it('ignores drafts from other sentinel composers', () => {
    setPendingNewConversation(target());

    useStore.getState().setDraft('__flow-launch__', TYPED);

    expect(prewarms()).toHaveLength(0);
  });

  it('skips backends that cannot keep a resident process', () => {
    setPendingNewConversation(target({ backend: 'gemini' }));

    useStore.getState().setDraft(WELCOME_KEY, TYPED);

    expect(prewarms()).toHaveLength(0);
  });
});

describe('newConversation branch capture', () => {
  it('does not run the expensive status probe on the creation path', async () => {
    // `git:commitStatus` is four git subprocesses plus a line-count read of
    // every untracked file. It used to be awaited here for the one string it
    // returned, and on a cold repo that was the whole delay before the
    // conversation pane appeared.
    await useStore.getState().newConversation('proj-1');

    expect(channels()).not.toContain('git:commitStatus');
  });

  it('stamps baseBranch after the conversation is already open', async () => {
    const conv = await useStore.getState().newConversation('proj-1');

    // Open first, with no branch yet...
    expect(conv.baseBranch).toBeUndefined();
    expect(useStore.getState().selectedConversationId).toBe(conv.id);
    await settle();

    // ...and the branch lands a moment later.
    const stored = useStore
      .getState()
      .projects[0].conversations.find((c) => c.id === conv.id);
    expect(stored?.baseBranch).toBe('master');
  });

  it('leaves a conversation that already knows its base branch alone', async () => {
    const conv = await useStore.getState().newConversation('proj-1');
    await settle();
    currentBranchResult.current = { isRepo: true, branch: 'some-other-branch' };

    await useStore.getState().captureBaseBranch(conv.id, '/Users/x/git/proj');

    const stored = useStore
      .getState()
      .projects[0].conversations.find((c) => c.id === conv.id);
    expect(stored?.baseBranch).toBe('master');
  });

  it('leaves baseBranch unset for a non-git project', async () => {
    currentBranchResult.current = { isRepo: false, branch: '' };

    const conv = await useStore.getState().newConversation('proj-1');
    await settle();

    const stored = useStore
      .getState()
      .projects[0].conversations.find((c) => c.id === conv.id);
    expect(stored?.baseBranch).toBeUndefined();
  });
});
