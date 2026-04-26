import { afterEach, describe, expect, it } from 'vitest';
import {
  getAllRunners,
  getRunner,
  newRunnerState,
  useRunnersStore,
} from './runnersStore';
import type { StreamEvent } from '@shared/types';

afterEach(() => {
  // Reset store between tests so module-level state doesn't bleed.
  useRunnersStore.setState({ runners: {} });
});

function evt(id: string): StreamEvent {
  return {
    id,
    timestamp: 0,
    raw: '',
    revision: 0,
    kind: { type: 'systemNotice', text: id },
  };
}

describe('newRunnerState', () => {
  it('returns a defaulted runner', () => {
    const r = newRunnerState();
    expect(r.events).toEqual([]);
    expect(r.isRunning).toBe(false);
    expect(r.currentModel).toBe('');
    expect(r.historyLoaded).toBe(false);
    expect(r.historyLoading).toBe(false);
    expect(r.pendingLocalUserIds).toBeInstanceOf(Set);
  });
});

describe('useRunnersStore.patchRunner', () => {
  it('auto-creates a runner when patching an unknown id', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true });
    expect(getRunner('c1')?.isRunning).toBe(true);
    // Unset fields default through newRunnerState.
    expect(getRunner('c1')?.currentModel).toBe('');
  });

  it('merges a partial patch over an existing runner', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true, currentModel: 'm1' });
    useRunnersStore.getState().patchRunner('c1', { activityLabel: 'Writing…' });
    const r = getRunner('c1')!;
    expect(r.isRunning).toBe(true);
    expect(r.currentModel).toBe('m1');
    expect(r.activityLabel).toBe('Writing…');
  });

  it('functional patch sees the previous state', () => {
    useRunnersStore.getState().patchRunner('c1', { events: [evt('a')] });
    useRunnersStore.getState().patchRunner('c1', (prev) => ({
      events: [...prev.events, evt('b')],
    }));
    expect(getRunner('c1')?.events.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('useRunnersStore.resetRunner', () => {
  it('replaces an existing runner with a fresh one', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true, currentModel: 'm1' });
    useRunnersStore.getState().resetRunner('c1');
    expect(getRunner('c1')?.isRunning).toBe(false);
    expect(getRunner('c1')?.currentModel).toBe('');
  });
});

describe('useRunnersStore.removeRunner', () => {
  it('drops the runner entirely', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true });
    expect(getRunner('c1')).toBeDefined();
    useRunnersStore.getState().removeRunner('c1');
    expect(getRunner('c1')).toBeUndefined();
  });

  it('leaves siblings untouched', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true });
    useRunnersStore.getState().patchRunner('c2', { isRunning: false });
    useRunnersStore.getState().removeRunner('c1');
    expect(getAllRunners()).toEqual({ c2: expect.objectContaining({ isRunning: false }) });
  });
});

describe('store independence', () => {
  it('patches return a new map reference (drives selector subscriptions)', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true });
    const refA = useRunnersStore.getState().runners;
    useRunnersStore.getState().patchRunner('c1', { activityLabel: 'x' });
    const refB = useRunnersStore.getState().runners;
    expect(refA).not.toBe(refB);
  });

  it('untouched runners keep their object identity across a patch', () => {
    useRunnersStore.getState().patchRunner('c1', { isRunning: true });
    useRunnersStore.getState().patchRunner('c2', { isRunning: false });
    const c2Before = getRunner('c2');
    useRunnersStore.getState().patchRunner('c1', { activityLabel: 'x' });
    expect(getRunner('c2')).toBe(c2Before);
  });
});
