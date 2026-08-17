import { beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer stores reach for window.overcli when an action runs. Stub it
// so driving them from the Node test env doesn't crash.
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: vi.fn(() => Promise.resolve(undefined)) },
};

import { fileScopeKeyFor } from './fileScope';
import { useStore } from './store';
import { useFlowsStore } from './flowsStore';
import { useWorkersStore } from './workersStore';

const base = {
  detailMode: 'conversation',
  selectedConversationId: null,
  explorerRootPath: null,
  activeRunId: null,
  selectedWorkerId: null,
};

describe('fileScopeKeyFor', () => {
  it('scopes to the selected conversation', () => {
    expect(fileScopeKeyFor({ ...base, selectedConversationId: 'c1' })).toBe('conv:c1');
  });

  it('scopes to the active flow run in the flows view', () => {
    expect(
      fileScopeKeyFor({ ...base, detailMode: 'flows', activeRunId: 'r1' }),
    ).toBe('flow:r1');
  });

  it('keeps flow runs off the conversation scope even with a conversation selected', () => {
    // The flows view routinely leaves a conversation selected under the
    // hood; its files must not land in that conversation's tab list.
    expect(
      fileScopeKeyFor({
        ...base,
        detailMode: 'flows',
        activeRunId: 'r1',
        selectedConversationId: 'c1',
      }),
    ).toBe('flow:r1');
  });

  it('scopes to the run when one is opened inside a worker', () => {
    expect(
      fileScopeKeyFor({
        ...base,
        detailMode: 'workers',
        activeRunId: 'r1',
        selectedWorkerId: 'w1',
        selectedConversationId: 'c1',
      }),
    ).toBe('flow:r1');
  });

  it('gives each worker its own desk scope', () => {
    // Switching workers must not carry the last one's report across: each
    // desk resolves its files against its own directory.
    const desk = { ...base, detailMode: 'workers', selectedConversationId: 'c1' };
    expect(fileScopeKeyFor({ ...desk, selectedWorkerId: 'w1' })).toBe('worker:w1');
    expect(fileScopeKeyFor({ ...desk, selectedWorkerId: 'w2' })).toBe('worker:w2');
  });

  it('falls back to the conversation with no worker picked', () => {
    // Matches the editor's root, which falls back the same way when there
    // is no worker directory to resolve against.
    expect(
      fileScopeKeyFor({ ...base, detailMode: 'workers', selectedConversationId: 'c1' }),
    ).toBe('conv:c1');
  });

  it('gives the explorer its own scope, even inside a conversation', () => {
    // ExplorerPane replaces the editor pane wholesale in both mount sites,
    // so its tabs are what the user sees.
    expect(
      fileScopeKeyFor({ ...base, selectedConversationId: 'c1', explorerRootPath: '/repo' }),
    ).toBe('explorer:/repo');
  });

  it('has no scope on the welcome pane or a run-less flows view', () => {
    expect(fileScopeKeyFor(base)).toBeNull();
    expect(fileScopeKeyFor({ ...base, detailMode: 'flows' })).toBeNull();
  });
});

// The seam the desk bug actually lived in. `fileScopeKeyFor` was correct
// for conversations and runs the whole time; what was missing was anything
// downstream of picking a worker. These drive the real stores, because the
// facts under test belong to `selectWorker` — that it moves the selection,
// and that it drops the active run so the desk key wins over the run key.
describe('picking a worker, through the real stores', () => {
  /// Mirrors the selectors in `useFileScope`. The hook itself needs React
  /// to observe, so this is as close as a store-level test gets.
  function currentKey(): string | null {
    const ui = useStore.getState();
    return fileScopeKeyFor({
      detailMode: ui.detailMode,
      selectedConversationId: ui.selectedConversationId,
      explorerRootPath: ui.explorerRootPath,
      activeRunId: useFlowsStore.getState().activeRunId ?? null,
      selectedWorkerId: useWorkersStore.getState().selectedWorkerId,
    });
  }

  beforeEach(() => {
    useStore.setState({
      detailMode: 'workers',
      selectedConversationId: 'c1',
      explorerRootPath: null,
    });
    useFlowsStore.setState({ activeRunId: null });
    useWorkersStore.setState({ selectedWorkerId: null });
  });

  it('moves the editor off the last worker', () => {
    useWorkersStore.getState().selectWorker('w1');
    expect(currentKey()).toBe('worker:w1');
    useWorkersStore.getState().selectWorker('w2');
    expect(currentKey()).toBe('worker:w2');
  });

  it('leaves the run pane on the run key while it is open', () => {
    useWorkersStore.getState().selectWorker('w1');
    useFlowsStore.setState({ activeRunId: 'r1' });
    expect(currentKey()).toBe('flow:r1');
  });

  it('returns to the desk when picking a worker closes a run', () => {
    // selectWorker clears the active run — the desk replaces the run pane,
    // so the key has to follow it back or the run's files stay on screen.
    useWorkersStore.getState().selectWorker('w1');
    useFlowsStore.setState({ activeRunId: 'r1' });
    useWorkersStore.getState().selectWorker('w2');
    expect(currentKey()).toBe('worker:w2');
  });
});
