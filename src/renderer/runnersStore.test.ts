import { afterEach, describe, expect, it } from 'vitest';
import {
  getAllRunners,
  getRunner,
  completedAtOf,
  foldContextUsage,
  newRunnerState,
  runningLabelsOf,
  staleRunningIds,
  useRunnersStore,
} from './runnersStore';
import type { ModelUsage, StreamEvent } from '@shared/types';

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

describe('staleRunningIds', () => {
  // Regression: a flow run finished cleanly but its sidebar row kept
  // spinning for the rest of the session. `runIsLive` ORs the run's
  // participant conversations into the run's liveness, and one of them
  // still had `isRunning: true` from a `running: false` that never
  // arrived. Nothing reconciled that flag, so only a reload cleared it.
  const old = { runningSince: 1_000 };

  it('retracts a flag main no longer stands behind', () => {
    const runners = { a: { isRunning: true, ...old } };
    expect(staleRunningIds(runners, [], 100_000)).toEqual(['a']);
  });

  it('leaves conversations main still reports as running', () => {
    const runners = { a: { isRunning: true, ...old }, b: { isRunning: true, ...old } };
    expect(staleRunningIds(runners, ['a'], 100_000)).toEqual(['b']);
  });

  it('ignores runners that are already idle', () => {
    const runners = { a: { isRunning: false, ...old } };
    expect(staleRunningIds(runners, [], 100_000)).toEqual([]);
  });

  it('spares a turn that just started — main may not have registered it yet', () => {
    // The renderer flips the flag optimistically on send; the snapshot it
    // races against can be a moment older than that.
    const runners = { a: { isRunning: true, runningSince: 99_000 } };
    expect(staleRunningIds(runners, [], 100_000, 15_000)).toEqual([]);
    expect(staleRunningIds(runners, [], 120_000, 15_000)).toEqual(['a']);
  });

  it('retracts a flag with no start stamp (set before this bookkeeping existed)', () => {
    expect(staleRunningIds({ a: { isRunning: true } }, [], 100_000)).toEqual(['a']);
  });

  it('accepts a Set of live ids as well as an array', () => {
    const runners = { a: { isRunning: true, ...old } };
    expect(staleRunningIds(runners, new Set(['a']), 100_000)).toEqual([]);
  });
});

// The sidebar and other always-mounted chrome used to subscribe to the whole
// runners map, whose identity changes on every ingested event — so they
// re-rendered at the full streaming rate (~60Hz for the entire duration of
// every turn), each time re-running unmemoized filters over every
// conversation in the app. That was a primary cause of the UI freezing with
// a long conversation and several agents running.
//
// `useRunningMap` fixes it by projecting only the fields that chrome reads,
// as scalars, so `useShallow` can compare them by value. These tests pin the
// property that makes it work: the projection must NOT change identity-wise
// when only events move.
describe('running projections', () => {
  const base = () => ({
    ...newRunnerState(),
    isRunning: true,
    activityLabel: 'Thinking…',
    events: [] as StreamEvent[],
  });

  const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
  };

  it('is unchanged when only events move — the streaming hot path', () => {
    const streamed = { ...base(), events: [{ id: 'e1' } as unknown as StreamEvent] };
    const before = runningLabelsOf({ a: base() });
    const after = runningLabelsOf({ a: streamed });
    expect(shallowEqual(before, after)).toBe(true);
  });

  it('changes when a conversation starts or stops running', () => {
    const idle = runningLabelsOf({ a: { ...base(), isRunning: false } });
    const busy = runningLabelsOf({ a: base() });
    expect(shallowEqual(idle, busy)).toBe(false);
    expect(Object.keys(idle)).toEqual([]);
    expect(Object.keys(busy)).toEqual(['a']);
  });

  it('changes when the activity label changes', () => {
    const before = runningLabelsOf({ a: base() });
    const after = runningLabelsOf({ a: { ...base(), activityLabel: 'Editing…' } });
    expect(shallowEqual(before, after)).toBe(false);
  });

  it('omits idle conversations entirely, so `runners[id]?.isRunning` stays falsy', () => {
    expect(runningLabelsOf({ a: { ...base(), isRunning: false } })).toEqual({});
  });

  it('tracks completedAt separately, and only for conversations that have one', () => {
    expect(completedAtOf({ a: { completedAt: null }, b: { completedAt: 42 } })).toEqual({ b: 42 });
  });

  it('keeps completedAt stable across event-only churn', () => {
    const before = completedAtOf({ a: { completedAt: 42 } });
    const after = completedAtOf({ a: { completedAt: 42 } });
    expect(shallowEqual(before, after)).toBe(true);
  });
});

describe('foldContextUsage', () => {
  function resultEvent(
    modelUsage: Record<string, Partial<ModelUsage>>,
  ): StreamEvent {
    return {
      id: 'r',
      timestamp: 0,
      raw: '',
      revision: 0,
      kind: {
        type: 'result',
        info: {
          subtype: 'success',
          isError: false,
          durationMs: 0,
          totalCostUSD: 0,
          modelUsage: modelUsage as Record<string, ModelUsage>,
        },
      },
    };
  }

  function assistantEvent(usage?: Partial<ModelUsage>): StreamEvent {
    return {
      id: 'a',
      timestamp: 0,
      raw: '',
      revision: 0,
      kind: {
        type: 'assistant',
        info: {
          model: 'claude-opus-5',
          text: 'hi',
          toolUses: [],
          thinking: [],
          ...(usage ? { usage: usage as ModelUsage } : {}),
        },
      },
    };
  }

  it('counts one request, not the whole turn — the 832% bug', () => {
    // A 38-tool-call turn re-reads the same ~200k cached prefix on every
    // request, so the result line totals ~7.9M cache_read. That is a real
    // billing number and a nonsense occupancy number; only the per-request
    // assistant usage may set tokens.
    const out = foldContextUsage(
      {},
      [
        assistantEvent({
          inputTokens: 110,
          outputTokens: 43_615,
          cacheReadInputTokens: 205_370,
          cacheCreationInputTokens: 3626,
        }),
        resultEvent({
          'claude-opus-5[1m]': {
            inputTokens: 110,
            outputTokens: 43_615,
            cacheReadInputTokens: 7_902_003,
            cacheCreationInputTokens: 400_000,
            contextWindow: 1_000_000,
          },
        }),
      ],
      'claude-opus-5',
    );
    // input + cache_read + cache_creation of the last REQUEST; output excluded.
    expect(out).toEqual({ tokens: 209_106, window: 1_000_000 });
    expect(out.tokens!).toBeLessThan(out.window!);
  });

  it('takes the window from the conversation model, not a subagent that ran in the same turn', () => {
    const out = foldContextUsage(
      {},
      [
        assistantEvent({ inputTokens: 400 }),
        resultEvent({
          'claude-haiku-4-5': { inputTokens: 900_000, contextWindow: 200_000 },
          'claude-opus-5[1m]': { inputTokens: 400, contextWindow: 1_000_000 },
        }),
      ],
      'claude-opus-5',
    );
    expect(out).toEqual({ tokens: 400, window: 1_000_000 });
  });

  it('falls back to the widest window when no key matches the model', () => {
    const out = foldContextUsage(
      {},
      [resultEvent({ 'some-model': { contextWindow: 200_000 }, other: { contextWindow: 1_000_000 } })],
      'claude-opus-5',
    );
    expect(out.window).toBe(1_000_000);
  });

  it('tracks occupancy mid-turn off consolidated assistant lines', () => {
    const out = foldContextUsage({}, [assistantEvent({ inputTokens: 120, cacheReadInputTokens: 80 })], '');
    expect(out.tokens).toBe(200);
  });

  it('ignores streaming snapshots, which carry no usage', () => {
    const prev = { tokens: 500, window: 1_000_000 };
    expect(foldContextUsage(prev, [assistantEvent()], 'claude-opus-5')).toBe(prev);
  });

  it('keeps a known window when a later result omits one', () => {
    const out = foldContextUsage(
      { tokens: 100, window: 1_000_000 },
      [assistantEvent({ inputTokens: 700 }), resultEvent({ 'claude-opus-5': { inputTokens: 700 } })],
      'claude-opus-5',
    );
    expect(out).toEqual({ tokens: 700, window: 1_000_000 });
  });

  it('never lets a result line move the token count on its own', () => {
    const prev = { tokens: 1000, window: 1_000_000 };
    const out = foldContextUsage(
      prev,
      [resultEvent({ 'claude-opus-5[1m]': { cacheReadInputTokens: 8_300_000, contextWindow: 1_000_000 } })],
      'claude-opus-5',
    );
    expect(out).toBe(prev);
  });

  it('returns the same object when nothing moved, so selectors do not churn', () => {
    const prev = { tokens: 42, window: 1000 };
    expect(foldContextUsage(prev, [evt('noise')], 'claude-opus-5')).toBe(prev);
    expect(foldContextUsage(prev, [], 'claude-opus-5')).toBe(prev);
  });

  it('reports occupancy with no window when the backend never sends one', () => {
    const out = foldContextUsage({}, [assistantEvent({ inputTokens: 300 })], 'llama3');
    expect(out).toEqual({ tokens: 300, window: undefined });
  });
});

describe('foldContextUsage — subagent isolation', () => {
  it('ignores subagent events, which run their own window', () => {
    const sub: StreamEvent = {
      id: 's',
      timestamp: 0,
      raw: '',
      revision: 0,
      parentToolUseId: 'toolu_parent',
      kind: {
        type: 'assistant',
        info: {
          model: 'claude-haiku-4-5',
          text: 'sub',
          toolUses: [],
          thinking: [],
          usage: {
            inputTokens: 900_000,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      },
    };
    const prev = { tokens: 1200, window: 1_000_000 };
    expect(foldContextUsage(prev, [sub], 'claude-opus-5')).toBe(prev);
  });
});
