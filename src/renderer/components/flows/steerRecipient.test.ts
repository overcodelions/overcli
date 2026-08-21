// Which step a held correction is aimed at. Pure and load-bearing: it decides
// whether the Hold button is offered at all, and names the step in the button,
// the queued strip, and the pipeline marker.

import { describe, expect, it } from 'vitest';
import { steerRecipient } from './steerRecipient';
import type { FlowRun, FlowStep } from '@shared/flows/schema';

const STEPS: FlowStep[] = [
  { id: 'plan', participantId: 'p1', role: 'planner', inputs: [], tools: [], output: 'plan.md' },
  { id: 'refactor', participantId: 'p2', role: 'implementer', inputs: [], tools: [], output: 'diff' },
  { id: 'verify', participantId: 'p3', role: 'reviewer', inputs: [], tools: [], output: 'verify.md' },
];

function run(state: FlowRun['state']): FlowRun {
  return { flowSnapshot: { steps: STEPS }, state } as unknown as FlowRun;
}

describe('steerRecipient', () => {
  it('aims at the step after the one running', () => {
    expect(steerRecipient(run({ kind: 'running', currentStepId: 'plan' }))?.id).toBe('refactor');
    expect(steerRecipient(run({ kind: 'running', currentStepId: 'refactor' }))?.id).toBe('verify');
  });

  it('aims at the pending step while paused — including the step being re-run', () => {
    // The common case: parked before the next step.
    expect(
      steerRecipient(run({ kind: 'paused', nextStepId: 'verify', reason: 'preStep' }))?.id,
    ).toBe('verify');
    // A failure pause points back at the step that failed, and correcting
    // THAT step before it re-runs is the whole reason to allow steering here.
    expect(
      steerRecipient(run({ kind: 'paused', nextStepId: 'plan', reason: 'failure' }))?.id,
    ).toBe('plan');
  });

  it('has no target on the final step — nothing left to carry a correction', () => {
    expect(steerRecipient(run({ kind: 'running', currentStepId: 'verify' }))).toBeNull();
  });

  it('has no target on a finished run', () => {
    expect(steerRecipient(run({ kind: 'done', success: true }))).toBeNull();
    expect(steerRecipient(run({ kind: 'aborted' }))).toBeNull();
  });

  it('has no target when the current step is not in the snapshot', () => {
    expect(steerRecipient(run({ kind: 'running', currentStepId: 'ghost' }))).toBeNull();
    expect(
      steerRecipient(run({ kind: 'paused', nextStepId: 'ghost', reason: 'preStep' })),
    ).toBeNull();
  });
});
