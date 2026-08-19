import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer stores call window.overcli.invoke for IPC. Stub the global
// before importing so the module load doesn't crash in the Node test env.
const mockInvoke = vi.fn(() => Promise.resolve(undefined));
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: mockInvoke },
};

import { useStore } from './store';
import { useFlowsStore } from './flowsStore';
import { useWorkersStore } from './workersStore';
import {
  installNavHistory,
  locationKey,
  navigateToTab,
  readLocation,
  useNavHistory,
  type NavLocation,
} from './navHistory';

/// Enough of a run for the conversation index to walk it; nav only cares
/// that the id resolves.
function makeRun(): unknown {
  return { id: 'run-9', conversationIds: {}, attempts: [], flowSnapshot: { steps: [] } };
}

function baseLocation(overrides: Partial<NavLocation> = {}): NavLocation {
  return {
    detailMode: 'conversation',
    selectedConversationId: null,
    focusedProjectId: null,
    focusedWorkspaceId: null,
    explorerRootPath: null,
    activeRunId: null,
    librarySegment: 'flows',
    activeOrchestrationId: null,
    selectedWorkerId: null,
    workersView: 'worker',
    ...overrides,
  };
}

describe('locationKey', () => {
  it('treats the library segment as significant only inside Flows', () => {
    const a = baseLocation({ detailMode: 'flows', librarySegment: 'flows' });
    const b = baseLocation({ detailMode: 'flows', librarySegment: 'schedules' });
    expect(locationKey(a)).not.toBe(locationKey(b));

    const c = baseLocation({ detailMode: 'workers', librarySegment: 'flows' });
    const d = baseLocation({ detailMode: 'workers', librarySegment: 'schedules' });
    expect(locationKey(c)).toBe(locationKey(d));
  });

  it('treats the workers view as significant only inside Workers', () => {
    const a = baseLocation({ detailMode: 'workers', workersView: 'worker' });
    const b = baseLocation({ detailMode: 'workers', workersView: 'calendar' });
    expect(locationKey(a)).not.toBe(locationKey(b));

    const c = baseLocation({ detailMode: 'flows', workersView: 'worker' });
    const d = baseLocation({ detailMode: 'flows', workersView: 'calendar' });
    expect(locationKey(c)).toBe(locationKey(d));
  });

  it('separates two conversations in the same view', () => {
    expect(locationKey(baseLocation({ selectedConversationId: 'a' }))).not.toBe(
      locationKey(baseLocation({ selectedConversationId: 'b' })),
    );
  });
});

describe('nav history', () => {
  let uninstall: (() => void) | undefined;

  /// Let the view come to rest, which is when a visit gets recorded.
  function settle(): void {
    vi.advanceTimersByTime(300);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockInvoke.mockClear();
    useStore.setState({
      detailMode: 'conversation',
      selectedConversationId: null,
      focusedProjectId: null,
      focusedWorkspaceId: null,
      explorerRootPath: null,
    });
    useFlowsStore.setState({ activeRunId: null, librarySegment: 'flows', runs: {} });
    useWorkersStore.setState({ selectedWorkerId: null, view: 'worker' });
    uninstall?.();
    uninstall = installNavHistory();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.useRealTimers();
  });

  it('records a visit per view change and walks back through them', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('workers');
    settle();
    expect(useNavHistory.getState().back).toHaveLength(2);

    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('flows');
    settle();
    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('conversation');
    expect(useNavHistory.getState().back).toHaveLength(0);
  });

  it('goes forward again to where it just was', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    useNavHistory.getState().goBack();
    settle();
    expect(useNavHistory.getState().forward).toHaveLength(1);

    useNavHistory.getState().goForward();
    expect(useStore.getState().detailMode).toBe('flows');
    expect(useNavHistory.getState().forward).toHaveLength(0);
  });

  // The bug that made the title-bar arrows look broken: one click on the
  // Flows tab is four store writes, and each intermediate state used to
  // become its own entry — so Back landed on a state indistinguishable from
  // the page you were already on.
  it('counts one multi-store click as a single visit', () => {
    useStore.getState().setDetailMode('workers');
    settle();

    // Exactly what TitleBar's Flows button does.
    useFlowsStore.getState().setActiveRun(null);
    useFlowsStore.getState().closeEditor();
    useFlowsStore.getState().setLibrarySegment('schedules');
    useStore.getState().setDetailMode('flows');
    settle();

    expect(useNavHistory.getState().back).toHaveLength(2);
    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('workers');
  });

  // The other half: WorkersPane fills in the first worker when none is
  // selected, from a mount effect that lands after the commit. Arriving
  // there via Back must not count that correction as a new navigation.
  it('does not let a pane filling in its own default clear the forward stack', () => {
    useWorkersStore.setState({ workers: {}, selectedWorkerId: null });
    useStore.getState().setDetailMode('workers');
    // The pane's auto-select, one commit later.
    useWorkersStore.getState().selectWorker('worker-1');
    settle();
    expect(useNavHistory.getState().back).toHaveLength(1);

    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('conversation');
    // Pane remounts on the way back in and re-applies its default.
    useWorkersStore.getState().selectWorker('worker-1');
    settle();

    expect(useNavHistory.getState().forward).toHaveLength(1);
    useNavHistory.getState().goForward();
    expect(useStore.getState().detailMode).toBe('workers');
  });

  it('does not push a history entry for a no-op re-selection', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('flows');
    settle();
    expect(useNavHistory.getState().back).toHaveLength(1);
  });

  it('drops a view the user only passed through', () => {
    useStore.getState().setDetailMode('flows');
    useStore.getState().setDetailMode('conversation');
    settle();
    expect(useNavHistory.getState().back).toHaveLength(0);
  });

  it('ignores store churn that does not move the user', () => {
    useStore.setState({ welcomeFocusToken: 7 });
    useStore.setState({ ollamaServerStatus: 'running' });
    settle();
    expect(useNavHistory.getState().back).toHaveLength(0);
  });

  // A streaming turn writes to the store every frame for minutes. A debounce
  // keyed on writes rather than on the location would be reset forever and
  // never record anything.
  it('still records a visit while a conversation is streaming', () => {
    useStore.getState().setDetailMode('flows');
    for (let i = 0; i < 40; i++) {
      useStore.setState({ welcomeFocusToken: i });
      vi.advanceTimersByTime(16);
    }
    expect(useNavHistory.getState().back).toHaveLength(1);
  });

  it('banks a pending visit when Back is pressed before it settles', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('workers'); // not settled yet
    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('flows');
  });

  it('truncates the forward stack once the user navigates somewhere new', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('workers');
    settle();
    useNavHistory.getState().goBack();
    settle();
    useNavHistory.getState().goBack();
    settle();
    expect(useNavHistory.getState().forward).toHaveLength(2);

    useStore.getState().setDetailMode('stats');
    settle();
    expect(useNavHistory.getState().forward).toHaveLength(0);
    expect(useNavHistory.getState().back).toHaveLength(1);
  });

  it('restores selection across stores, not just the tab', () => {
    useStore.setState({ selectedConversationId: 'conv-1' });
    settle();
    useStore.getState().setDetailMode('flows');
    settle();
    useFlowsStore.getState().setActiveRun('run-9');
    settle();

    useNavHistory.getState().goBack();
    settle();
    expect(useFlowsStore.getState().activeRunId).toBeNull();

    useNavHistory.getState().goBack();
    settle();
    expect(readLocation()).toMatchObject({
      detailMode: 'conversation',
      selectedConversationId: 'conv-1',
      activeRunId: null,
    });
  });

  // Leaving a flow run to check Workers and coming back must return you to
  // the run, not to the Flows library. The run is a Flows location (the
  // sidebar row sets detailMode 'flows'), so Flows is the tab that owns it.
  it('returns a tab to the last place you were inside it', () => {
    useFlowsStore.setState({ runs: { 'run-9': makeRun() } as never });
    useStore.setState({
      projects: [
        { id: 'p1', conversations: [{ id: 'conv-1' }] },
      ] as never,
      workspaces: [],
      colosseums: [],
      selectedConversationId: 'conv-1',
    });
    settle();

    // Open a flow run from the sidebar.
    useFlowsStore.getState().setActiveRun('run-9');
    useStore.getState().setDetailMode('flows');
    settle();

    navigateToTab('workers', () => useStore.getState().setDetailMode('workers'));
    settle();
    expect(useStore.getState().detailMode).toBe('workers');

    navigateToTab('flows', () => {
      useFlowsStore.getState().setActiveRun(null);
      useStore.getState().setDetailMode('flows');
    });
    settle();
    expect(useStore.getState().detailMode).toBe('flows');
    expect(useFlowsStore.getState().activeRunId).toBe('run-9');

    // And Chat still comes back to the conversation, not the run.
    navigateToTab('conversation', () => useStore.getState().setDetailMode('conversation'));
    settle();
    expect(readLocation()).toMatchObject({
      detailMode: 'conversation',
      selectedConversationId: 'conv-1',
    });
  });

  // The complaint this rule answers: sitting on a flow run, pressing Flows,
  // and nothing happening — because "the last place in Flows" was the run
  // already on screen.
  it('takes you to the tab root when you click the tab you are already on', () => {
    useFlowsStore.setState({ runs: { 'run-9': makeRun() } as never });
    useFlowsStore.getState().setActiveRun('run-9');
    useStore.getState().setDetailMode('flows');
    settle();

    const root = vi.fn(() => {
      useFlowsStore.getState().setActiveRun(null);
      useStore.getState().setDetailMode('flows');
    });
    navigateToTab('flows', root);
    settle();
    expect(root).toHaveBeenCalledOnce();
    expect(useFlowsStore.getState().activeRunId).toBeNull();

    // And it was a real navigation, so Back returns to the run.
    useNavHistory.getState().goBack();
    expect(useFlowsStore.getState().activeRunId).toBe('run-9');
  });

  it('restores the workers view a location was recorded in', () => {
    useStore.getState().setDetailMode('workers');
    useWorkersStore.getState().showCalendar();
    settle();
    useWorkersStore.getState().showFunds();
    settle();
    expect(useWorkersStore.getState().view).toBe('funds');

    useNavHistory.getState().goBack();
    expect(useWorkersStore.getState().view).toBe('calendar');
  });

  it('runs the tab default on the first visit of the session', () => {
    const fallback = vi.fn(() => useStore.getState().setDetailMode('flows'));
    navigateToTab('flows', fallback);
    expect(fallback).toHaveBeenCalledOnce();
  });

  // The reason the Flows tab resets to the library in the first place: not
  // being dropped onto a run that has since gone away.
  it('falls back when the remembered run no longer exists', () => {
    useFlowsStore.setState({ runs: { 'run-9': makeRun() } as never });
    useFlowsStore.getState().setActiveRun('run-9');
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('workers');
    settle();

    useFlowsStore.setState({ runs: {} }); // run deleted while we were away
    const fallback = vi.fn(() => useStore.getState().setDetailMode('flows'));
    navigateToTab('flows', fallback);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('stacks a tab restore so Back still undoes it', () => {
    useFlowsStore.setState({ runs: { 'run-9': makeRun() } as never });
    useFlowsStore.getState().setActiveRun('run-9');
    useStore.getState().setDetailMode('flows');
    settle();
    useStore.getState().setDetailMode('workers');
    settle();

    navigateToTab('flows', () => useStore.getState().setDetailMode('flows'));
    settle();
    expect(useFlowsStore.getState().activeRunId).toBe('run-9');

    useNavHistory.getState().goBack();
    expect(useStore.getState().detailMode).toBe('workers');
  });

  it('does not record the moves it makes itself', () => {
    useStore.getState().setDetailMode('flows');
    settle();
    const depth = useNavHistory.getState().back.length;
    useNavHistory.getState().goBack();
    settle();
    expect(useNavHistory.getState().back).toHaveLength(depth - 1);
    expect(useNavHistory.getState().forward).toHaveLength(1);
  });
});
