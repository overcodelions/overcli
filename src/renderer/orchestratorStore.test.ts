import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The renderer store calls window.overcli.invoke for IPC. Stub the global
// before importing so the module load doesn't crash in the Node test env.
const mockInvoke = vi.fn();
(globalThis as unknown as Record<string, unknown>).window = {
  overcli: { invoke: mockInvoke },
};

import { useOrchestratorStore } from './orchestratorStore';

/// Flush the fire-and-forget recordRecentPrompt promise chain (it runs after
/// propose resolves, off the awaited path).
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockInvoke.mockReset();
  mockInvoke.mockImplementation((channel: string, args: { text?: string }) => {
    switch (channel) {
      case 'orchestrator:propose':
        return Promise.resolve({ ok: true, reply: 'summary + candidates', candidates: [] });
      case 'orchestrator:recordRecentPrompt':
        return Promise.resolve([{ text: args.text, lastUsedAt: 1 }]);
      case 'orchestrator:deleteRecentPrompt':
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  });
  useOrchestratorStore.setState({
    projectPath: '/tmp/project',
    turns: [],
    candidates: [],
    itemConfig: {},
    proposing: false,
    producerError: null,
    recentPrompts: [],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('orchestratorStore — recent prompts', () => {
  it('records a fresh ask and stores the returned list', async () => {
    await useOrchestratorStore.getState().propose('find the small docs fixes');
    await flush();
    expect(mockInvoke).toHaveBeenCalledWith('orchestrator:recordRecentPrompt', {
      text: 'find the small docs fixes',
    });
    expect(useOrchestratorStore.getState().recentPrompts).toEqual([
      { text: 'find the small docs fixes', lastUsedAt: 1 },
    ]);
  });

  it('does NOT record a refinement (a turn that builds on a prior ask)', async () => {
    await useOrchestratorStore.getState().propose('find the small docs fixes'); // seed
    await flush();
    mockInvoke.mockClear();

    await useOrchestratorStore.getState().propose('only the docs ones'); // refinement
    await flush();

    const channels = mockInvoke.mock.calls.map((c) => c[0]);
    expect(channels).toContain('orchestrator:propose');
    expect(channels).not.toContain('orchestrator:recordRecentPrompt');
  });

  it('does not record when the producer turn fails', async () => {
    mockInvoke.mockImplementation((channel: string) =>
      channel === 'orchestrator:propose'
        ? Promise.resolve({ ok: false, error: 'no backend' })
        : Promise.resolve(undefined),
    );
    await useOrchestratorStore.getState().propose('an ask that errors');
    await flush();
    const channels = mockInvoke.mock.calls.map((c) => c[0]);
    expect(channels).not.toContain('orchestrator:recordRecentPrompt');
  });

  it('removeRecentPrompt deletes by text and stores the updated list', async () => {
    useOrchestratorStore.setState({ recentPrompts: [{ text: 'drop me', lastUsedAt: 1 }] });
    await useOrchestratorStore.getState().removeRecentPrompt('drop me');
    expect(mockInvoke).toHaveBeenCalledWith('orchestrator:deleteRecentPrompt', { text: 'drop me' });
    expect(useOrchestratorStore.getState().recentPrompts).toEqual([]);
  });
});
