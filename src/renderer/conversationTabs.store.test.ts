import { beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer store calls window.overcli.invoke for IPC, and only wires its
// subscriptions (tab persistence, pruning) when `window` exists at load.
// Imports are hoisted, so the stub has to be too.
const { mockInvoke } = vi.hoisted(() => {
  // History loads answer with an empty transcript; everything else with nothing.
  const mockInvoke = vi.fn((...args: unknown[]) =>
    Promise.resolve(String(args[0]).includes('istory') ? [] : undefined),
  );
  (globalThis as unknown as Record<string, unknown>).window = {
    overcli: { invoke: mockInvoke },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { mockInvoke };
});

import type { Conversation, Project } from '@shared/types';
import { useStore } from './store';
import { useFlowsStore } from './flowsStore';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return { id, name: id, createdAt: 1, ...extra } as Conversation;
}

function seed(ids: string[]): void {
  const project = { id: 'p', name: 'acme', path: '/acme/app', conversations: ids.map((id) => conv(id)) } as Project;
  useStore.setState({
    projects: [project],
    workspaces: [],
    selectedConversationId: null,
    conversationTabs: [],
    splitConversationId: null,
    poppedOutConversationIds: [],
    detailMode: 'conversation',
  });
  useFlowsStore.setState({ activeRunId: null, runs: {} });
}

beforeEach(() => {
  mockInvoke.mockClear();
  seed(['a', 'b', 'c', 'd']);
});

describe('conversation tabs in the store', () => {
  it('opens each selected conversation as a tab beside the current one', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    s.selectConversation('b');
    s.selectConversation('a');
    s.selectConversation('c');
    expect(useStore.getState().conversationTabs).toEqual(['a', 'c', 'b']);
  });

  it('closing the tab on screen selects its neighbour', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    s.selectConversation('b');
    s.selectConversation('c');
    useStore.getState().closeConversationTab('c');
    expect(useStore.getState()).toMatchObject({ conversationTabs: ['a', 'b'], selectedConversationId: 'b' });
  });

  it('cycles through tabs', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    s.selectConversation('b');
    useStore.getState().cycleConversationTab(1);
    expect(useStore.getState().selectedConversationId).toBe('a');
  });

  it('drops the tab and the side view of a removed conversation', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    s.openConversationToSide('b');
    expect(useStore.getState().splitConversationId).toBe('b');
    seed(['a', 'c', 'd']);
    useStore.setState({ selectedConversationId: 'a', conversationTabs: ['a', 'b'], splitConversationId: 'b' });
    useStore.setState((st) => ({ projects: st.projects.map((p) => ({ ...p })) }));
    expect(useStore.getState()).toMatchObject({ conversationTabs: ['a'], splitConversationId: null });
  });
});

describe('split view', () => {
  it('never shows the selected conversation beside itself', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    useStore.getState().openConversationToSide('a');
    expect(useStore.getState().splitConversationId).toBeNull();
  });

  it('selecting the conversation beside swaps the two sides', () => {
    const s = useStore.getState();
    s.selectConversation('a');
    useStore.getState().openConversationToSide('b');
    useStore.getState().selectConversation('b');
    expect(useStore.getState()).toMatchObject({ selectedConversationId: 'b', splitConversationId: 'a' });
  });

  it('swapSplit makes the side conversation the main one', () => {
    useStore.getState().selectConversation('a');
    useStore.getState().openConversationToSide('c');
    useStore.getState().swapSplit();
    expect(useStore.getState()).toMatchObject({ selectedConversationId: 'c', splitConversationId: 'a' });
  });
});

describe('changes from a conversation window', () => {
  it('applies a patch in the main window and saves it', () => {
    useStore.getState().ingestMainEvent({
      type: 'conversationChangesFromWindow',
      changes: [{ kind: 'patch', id: 'b', patch: { claudeModel: 'new' } as Partial<Conversation> }],
    });
    const b = useStore.getState().projects[0]!.conversations.find((c) => c.id === 'b');
    expect(b).toMatchObject({ claudeModel: 'new' });
  });

  it('tracks windows opening and closing', () => {
    useStore.getState().ingestMainEvent({ type: 'conversationPoppedOut', id: 'a', out: true });
    expect(useStore.getState().poppedOutConversationIds).toEqual(['a']);
    useStore.getState().ingestMainEvent({ type: 'conversationPoppedOut', id: 'a', out: false });
    expect(useStore.getState().poppedOutConversationIds).toEqual([]);
  });
});

describe('flow runs as tabs', () => {
  it('opening a run puts it in the strip beside the conversation you were on', () => {
    useStore.getState().selectConversation('a');
    useStore.getState().selectConversation('b');
    useStore.getState().selectConversation('a');
    useFlowsStore.getState().setActiveRun('r1');
    expect(useStore.getState().conversationTabs).toEqual(['a', 'run:r1', 'b']);
  });

  it("leaves a worker's run on its desk", () => {
    useFlowsStore.setState({ runs: { r2: { id: 'r2', workerId: 'w1' } as never } });
    useFlowsStore.getState().setActiveRun('r2');
    expect(useStore.getState().conversationTabs).toEqual([]);
  });

  it('clicking a run tab opens the run in Flows', () => {
    useStore.getState().selectConversation('a');
    useStore.getState().activateTab('run:r1');
    expect(useStore.getState().detailMode).toBe('flows');
    expect(useFlowsStore.getState().activeRunId).toBe('r1');
  });

  it('closing the run on screen hands over to its neighbour conversation', () => {
    useStore.getState().selectConversation('a');
    useStore.getState().activateTab('run:r1');
    useStore.getState().closeConversationTab('run:r1');
    expect(useStore.getState()).toMatchObject({ conversationTabs: ['a'], detailMode: 'conversation', selectedConversationId: 'a' });
  });

  it('cycles across conversations and runs', () => {
    useStore.getState().selectConversation('a');
    useStore.getState().activateTab('run:r1');
    useStore.getState().cycleConversationTab(-1);
    expect(useStore.getState()).toMatchObject({ detailMode: 'conversation', selectedConversationId: 'a' });
  });

  it('survives the conversation prune, and goes when the run is deleted', () => {
    useStore.getState().selectConversation('a');
    useFlowsStore.getState().setActiveRun('r1');
    useStore.setState((st) => ({ projects: st.projects.map((p) => ({ ...p })) }));
    expect(useStore.getState().conversationTabs).toContain('run:r1');
    useStore.getState().ingestMainEvent({ type: 'flowRunDeleted', runId: 'r1' });
    expect(useStore.getState().conversationTabs).toEqual(['a']);
  });
});

describe('close tabs to the right', () => {
  it('closes runs and conversations after the tab, and the side view with them', () => {
    useStore.setState({
      conversationTabs: ['a', 'b', 'run:r1', 'c', 'd'],
      selectedConversationId: 'd',
      splitConversationId: 'c',
    });
    useStore.getState().closeConversationTabsToRight('b');
    expect(useStore.getState()).toMatchObject({
      conversationTabs: ['a', 'b'],
      selectedConversationId: 'b',
      splitConversationId: null,
    });
  });
});
