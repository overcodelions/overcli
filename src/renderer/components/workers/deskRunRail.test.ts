import { describe, expect, it } from 'vitest';

import type { FlowRun } from '@shared/flows/schema';

import {
  isBlockedRun,
  isRecentlyFinished,
  pauseReasonLabel,
  railRuns,
  railStepPosition,
  runStepPosition,
} from './deskRunRail';

const NOW = new Date('2026-09-04T12:00:00').getTime();
const MINUTES = 60_000;

const finished = (id: string, endedAt: number, success = true) =>
  run(id, {
    createdAt: endedAt - 1000,
    state: { kind: 'done', success },
    attempts: [{ stepId: 'ship', startedAt: endedAt - 1000, conversationId: 'c', endedAt }],
  });

function run(id: string, overrides: Record<string, unknown> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: {
      id: 'flow',
      name: 'Fix and ship',
      steps: [
        { id: 'plan', participantId: 'p', role: 'planner', inputs: [], tools: [] },
        { id: 'implement', participantId: 'p', role: 'implementer', inputs: [], tools: [] },
        { id: 'ship', participantId: 'p', role: 'implementer', inputs: [], tools: [] },
      ],
      participants: [],
    },
    projectPath: '/workspace',
    userPrompt: 'Fix the flaky spec',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'running', currentStepId: 'implement' },
    createdAt: 1,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

const paused = (id: string, at: number, reason = 'externalAction', nextStepId = 'ship') =>
  run(id, { createdAt: at, state: { kind: 'paused', nextStepId, reason } });

describe('railRuns', () => {
  it('draws blocked runs whether or not the worker is open', () => {
    const runs = [paused('a', 2), run('b', { createdAt: 3 }), finished('c', NOW - 5 * MINUTES)];
    expect(railRuns(runs, false, NOW).map((r) => r.id)).toEqual(['a']);
  });

  it('adds what is running and what just landed once the worker is open', () => {
    const runs = [run('b', { createdAt: 3 }), finished('c', NOW - 5 * MINUTES), paused('a', 2)];
    // Blocked first whatever the clock says — the cut at `max` has to fall on
    // the row with the weakest claim, never on the one holding a decision.
    expect(railRuns(runs, true, NOW).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a finished run once it is more than an hour old', () => {
    const runs = [finished('fresh', NOW - 59 * MINUTES), finished('stale', NOW - 61 * MINUTES)];
    expect(railRuns(runs, true, NOW).map((r) => r.id)).toEqual(['fresh']);
  });

  it('keeps a stopped run visible for the same hour', () => {
    // A job that failed while you were in another app is exactly the one you
    // want to find on your way back.
    expect(isRecentlyFinished(finished('x', NOW - 10 * MINUTES, false), NOW)).toBe(true);
    expect(isRecentlyFinished(run('running'), NOW)).toBe(false);
  });

  it('never draws a watched run, or anything that finished long ago', () => {
    // `watching` has a tail of its own and is not over; an old run is the
    // desk's business, not the roster's.
    const runs = [
      finished('old', NOW - 5 * 60 * MINUTES),
      run('watching', {
        state: { kind: 'watching', watch: { escalated: false } },
        attempts: [{ stepId: 'ship', startedAt: NOW, conversationId: 'c', endedAt: NOW }],
      }),
    ];
    expect(railRuns(runs, true, NOW)).toEqual([]);
  });

  it('caps the rail so one stalled worker cannot push the roster off screen', () => {
    const runs = [1, 2, 3, 4, 5].map((n) => paused(`p${n}`, n));
    expect(railRuns(runs, false, NOW).map((r) => r.id)).toEqual(['p5', 'p4', 'p3']);
  });

  it('agrees with the amber dot: only `paused` counts as blocked', () => {
    expect(isBlockedRun(paused('a', 1))).toBe(true);
    expect(isBlockedRun(run('b'))).toBe(false);
  });
});

describe('runStepPosition', () => {
  it('reports the running step', () => {
    expect(runStepPosition(run('a'))).toEqual({
      step: 'implement',
      index: 1,
      position: 2,
      total: 3,
    });
  });

  it('reports the step a paused run is waiting at', () => {
    expect(runStepPosition(paused('a', 1))).toMatchObject({ step: 'ship', position: 3, total: 3 });
  });

  it('falls back to the first step when the snapshot has no such step', () => {
    // An edited flow can rename a step out from under a live run; "step 0"
    // would be worse than naming the beginning.
    expect(runStepPosition(paused('a', 1, 'failure', 'gone'))).toMatchObject({
      step: 'plan',
      position: 1,
    });
  });

  it('is null for a flow with no steps', () => {
    expect(runStepPosition(run('a', { flowSnapshot: { id: 'f', name: 'n', steps: [], participants: [] } }))).toBeNull();
  });
});

describe('pauseReasonLabel', () => {
  it('says what the run is waiting for', () => {
    expect(pauseReasonLabel(paused('a', 1, 'needsInput'))).toBe('needs an answer');
    expect(pauseReasonLabel(paused('a', 1, 'riskyStep'))).toBe('needs approval');
    expect(pauseReasonLabel(paused('a', 1, 'failure'))).toBe('a step failed');
  });

  it('is null for a run that is not paused', () => {
    expect(pauseReasonLabel(run('a'))).toBeNull();
  });
});

describe('railStepPosition', () => {
  it('names the live step of a running or paused run', () => {
    expect(railStepPosition(run('a'))).toMatchObject({ step: 'implement' });
    expect(railStepPosition(paused('b', 1))).toMatchObject({ step: 'ship' });
  });

  it('is null for a finished run', () => {
    // `runStepPosition` falls back to the first step, and "plan 1/3" under a
    // finished run claims it is there now rather than that it got there.
    const done = run('c', { state: { kind: 'done', success: true } });
    expect(runStepPosition(done)).toMatchObject({ step: 'plan' });
    expect(railStepPosition(done)).toBeNull();
  });
});
