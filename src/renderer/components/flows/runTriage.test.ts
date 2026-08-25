import { describe, expect, it } from 'vitest';

import {
  STALL_AFTER_MS,
  flowsLandingSegment,
  runAttentionBadge,
  triageRunCounts,
} from './runTriage';
import type { FlowRun } from '@shared/flows/schema';

const NOW = 1_000 * 60 * 60 * 24 * 400;

function run(id: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Maintenance', steps: [], participants: [] },
    projectPath: '/repo',
    userPrompt: 'Fix the flaky spec',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done' },
    createdAt: NOW,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

const paused = (id: string, activityAt: number): FlowRun =>
  run(id, { state: { kind: 'paused' }, createdAt: activityAt } as Partial<FlowRun>);

describe('triageRunCounts', () => {
  it('counts watching alongside running, and splits paused by staleness', () => {
    const runs = {
      a: run('a', { state: { kind: 'running' } } as Partial<FlowRun>),
      b: run('b', { state: { kind: 'watching' } } as Partial<FlowRun>),
      c: paused('c', NOW - 1_000),
      d: paused('d', NOW - STALL_AFTER_MS - 1),
      e: run('e'),
    };
    expect(triageRunCounts(runs, NOW)).toEqual({ running: 2, needsYou: 1, stalled: 1 });
  });

  it('treats a run paused exactly at the stall boundary as still needing you', () => {
    const runs = { c: paused('c', NOW - STALL_AFTER_MS) };
    expect(triageRunCounts(runs, NOW)).toMatchObject({ needsYou: 1, stalled: 0 });
  });
});

describe('runAttentionBadge', () => {
  it('ranks blocked-on-you above merely-working', () => {
    const runs = {
      a: run('a', { state: { kind: 'running' } } as Partial<FlowRun>),
      c: paused('c', NOW),
    };
    expect(runAttentionBadge(runs, NOW)).toEqual({ count: 1, tone: 'waiting' });
  });

  it('falls back to the running count when nothing is blocked', () => {
    const runs = {
      a: run('a', { state: { kind: 'running' } } as Partial<FlowRun>),
      b: run('b', { state: { kind: 'watching' } } as Partial<FlowRun>),
    };
    expect(runAttentionBadge(runs, NOW)).toEqual({ count: 2, tone: 'running' });
  });

  it('is absent for finished runs, and for stalled ones you cannot clear', () => {
    expect(runAttentionBadge({ e: run('e') }, NOW)).toBeUndefined();
    expect(runAttentionBadge({ d: paused('d', NOW - STALL_AFTER_MS - 1) }, NOW)).toBeUndefined();
    expect(runAttentionBadge({}, NOW)).toBeUndefined();
  });
});

describe('flowsLandingSegment', () => {
  const live = { a: run('a', { state: { kind: 'running' } } as Partial<FlowRun>) };

  it('opens on Runs when the first visit of the session has something live', () => {
    expect(flowsLandingSegment(live, true, NOW)).toBe('runs');
  });

  it('opens on the library when the first visit has nothing to show', () => {
    expect(flowsLandingSegment({}, true, NOW)).toBe('flows');
    expect(flowsLandingSegment({ e: run('e') }, true, NOW)).toBe('flows');
  });

  it('is unconditional after the first visit, however busy the runs are', () => {
    // The whole point: a later click must not land somewhere different based
    // on state the user cannot see from the tab they clicked.
    expect(flowsLandingSegment(live, false, NOW)).toBe('flows');
  });

  it('does not land on Runs for stalled runs alone', () => {
    const stale = { d: paused('d', NOW - STALL_AFTER_MS - 1) };
    expect(flowsLandingSegment(stale, true, NOW)).toBe('flows');
  });
});
