import { describe, expect, it } from 'vitest';

import { pausedStepFailure } from './FlowRunPane';
import type { FlowRun } from '@shared/flows/schema';

function run(overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id: 'run-1',
    flowId: 'flow',
    flowSnapshot: { id: 'flow', name: 'Report', steps: [], participants: [] },
    projectPath: '/repo',
    userPrompt: 'Report on two boards',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'paused', nextStepId: 'product-context', reason: 'failure' },
    createdAt: 1,
    attempts: [],
    ...overrides,
  } as FlowRun;
}

function attempt(stepId: string, errorMessage?: string) {
  return {
    stepId,
    startedAt: 1,
    conversationId: 'c1',
    outcome: errorMessage ? ('error' as const) : ('success' as const),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

describe('pausedStepFailure', () => {
  it('surfaces the runtime\'s recorded reason for the paused step', () => {
    const message = 'Step "product-context" produced no <output name="product_context.md"> block.';
    const r = run({
      attempts: [attempt('board-a-sprint'), attempt('product-context', message)],
    });

    expect(pausedStepFailure(r)).toBe(message);
  });

  it('ignores failures belonging to other steps', () => {
    const r = run({
      attempts: [attempt('trend-history', 'trend-history blew up'), attempt('product-context')],
    });

    expect(pausedStepFailure(r)).toBeUndefined();
  });

  it('takes the latest attempt, since on_fail.goto can re-run a step', () => {
    const r = run({
      attempts: [
        attempt('product-context', 'first failure'),
        attempt('product-context', 'second failure'),
      ],
    });

    expect(pausedStepFailure(r)).toBe('second failure');
  });

  it('stays silent for pauses that are not failures', () => {
    const r = run({
      state: { kind: 'paused', nextStepId: 'product-context', reason: 'preStep' },
      attempts: [attempt('product-context', 'stale error from an earlier run')],
    });

    expect(pausedStepFailure(r)).toBeUndefined();
  });

  it('stays silent when the run is not paused at all', () => {
    const r = run({ state: { kind: 'done', success: true }, attempts: [] });

    expect(pausedStepFailure(r)).toBeUndefined();
  });

  it('falls back to undefined when the failure carries no message', () => {
    const r = run({ attempts: [attempt('product-context')] });

    expect(pausedStepFailure(r)).toBeUndefined();
  });
});
